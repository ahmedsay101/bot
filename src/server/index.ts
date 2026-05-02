import express, { type Express } from 'express';
import http from 'node:http';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { env } from '../core/env.js';
import { scoped } from '../utils/logger.js';
import { buildRouter, type RouterDeps } from './routes.js';
import { attachWsGateway } from './ws.js';

const log = scoped('HTTP');

export function createServer(deps: RouterDeps): { app: Express; server: http.Server; listen: () => Promise<void>; stop: () => Promise<void> } {
  const app = express();
  // We sit behind exactly one reverse proxy (nginx). Trust the first hop so
  // X-Forwarded-For is honored for rate-limit keying / req.ip.
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(
    cors({
      origin: env.DASHBOARD_ORIGIN,
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '256kb' }));
  app.use(rateLimit({ windowMs: 60_000, limit: 600 }));

  app.get('/healthz', (_req, res) => res.json({ ok: true, mode: env.MODE }));
  app.use('/api', buildRouter(deps));

  const server = http.createServer(app);
  attachWsGateway(server);

  return {
    app,
    server,
    listen: () =>
      new Promise<void>((resolve) => {
        server.listen(env.API_PORT, env.API_HOST, () => {
          log.info({ port: env.API_PORT, host: env.API_HOST }, 'http listening');
          resolve();
        });
      }),
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
