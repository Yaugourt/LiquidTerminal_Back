import { cleanupOldFiles } from '../middleware/upload.middleware';
import { logDeduplicator } from './logDeduplicator';

/**
 * Service de nettoyage automatique des fichiers uploadés
 */
export class FileCleanupService {
  private static instance: FileCleanupService;
  private cleanupInterval: NodeJS.Timeout | null = null;

  private constructor() {}

  public static getInstance(): FileCleanupService {
    if (!FileCleanupService.instance) {
      FileCleanupService.instance = new FileCleanupService();
    }
    return FileCleanupService.instance;
  }

  /**
   * Démarrer le nettoyage automatique
   * @param intervalMs Intervalle en millisecondes (défaut: 24h)
   * @param maxAgeMs Âge maximum des fichiers en millisecondes (défaut: 7 jours)
   */
  public startAutoCleanup(intervalMs: number = 24 * 60 * 60 * 1000, maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): void {
    if (this.cleanupInterval) {
      this.stopAutoCleanup();
    }

    logDeduplicator.info('Starting automatic file cleanup', { 
      interval: `${intervalMs / (1000 * 60 * 60)}h`,
      maxAge: `${maxAgeMs / (1000 * 60 * 60 * 24)} days`
    });

    // Nettoyer immédiatement au démarrage
    this.performCleanup(maxAgeMs);

    // Puis programmer le nettoyage périodique
    this.cleanupInterval = setInterval(() => {
      this.performCleanup(maxAgeMs);
    }, intervalMs);
  }

  /**
   * Arrêter le nettoyage automatique
   */
  public stopAutoCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
      logDeduplicator.info('Stopped automatic file cleanup');
    }
  }

  /**
   * Effectuer un nettoyage manuel
   * @param maxAgeMs Âge maximum des fichiers
   */
  public async performCleanup(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): Promise<void> {
    try {
      logDeduplicator.info('Starting manual file cleanup', { maxAge: `${maxAgeMs / (1000 * 60 * 60 * 24)} days` });
      await cleanupOldFiles(maxAgeMs);
      logDeduplicator.info('File cleanup completed successfully');
    } catch (error) {
      logDeduplicator.error('Error during file cleanup', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * Obtenir les statistiques des fichiers uploadés
   */
  public getUploadStats(): { totalFiles: number; totalSize: number; oldestFile?: Date; newestFile?: Date } {
    try {
      const fs = require('fs');
      const path = require('path');
      
      const uploadDir = 'uploads/logos/';
      if (!fs.existsSync(uploadDir)) {
        return { totalFiles: 0, totalSize: 0 };
      }

      const files = fs.readdirSync(uploadDir);
      let totalSize = 0;
      let oldestFile: Date | undefined;
      let newestFile: Date | undefined;

      for (const file of files) {
        const filePath = path.join(uploadDir, file);
        const stats = fs.statSync(filePath);
        
        totalSize += stats.size;
        
        if (!oldestFile || stats.mtime < oldestFile) {
          oldestFile = stats.mtime;
        }
        
        if (!newestFile || stats.mtime > newestFile) {
          newestFile = stats.mtime;
        }
      }

      return {
        totalFiles: files.length,
        totalSize,
        oldestFile,
        newestFile
      };
    } catch (error) {
      logDeduplicator.error('Error getting upload stats', { error: error instanceof Error ? error.message : String(error) });
      return { totalFiles: 0, totalSize: 0 };
    }
  }
} 