import { Redis } from 'ioredis';
import { env } from '../core/env.js';
import { scoped } from '../utils/logger.js';

const log = scoped('REDIS');

let pub: Redis | null = null;
let sub: Redis | null = null;

function makeClient(name: string): Redis {
  const c = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
  });
  c.on('connect', () => log.info({ name }, 'connected'));
  c.on('error', (err: Error) => log.error({ name, err: err.message }, 'error'));
  c.on('close', () => log.warn({ name }, 'closed'));
  return c;
}

export function getPub(): Redis {
  if (!pub) pub = makeClient('pub');
  return pub;
}

export function getSub(): Redis {
  if (!sub) sub = makeClient('sub');
  return sub;
}

export async function publish(channel: string, payload: unknown): Promise<void> {
  await getPub().publish(channel, JSON.stringify(payload));
}

export async function subscribe(
  channel: string,
  handler: (msg: unknown) => void,
): Promise<() => void> {
  const s = getSub();
  await s.subscribe(channel);
  const listener = (ch: string, msg: string): void => {
    if (ch !== channel) return;
    try {
      handler(JSON.parse(msg));
    } catch (e) {
      log.warn({ err: (e as Error).message, channel }, 'bad message');
    }
  };
  s.on('message', listener);
  return () => {
    s.off('message', listener);
    void s.unsubscribe(channel);
  };
}

export async function disconnectRedis(): Promise<void> {
  await Promise.all([pub?.quit(), sub?.quit()]);
  pub = null;
  sub = null;
}
