import { ErrorRequestHandler, NextFunction, Request, Response } from 'express';
import { logDeduplicator } from '../utils/logDeduplicator';

interface AppErrorLike extends Error {
  statusCode?: number;
  code?: string;
  type?: string;
  status?: number;
}

export const notFoundHandler = (req: Request, res: Response, _next: NextFunction): void => {
  res.status(404).json({
    success: false,
    message: 'Route not found',
    code: 'ROUTE_NOT_FOUND',
  });
};

export const errorHandler: ErrorRequestHandler = (error: AppErrorLike, req: Request, res: Response, _next: NextFunction) => {
  const isJsonSyntaxError = error instanceof SyntaxError && 'body' in error;
  const isCorsError = error.message === 'Not allowed by CORS';

  let statusCode = error.statusCode || error.status || 500;
  let code = error.code || 'INTERNAL_SERVER_ERROR';
  let message = error.message || 'Internal server error';

  if (isJsonSyntaxError) {
    statusCode = 400;
    code = 'INVALID_JSON';
    message = 'Invalid JSON payload';
  } else if (isCorsError) {
    statusCode = 403;
    code = 'CORS_BLOCKED';
    message = 'Origin not allowed';
  }

  void logDeduplicator.error('Unhandled request error', {
    requestId: req.requestId,
    method: req.method,
    path: req.originalUrl,
    statusCode,
    code,
    error: error.message,
    stack: error.stack,
  });

  res.status(statusCode).json({
    success: false,
    message: statusCode >= 500 && !isCorsError && !isJsonSyntaxError ? 'Internal server error' : message,
    code,
  });
};
