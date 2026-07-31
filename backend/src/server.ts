import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { config } from './config';
import { logger } from './modules/logger';
import { BinanceClient } from './modules/binance/client';
import { WebSocketManager } from './modules/websocket/manager';
import { LiveExecutionProvider } from './modules/execution/LiveExecutionProvider';
import { SimulationExecutionProvider } from './modules/execution/SimulationExecutionProvider';
import { TraderManager } from './modules/trader-manager/TraderManager';
import { StatisticsService } from './modules/statistics/StatisticsService';
import { EquityService } from './modules/calc/EquityService';
import { createApp } from './app';
import { scheduleRecurringJobs, closeQueues } from './modules/jobs/queues';
import { startWorkers, stopWorkers } from './modules/jobs/workers';
import type { OrderUpdate, PriceUpdate } from './types';

const log = logger.child({ context: 'Server' });

async function bootstrap(): Promise<void> {
  log.info(`Starting Futures Trading Bot in ${config.trading.mode} mode...`);

  const db = new PrismaClient({ log: config.node.env === 'development' ? ['warn', 'error'] : ['error'] });
  await db.$connect();
  log.info('Database connected');

  // Keep DB config aligned with runtime env so UI never shows "5 / 3"
  await db.configuration.upsert({
    where: { id: 'singleton' },
    update: {
      maxTraders: config.trading.maxTraders,
      leverage: config.trading.leverage,
      mode: config.trading.mode,
      hedgeDistance: config.trading.hedgeDistance,
      hedgeTpPercent: config.trading.hedgeTpPercent,
      hedgeSlPercent: config.trading.hedgeSlPercent,
      shortTpPercent: config.trading.shortTpPercent,
      feeRate: config.trading.feeRate,
      slippage: config.trading.slippage,
      refreshInterval: config.trading.refreshInterval,
      retryLimit: config.trading.retryLimit,
    },
    create: {
      id: 'singleton',
      maxTraders: config.trading.maxTraders,
      leverage: config.trading.leverage,
      mode: config.trading.mode,
      initialCapital: config.trading.initialCapital,
      positionSize: config.trading.positionSize,
      hedgeDistance: config.trading.hedgeDistance,
      hedgeTpPercent: config.trading.hedgeTpPercent,
      hedgeSlPercent: config.trading.hedgeSlPercent,
      shortTpPercent: config.trading.shortTpPercent,
      feeRate: config.trading.feeRate,
      slippage: config.trading.slippage,
      refreshInterval: config.trading.refreshInterval,
      retryLimit: config.trading.retryLimit,
    },
  });

  const binanceClient = new BinanceClient();
  await binanceClient.initialize();

  const wsManager = new WebSocketManager();

  const traderConfig = {
    maxTraders: config.trading.maxTraders,
    initialCapital: config.trading.initialCapital,
    positionSize: config.trading.positionSize,
    leverage: config.trading.leverage,
    marginMode: config.trading.marginMode as 'ISOLATED' | 'CROSSED',
    hedgeDistance: config.trading.hedgeDistance,
    hedgeTpPercent: config.trading.hedgeTpPercent,
    hedgeSlPercent: config.trading.hedgeSlPercent,
    shortTpPercent: config.trading.shortTpPercent,
    refreshInterval: config.trading.refreshInterval,
    retryLimit: config.trading.retryLimit,
    feeRate: config.trading.feeRate,
    slippage: config.trading.slippage,
    mode: config.trading.mode,
  };

  const equityService = new EquityService(db, binanceClient, config.trading.mode);

  let executionProvider: LiveExecutionProvider | SimulationExecutionProvider;
  let simProvider: SimulationExecutionProvider | null = null;

  if (config.trading.mode === 'LIVE') {
    executionProvider = new LiveExecutionProvider(binanceClient);
    log.warn('LIVE TRADING MODE ENABLED — real orders will be placed');
  } else {
    simProvider = new SimulationExecutionProvider(
      () => binanceClient.getExchangeInfo(),
      (symbol) => binanceClient.getMarkPrice(symbol),
    );
    wsManager.on('priceUpdate', (update: PriceUpdate) => {
      simProvider!.onPriceUpdate(update.symbol, update.price);
    });
    executionProvider = simProvider;
    log.info('Simulation mode enabled');
  }

  const statisticsService = new StatisticsService(db, equityService, config.trading.mode);

  const traderManager = new TraderManager(
    executionProvider,
    wsManager,
    binanceClient,
    traderConfig,
    db,
    config.trading.mode,
    equityService,
  );

  // Simulation fills share the same OrderUpdate path as Live user-data stream
  if (simProvider != null) {
    simProvider.on('orderUpdate', (update: OrderUpdate) => {
      void traderManager.handleOrderUpdate(update);
    });
  }

  const server = createApp(db, traderManager, statisticsService, binanceClient, wsManager);

  await scheduleRecurringJobs();
  startWorkers(statisticsService, traderManager);

  await traderManager.start();

  server.listen(config.node.port, () => {
    log.info(`Server listening on port ${config.node.port}`);
  });

  const shutdown = async (signal: string): Promise<void> => {
    log.info(`Received ${signal} — shutting down gracefully...`);

    server.close(async () => {
      try {
        await traderManager.stop();
        await stopWorkers();
        await closeQueues();
        await db.$disconnect();
        log.info('Shutdown complete');
        process.exit(0);
      } catch (err) {
        log.error('Error during shutdown', { error: String(err) });
        process.exit(1);
      }
    });

    setTimeout(() => {
      log.error('Forced shutdown after timeout');
      process.exit(1);
    }, 30000);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    log.error('Unhandled promise rejection', { reason: String(reason) });
  });

  process.on('uncaughtException', (err) => {
    log.error('Uncaught exception', { error: err.message, stack: err.stack });
    process.exit(1);
  });
}

bootstrap().catch((err: Error) => {
  logger.error('Fatal startup error', { error: err.message, stack: err.stack });
  process.exit(1);
});
