import { NextFunction, Request, Response } from 'express';
import { rawLogger } from '../utils/logger';

export const requestLoggingMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  const startTime = process.hrtime.bigint();
  let responseFinished = false;

  res.once('finish', () => {
    responseFinished = true;
    const durationMs = Number(process.hrtime.bigint() - startTime) / 1_000_000;
    const logLevel = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';

    void rawLogger[logLevel]('HTTP request completed', {
      requestId: req.requestId,
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      durationMs: Number(durationMs.toFixed(2)),
      ip: req.ip,
      userAgent: req.get('user-agent'),
      contentLength: res.getHeader('content-length') ?? null,
    });
  });

  res.once('close', () => {
    if (responseFinished) {
      return;
    }

    const durationMs = Number(process.hrtime.bigint() - startTime) / 1_000_000;
    void rawLogger.warn('HTTP request aborted', {
      requestId: req.requestId,
      method: req.method,
      path: req.originalUrl,
      durationMs: Number(durationMs.toFixed(2)),
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
  });

  next();
};
