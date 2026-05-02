import { connectDb, disconnectDb } from './services/db.service.js';
import { ensureAdminUser } from './services/auth.service.js';
import { loadSettings, startSettingsWatcher, stopSettingsWatcher } from './services/settings.service.js';
import { MarketDataService } from './services/marketData.service.js';
import { SymbolScannerService } from './services/symbolScanner.service.js';
import { PortfolioService } from './services/portfolio.service.js';
import { RiskManager } from './services/riskManager.service.js';
import { SetupService } from './services/setup.service.js';
import { Orchestrator } from './services/orchestrator.service.js';
import { createExecutionService } from './services/execution/index.js';
import { createServer } from './server/index.js';
import { startBacktestWorker } from './services/backtest.service.js';
import { disconnectRedis } from './services/redis.service.js';
import { scoped, logger } from './utils/logger.js';
import { env } from './core/env.js';

const log = scoped('APP');

async function main(): Promise<void> {
  log.info({ mode: env.MODE }, 'booting');

  await connectDb();
  await ensureAdminUser();
  await loadSettings();
  startSettingsWatcher();

  const market = new MarketDataService();
  await market.start();

  const setups = new SetupService();
  const scanner = new SymbolScannerService(market, setups);
  const portfolio = new PortfolioService();
  const risk = new RiskManager();
  const execution = createExecutionService(market);
  await execution.start();

  const orchestrator = new Orchestrator(market, scanner, risk, portfolio, execution, setups);

  const http = createServer({ orchestrator, execution, market });
  await http.listen();

  const backtestWorker = startBacktestWorker(market);

  // Run orchestrator loop
  const loopPromise = orchestrator.run().catch((e) => log.error({ err: (e as Error).message }, 'orchestrator crashed'));

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (sig: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.warn({ sig }, 'shutdown requested');
    orchestrator.shutdown();
    await loopPromise;
    await execution.stop();
    await market.stop();
    await http.stop();
    await backtestWorker.close();
    await stopSettingsWatcher();
    await disconnectRedis();
    await disconnectDb();
    log.info('bye');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => log.error({ err }, 'unhandledRejection'));
  process.on('uncaughtException', (err) => {
    log.fatal({ err: err.message, stack: err.stack }, 'uncaughtException');
    void shutdown('uncaughtException');
  });
}

main().catch((e) => {
  logger.fatal({ err: (e as Error).message, stack: (e as Error).stack }, 'fatal boot error');
  process.exit(1);
});
