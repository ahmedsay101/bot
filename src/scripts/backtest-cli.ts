/* eslint-disable no-console */
import { connectDb, disconnectDb } from '../services/db.service.js';
import { MarketDataService } from '../services/marketData.service.js';
import { BacktestModel } from '../models/index.js';
import { runBacktest } from '../services/backtest.service.js';
import { disconnectRedis } from '../services/redis.service.js';

async function main(): Promise<void> {
  const [, , symbol, fromStr, toStr, intervalArg = '1m'] = process.argv;
  if (!symbol || !fromStr || !toStr) {
    console.error('Usage: npm run backtest -- <SYMBOL> <FROM_ISO> <TO_ISO> [interval=1m]');
    process.exit(1);
  }
  const fromTs = Date.parse(fromStr);
  const toTs = Date.parse(toStr);
  if (!fromTs || !toTs) {
    console.error('Bad dates');
    process.exit(1);
  }

  await connectDb();
  const market = new MarketDataService();
  await market.refreshExchangeInfo();

  const doc = await BacktestModel.create({
    status: 'queued',
    symbol,
    interval: intervalArg,
    fromTs,
    toTs,
    startingBalance: 600,
  });

  console.log(`Backtest ${doc._id} starting…`);
  await runBacktest(String(doc._id), market);
  const result = await BacktestModel.findById(doc._id).lean();
  console.log(JSON.stringify({ status: result?.status, metrics: result?.metrics }, null, 2));

  await disconnectRedis();
  await disconnectDb();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
