import 'express-async-errors';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import type { PrismaClient } from '@prisma/client';
import { createTradersRouter } from './api/routes/traders';
import { createOrdersRouter } from './api/routes/orders';
import { createPositionsRouter, createTradesRouter } from './api/routes/positions';
import { createStatisticsRouter } from './api/routes/statistics';
import { createSystemRouter } from './api/routes/system';
import { createConfigRouter } from './api/routes/config';
import { errorHandler, notFoundHandler } from './api/middleware/error';
import type { TraderManager } from './modules/trader-manager/TraderManager';
import type { StatisticsService } from './modules/statistics/StatisticsService';
import type { BinanceClient } from './modules/binance/client';
import type { WebSocketManager } from './modules/websocket/manager';
import { createContextLogger } from './modules/logger';

const log = createContextLogger('App');

export function createApp(
  db: PrismaClient,
  traderManager: TraderManager,
  statisticsService: StatisticsService,
  binanceClient: BinanceClient,
  wsManager: WebSocketManager,
): ReturnType<typeof createServer> {
  const app = express();

  // Security middlewares
  app.use(helmet());
  app.use(cors({ origin: process.env.CORS_ORIGIN ?? 'http://localhost:3000', credentials: true }));
  app.use(rateLimit({ windowMs: 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false }));

  // Parsing + logging
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(morgan('combined', { stream: { write: (msg) => log.http(msg.trim()) } }));

  // Routes
  app.use('/api/traders', createTradersRouter(traderManager, db));
  app.use('/api/orders', createOrdersRouter(db));
  app.use('/api/positions', createPositionsRouter(db));
  app.use('/api/trades', createTradesRouter(db));
  app.use('/api/statistics', createStatisticsRouter(statisticsService, traderManager));
  app.use('/api/system', createSystemRouter(db, binanceClient, wsManager));
  app.use('/api/config', createConfigRouter(db));

  // Error handling
  app.use(notFoundHandler);
  app.use(errorHandler);

  // HTTP server + WebSocket dashboard
  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    log.debug('Dashboard WebSocket connected');

    // Push trader updates to connected dashboard clients
    const pushUpdate = (event: unknown): void => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(event));
      }
    };

    traderManager.on('traderEvent', pushUpdate);

    ws.on('close', () => {
      traderManager.off('traderEvent', pushUpdate);
      log.debug('Dashboard WebSocket disconnected');
    });

    ws.on('error', (err) => log.error('Dashboard WS error', { error: err.message }));
  });

  return server;
}
