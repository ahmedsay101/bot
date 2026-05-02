import mongoose from 'mongoose';
import { env } from '../core/env.js';
import { scoped } from '../utils/logger.js';
import { LogModel } from '../models/log.model.js';

const log = scoped('DB');

let connected = false;

export async function connectDb(): Promise<void> {
  if (connected) return;
  mongoose.set('strictQuery', true);
  await mongoose.connect(env.MONGO_URI, {
    serverSelectionTimeoutMS: 10_000,
  });
  connected = true;
  log.info({ uri: redact(env.MONGO_URI) }, 'connected');

  // Touch capped logs collection so index/cap is created.
  try {
    await LogModel.init();
  } catch (e) {
    log.warn({ err: (e as Error).message }, 'log collection init warn');
  }

  mongoose.connection.on('disconnected', () => {
    connected = false;
    log.warn('disconnected');
  });
  mongoose.connection.on('reconnected', () => {
    connected = true;
    log.info('reconnected');
  });
  mongoose.connection.on('error', (err) => log.error({ err: err.message }, 'connection error'));
}

export async function disconnectDb(): Promise<void> {
  if (!connected) return;
  await mongoose.disconnect();
  connected = false;
}

export function isDbConnected(): boolean {
  return connected && mongoose.connection.readyState === 1;
}

function redact(uri: string): string {
  return uri.replace(/\/\/([^:@]+):([^@]+)@/, '//$1:***@');
}
