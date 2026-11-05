// Bootstrap logger module — pino + file rotation + dedup.
// All `console.*` calls in this file are intentional: they are emitted by the
// logger's own bootstrap/rotation/fallback paths and cannot route back through
// `deduplicatedLogger` without creating a circular initialization or recursion.
// Callers everywhere else must import the default export (deduplicatedLogger).

import pino from 'pino';
import path from 'path';
import { mkdir, stat, rename, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { Writable } from 'stream';

interface LogEntry {
  message: string;
  level: string;
  /** Last occurrence: the entry expires one window after it. */
  timestamp: number;
  /** When a line was last written for it. */
  emittedAt: number;
  /** Occurrences the line being written stands for (1 = just this one). */
  count: number;
  /** Occurrences suppressed since the last line. */
  pending: number;
  metadata: Record<string, any>;
}

interface LogRotationConfig {
  maxSize: number; // Taille maximale en bytes (10MB par défaut)
  maxFiles: number; // Nombre maximum de fichiers de backup (5 par défaut)
  compress: boolean; // Compresser les anciens fichiers
}

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

class LogRotator {
  private config: LogRotationConfig;
  private currentSize: number = 0;

  constructor(config: Partial<LogRotationConfig> = {}) {
    this.config = {
      maxSize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5,
      compress: true,
      ...config
    };
  }

  async shouldRotate(filePath: string): Promise<boolean> {
    try {
      if (!existsSync(filePath)) {
        return false;
      }
      const stats = await stat(filePath);
      return stats.size >= this.config.maxSize;
    } catch (error) {
      console.error('Error checking file size for rotation:', error);
      return false;
    }
  }

  /**
   * @param onRenamed Appelé juste après le renommage, avant le ménage des
   *        anciens backups : c'est là que le flux d'écriture doit être rouvert
   *        sur `filePath`.
   */
  async rotateFile(filePath: string, onRenamed?: () => void): Promise<void> {
    try {
      if (!existsSync(filePath)) {
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const dir = path.dirname(filePath);
      const ext = path.extname(filePath);
      const base = path.basename(filePath, ext);

      // Créer le nom du fichier de backup
      const backupPath = path.join(dir, `${base}-${timestamp}${ext}`);

      // Renommer le fichier actuel
      await rename(filePath, backupPath);
      onRenamed?.();

      // Supprimer les anciens fichiers si on dépasse maxFiles
      await this.cleanupOldFiles(dir, base, ext);

      console.log(`Log file rotated: ${filePath} -> ${backupPath}`);
    } catch (error) {
      console.error('Error rotating log file:', error);
    }
  }

  private async cleanupOldFiles(dir: string, base: string, ext: string): Promise<void> {
    try {
      const files = await mkdir(dir, { recursive: true }).then(() => 
        import('fs/promises').then(fs => fs.readdir(dir))
      );

      const logFiles = files
        .filter(file => file.startsWith(base) && file.endsWith(ext) && file !== `${base}${ext}`)
        .map(file => ({
          name: file,
          path: path.join(dir, file),
          time: 0
        }));

      // Récupérer les timestamps des fichiers
      for (const file of logFiles) {
        try {
          const stats = await stat(file.path);
          file.time = stats.mtime.getTime();
        } catch (error) {
          console.error(`Error getting stats for ${file.path}:`, error);
        }
      }

      // Trier par date (plus ancien en premier)
      logFiles.sort((a, b) => a.time - b.time);

      // Supprimer les fichiers en trop
      while (logFiles.length >= this.config.maxFiles) {
        const oldestFile = logFiles.shift();
        if (oldestFile) {
          try {
            await unlink(oldestFile.path);
            console.log(`Deleted old log file: ${oldestFile.name}`);
          } catch (error) {
            console.error(`Error deleting old log file ${oldestFile.name}:`, error);
          }
        }
      }
    } catch (error) {
      console.error('Error cleaning up old log files:', error);
    }
  }
}

export class LogDeduplicatorInternal {
  private static instance: LogDeduplicatorInternal;
  private logMap: Map<string, LogEntry> = new Map();
  private readonly deduplicationWindow: number = 60000;
  private readonly maxLogs: number = 1000;
  private cleanupInterval: NodeJS.Timeout | null = null;

  private constructor() {
    this.cleanupInterval = setInterval(() => this.cleanupOldEntries(), this.deduplicationWindow);
    this.cleanupInterval.unref();
  }

  public static getInstance(): LogDeduplicatorInternal {
    if (!LogDeduplicatorInternal.instance) {
      LogDeduplicatorInternal.instance = new LogDeduplicatorInternal();
    }
    return LogDeduplicatorInternal.instance;
  }

  // `logMap` is kept ordered by last occurrence (processLog re-inserts on every
  // hit), so the oldest entries are always first: expiry and eviction stop at
  // the first live entry instead of scanning / sorting the whole map.
  private cleanupOldEntries(): void {
    const now = Date.now();
    for (const [key, log] of this.logMap) {
      if (now - log.timestamp <= this.deduplicationWindow) break;
      this.logMap.delete(key);
    }
  }

  public cleanup(): void {
    for (const key of this.logMap.keys()) {
      if (this.logMap.size <= this.maxLogs) break;
      this.logMap.delete(key);
    }
  }

  public shutdown(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  public processLog(level: string, message: string, metadata: Record<string, any> = {}): LogEntry | null {
    const key = `${level}:${message}`;
    const now = Date.now();
    const existingLog = this.logMap.get(key);

    if (existingLog && (now - existingLog.timestamp < this.deduplicationWindow)) {
      existingLog.timestamp = now;
      this.logMap.delete(key);
      this.logMap.set(key, existingLog);

      // A warning or error that keeps recurring is written again once per
      // window, with the number of occurrences the line stands for — suppressing
      // it for as long as it recurred hid every failure after the first one.
      if ((level === 'warn' || level === 'error') && now - existingLog.emittedAt >= this.deduplicationWindow) {
        existingLog.count = existingLog.pending + 1;
        existingLog.pending = 0;
        existingLog.emittedAt = now;
        existingLog.metadata = metadata;
        return { ...existingLog };
      }
      existingLog.pending++;
      return null;
    }

    const newLog: LogEntry = { message, level, timestamp: now, emittedAt: now, count: 1, pending: 0, metadata };
    this.logMap.delete(key);
    this.logMap.set(key, newLog);
    if (this.logMap.size > this.maxLogs) {
      this.cleanup();
    }
    return { ...newLog };
  }
}

const baseConfig = {
  base: { service: 'liquidterminal-api' },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (label: string) => ({ level: label }) },
  // Central redaction backstop. Even when a call site forgets, these keys are
  // scrubbed before anything is written — Railway logs are readable by anyone
  // with dashboard access, and the log shape is public. Deliberately narrow:
  // `code`/`address` are NOT here (error codes and on-chain addresses are not
  // secrets and redacting them would gut debuggability); the telegram link
  // `code` and the JWT `payload` are additionally handled at their call sites.
  redact: {
    paths: [
      'email', '*.email',
      'password', '*.password',
      'token', '*.token', 'accessToken', 'refreshToken',
      'authorization', '*.authorization',
      'payload', '*.payload',
      'privyUserId', '*.privyUserId',
      'body',
    ],
    censor: '[REDACTED]',
  },
};

let infoWarnLogger: pino.Logger;
let errorDebugLogger: pino.Logger;

let iwFileStream: pino.DestinationStream;
let edFileStream: pino.DestinationStream;

const logsDir = path.join(__dirname, '../../logs');
const combinedLogPath = path.join(logsDir, 'combined.log');
const errorLogPath = path.join(logsDir, 'error.log');

// Configuration de rotation des logs
const logRotator = new LogRotator({
  maxSize: 10 * 1024 * 1024, // 10MB
  maxFiles: 5,
  compress: false // Pas de compression pour l'instant
});

type FileDestination = ReturnType<typeof pino.destination>;

// Classe pour gérer les streams avec rotation
class RotatingFileStream {
  private filePath: string;
  private stream: FileDestination | null = null;
  private rotator: LogRotator;

  constructor(filePath: string, rotator: LogRotator) {
    this.filePath = filePath;
    this.rotator = rotator;
  }

  async getStream(): Promise<FileDestination> {
    if (!this.stream) {
      // Un fichier déjà plein au démarrage est archivé avant d'ouvrir le flux.
      if (await this.rotator.shouldRotate(this.filePath)) {
        await this.rotator.rotateFile(this.filePath);
      }
      await this.initializeStream();
    }

    return this.stream!;
  }

  private async initializeStream(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    this.stream = pino.destination(this.filePath);
  }

  /**
   * Rotation en place : le fichier est renommé, puis le SonicBoom que pino
   * tient dans son multistream est rouvert sur le même chemin (il ferme
   * lui-même l'ancien descripteur). En recréer un nouveau, comme avant, ne
   * changeait rien pour pino — qui continuait d'écrire dans le backup renommé,
   * jamais plus rotaté — et fuyait un descripteur à chaque rotation.
   */
  async rotate(): Promise<void> {
    const stream = this.stream;
    if (!stream) {
      return;
    }
    await this.rotator.rotateFile(this.filePath, () => stream.reopen());
  }

  async flush(): Promise<void> {
    try {
      this.stream?.flushSync();
    } catch (error) {
      console.error('Error flushing log file:', error);
    }
  }
}

// Créer les streams avec rotation
const combinedStream = new RotatingFileStream(combinedLogPath, logRotator);
const errorStream = new RotatingFileStream(errorLogPath, logRotator);

async function initializeLogger() {
  try {
    await mkdir(logsDir, { recursive: true });

    const prettyPrintOptions = {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname,service',
    };

    const consoleTransport = process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: prettyPrintOptions }
      : null;

    // Initialiser les streams avec rotation
    iwFileStream = await combinedStream.getStream();
    const iwPinoStreams: pino.StreamEntry[] = [{ level: 'info', stream: iwFileStream }];
    if (process.env.NODE_ENV === 'production') {
      iwPinoStreams.push({ level: 'info', stream: process.stdout });
    }
    if (consoleTransport) {
      iwPinoStreams.push({ level: 'info', stream: pino.transport(consoleTransport) as unknown as Writable });
    }
    infoWarnLogger = pino({ ...baseConfig, level: 'info' }, pino.multistream(iwPinoStreams));

    edFileStream = await errorStream.getStream();
    const edPinoStreams: pino.StreamEntry[] = [{ level: 'debug', stream: edFileStream }];
    if (process.env.NODE_ENV === 'production') {
      edPinoStreams.push({ level: 'error', stream: process.stderr });
    }
    if (consoleTransport) {
      edPinoStreams.push({ level: 'debug', stream: pino.transport(consoleTransport) as unknown as Writable });
    }
    errorDebugLogger = pino({ ...baseConfig, level: 'debug' }, pino.multistream(edPinoStreams));

    // Seul point de contrôle de la taille : écrire une ligne ne coûte plus un
    // existsSync + stat. Un fichier peut dépasser maxSize d'une minute de logs.
    const rotationTimer = setInterval(async () => {
      try {
        if (await logRotator.shouldRotate(combinedLogPath)) {
          await combinedStream.rotate();
        }
        if (await logRotator.shouldRotate(errorLogPath)) {
          await errorStream.rotate();
        }
      } catch (error) {
        console.error('Error during log rotation check:', error);
      }
    }, 60 * 1000);
    rotationTimer.unref();

  } catch (err) {
    // Production lands here: the image runs as `node` and cannot create
    // /app/logs. Keep the base config (the redaction backstop above included)
    // on the standard streams, which Railway keeps; without it, bodies, emails
    // and Privy ids reached the Railway logs in clear.
    console.error('Logger setup failed, logging to stdout/stderr only:', err instanceof Error ? err.message : err);
    const level = process.env.NODE_ENV === 'production' ? 'info' : 'debug';
    infoWarnLogger = pino({ ...baseConfig, level }, process.stdout);
    errorDebugLogger = pino({ ...baseConfig, level }, process.stderr);
  }
}

initializeLogger();

function getFallbackConsole(level: LogLevel): typeof console.info {
  switch (level) {
    case 'error':
      return console.error;
    case 'warn':
      return console.warn;
    case 'debug':
      return console.debug;
    default:
      return console.info;
  }
}

function getLogger(level: LogLevel): pino.Logger | undefined {
  return level === 'info' || level === 'warn' ? infoWarnLogger : errorDebugLogger;
}

async function writeLog(
  level: LogLevel,
  message: string,
  metadata: Record<string, any> = {},
  dedupe = true
): Promise<void> {
  const logger = getLogger(level);
  if (!logger) {
    getFallbackConsole(level)(message, metadata);
    return;
  }

  let finalMessage = message;
  let finalMetadata = metadata;

  if (dedupe) {
    const deduplicator = LogDeduplicatorInternal.getInstance();
    const processedLog = deduplicator.processLog(level, message, metadata);
    if (!processedLog) {
      return;
    }

    finalMessage = processedLog.count > 1 ? `${message} (occurred ${processedLog.count} times)` : message;
    finalMetadata = processedLog.metadata;
  }

  logger[level](finalMetadata, finalMessage);
}

const deduplicatedLogger = {
  info: async (message: string, metadata: Record<string, any> = {}) => writeLog('info', message, metadata),
  error: async (message: string, metadata: Record<string, any> = {}) => writeLog('error', message, metadata),
  debug: async (message: string, metadata: Record<string, any> = {}) => writeLog('debug', message, metadata),
  warn: async (message: string, metadata: Record<string, any> = {}) => writeLog('warn', message, metadata),
};

export const rawLogger = {
  info: async (message: string, metadata: Record<string, any> = {}) => writeLog('info', message, metadata, false),
  error: async (message: string, metadata: Record<string, any> = {}) => writeLog('error', message, metadata, false),
  debug: async (message: string, metadata: Record<string, any> = {}) => writeLog('debug', message, metadata, false),
  warn: async (message: string, metadata: Record<string, any> = {}) => writeLog('warn', message, metadata, false),
};

export async function flushLogs(): Promise<void> {
  await combinedStream.flush();
  await errorStream.flush();
  LogDeduplicatorInternal.getInstance().shutdown();
}

export const measureExecutionTime = async <T>(
  operation: () => Promise<T>,
  operationName: string
): Promise<T> => {
  const start = Date.now();
  try {
    const result = await operation();
    const duration = Date.now() - start;
    await deduplicatedLogger.info(`Operation completed: ${operationName}`, { duration, operationName });
    return result;
  } catch (error) {
    const duration = Date.now() - start;
    await deduplicatedLogger.error(`Operation failed: ${operationName}`, {
      duration,
      operationName,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
};

export const stream = {
  write: async (message: string) => {
    await rawLogger.info(message.trim());
  },
};

export default deduplicatedLogger; 