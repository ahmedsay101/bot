import { Request, Response, NextFunction } from 'express';
import { createContextLogger } from '../../modules/logger';

const log = createContextLogger('ErrorMiddleware');

export interface ApiError extends Error {
  statusCode?: number;
  code?: number;
}

export function errorHandler(err: ApiError, _req: Request, res: Response, _next: NextFunction): void {
  const statusCode = err.statusCode ?? 500;
  const message = statusCode < 500 ? err.message : 'Internal server error';

  if (statusCode >= 500) {
    log.error('Unhandled error', {
      message: err.message,
      stack: err.stack,
      code: err.code,
    });
  } else {
    log.warn('Request error', { message: err.message, statusCode });
  }

  res.status(statusCode).json({
    success: false,
    error: message,
    ...(process.env.NODE_ENV !== 'production' && statusCode >= 500 ? { detail: err.message } : {}),
  });
}

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ success: false, error: 'Not found' });
}
