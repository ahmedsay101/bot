import winston from 'winston';
import path from 'path';
import fs from 'fs';
import { config } from '../../config';

const { combine, timestamp, errors, json, colorize, printf } = winston.format;

const logDir = config.logging.dir;
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const devFormat = combine(
  colorize({ all: true }),
  timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  errors({ stack: true }),
  printf(({ level, message, timestamp: ts, context, stack, ...meta }) => {
    const ctx = context ? `[${String(context)}] ` : '';
    const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
    const stackStr = stack ? `\n${String(stack)}` : '';
    return `${String(ts)} ${level}: ${ctx}${String(message)}${metaStr}${stackStr}`;
  }),
);

const prodFormat = combine(timestamp(), errors({ stack: true }), json());

export const logger = winston.createLogger({
  level: config.logging.level,
  format: config.node.env === 'production' ? prodFormat : devFormat,
  defaultMeta: { service: 'futures-bot' },
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({
      filename: path.join(logDir, 'error.log'),
      level: 'error',
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: path.join(logDir, 'combined.log'),
      maxsize: 20 * 1024 * 1024,
      maxFiles: 10,
    }),
  ],
  exitOnError: false,
});

export function createContextLogger(context: string): winston.Logger {
  return logger.child({ context });
}

export type Logger = winston.Logger;
