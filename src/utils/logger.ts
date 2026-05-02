import pino, { type LoggerOptions } from 'pino';
import { env } from '../core/env.js';

const opts: LoggerOptions = {
  level: env.LOG_LEVEL,
  base: { mode: env.MODE },
  timestamp: pino.stdTimeFunctions.isoTime,
};

export const logger = env.LOG_PRETTY
  ? pino({
      ...opts,
      transport: {
        target: 'pino-pretty',
        options: { translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname,mode' },
      },
    })
  : pino(opts);

export function scoped(scope: string): pino.Logger {
  return logger.child({ scope });
}
