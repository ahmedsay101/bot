import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from '../core/env.js';
import { CONFIG, applySettingsPatch, resetConfig } from '../core/config.js';
import { Side, OrderType, TradeReason } from '../core/constants.js';
import { evaluate } from './strategy.service.js';
import { RiskManager, computeLiquidationPrice } from './riskManager.service.js';
import { BacktestModel } from '../models/index.js';
import { MarketDataService, type Candle } from './marketData.service.js';
import { scoped } from '../utils/logger.js';

const log = scoped('BACKTEST');

const queueConn = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
export const backtestQueue = new Queue('backtest', { connection: queueConn });

interface SimPosition {
  symbol: string;
  side: Side;
  size: number;
  entryPrice: number;
  stopPrice: number;
  takeProfitPrice: number;
  liquidationPrice: number;
  openedAt: number;
}

interface SimTrade {
  symbol: string;
  side: Side;
  entryPrice: number;
  exitPrice: number;
  qty: number;
  pnl: number;
  fees: number;
  reason: string;
  openedAt: number;
  closedAt: number;
}

export async function runBacktest(jobId: string, market: MarketDataService): Promise<void> {
  const doc = await BacktestModel.findById(jobId);
  if (!doc) return;
  doc.status = 'running';
  doc.progress = 0;
  await doc.save();

  try {
    const cfg = CONFIG();
    if (doc.paramsPatch && Object.keys(doc.paramsPatch as object).length) {
      applySettingsPatch(doc.paramsPatch as Record<string, unknown>);
    }
    const interval = doc.interval;
    const candles = await market.fetchHistoricalKlines(doc.symbol, interval, doc.fromTs, doc.toTs);
    log.info({ symbol: doc.symbol, candles: candles.length }, 'historical fetched');
    if (candles.length < 100) throw new Error('not_enough_history');

    const risk = new RiskManager();
    const symbolInfo = market.getSymbolInfo(doc.symbol);

    let balance = doc.startingBalance;
    let feesPaid = 0;
    let position: SimPosition | null = null;
    const trades: SimTrade[] = [];
    const equityCurve: { ts: number; equity: number }[] = [];
    let peakEquity = balance;
    let maxDd = 0;

    const need = Math.max(cfg.indicators.maPeriod, cfg.indicators.atrPeriod, cfg.indicators.rsiPeriod) + 30;
    for (let i = need; i < candles.length; i++) {
      const window = candles.slice(0, i + 1);
      const c = candles[i] as Candle;

      // SL/TP/liquidation triggered intra-bar (use high/low conservatively)
      if (position) {
        const hit = checkExit(position, c);
        if (hit) {
          const fee = position.size * hit.price * cfg.simulator.takerFeeRate;
          const dir = position.side === Side.LONG ? 1 : -1;
          const pnl = (hit.price - position.entryPrice) * position.size * dir - fee;
          balance += pnl;
          feesPaid += fee;
          trades.push({
            symbol: position.symbol,
            side: position.side,
            entryPrice: position.entryPrice,
            exitPrice: hit.price,
            qty: position.size,
            pnl,
            fees: fee,
            reason: hit.reason,
            openedAt: position.openedAt,
            closedAt: c.closeTime,
          });
          position = null;
        }
      }

      const evalResult = evaluate({
        candles: window,
        hasOpenPosition: !!position,
        ...(position && { positionSide: position.side }),
      });

      if (evalResult.signal.kind === 'CLOSE' && position) {
        const fee = position.size * c.close * cfg.simulator.takerFeeRate;
        const dir = position.side === Side.LONG ? 1 : -1;
        const pnl = (c.close - position.entryPrice) * position.size * dir - fee;
        balance += pnl;
        feesPaid += fee;
        trades.push({
          symbol: position.symbol,
          side: position.side,
          entryPrice: position.entryPrice,
          exitPrice: c.close,
          qty: position.size,
          pnl,
          fees: fee,
          reason: evalResult.signal.reason,
          openedAt: position.openedAt,
          closedAt: c.closeTime,
        });
        position = null;
      } else if (evalResult.signal.kind === 'OPEN' && !position) {
        const sizing = risk.size({
          symbol: doc.symbol,
          side: evalResult.signal.side,
          entryPrice: evalResult.signal.price,
          atrValue: evalResult.signal.atr,
          marginAllocated: balance,
          symbolInfo,
        });
        if (sizing) {
          const entryFee = sizing.qty * c.close * cfg.simulator.takerFeeRate;
          balance -= entryFee;
          feesPaid += entryFee;
          position = {
            symbol: doc.symbol,
            side: evalResult.signal.side,
            size: sizing.qty,
            entryPrice: c.close,
            stopPrice: sizing.stopPrice,
            takeProfitPrice: sizing.takeProfitPrice,
            liquidationPrice: computeLiquidationPrice(evalResult.signal.side, c.close, cfg.trading.leverage),
            openedAt: c.closeTime,
          };
        }
      }

      // Track equity (mark-to-market)
      const equity = position
        ? balance + (c.close - position.entryPrice) * position.size * (position.side === Side.LONG ? 1 : -1)
        : balance;
      equityCurve.push({ ts: c.closeTime, equity });
      peakEquity = Math.max(peakEquity, equity);
      maxDd = Math.max(maxDd, peakEquity > 0 ? (peakEquity - equity) / peakEquity : 0);

      if (i % Math.max(1, Math.floor(candles.length / 50)) === 0) {
        doc.progress = i / candles.length;
        await doc.save();
      }
    }

    // Close any open position at end
    if (position) {
      const c = candles[candles.length - 1] as Candle;
      const fee = position.size * c.close * cfg.simulator.takerFeeRate;
      const dir = position.side === Side.LONG ? 1 : -1;
      const pnl = (c.close - position.entryPrice) * position.size * dir - fee;
      balance += pnl;
      feesPaid += fee;
      trades.push({
        symbol: position.symbol,
        side: position.side,
        entryPrice: position.entryPrice,
        exitPrice: c.close,
        qty: position.size,
        pnl,
        fees: fee,
        reason: TradeReason.SHUTDOWN,
        openedAt: position.openedAt,
        closedAt: c.closeTime,
      });
    }

    const wins = trades.filter((t) => t.pnl > 0);
    const losses = trades.filter((t) => t.pnl <= 0);
    const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = losses.reduce((s, t) => s + t.pnl, 0);

    doc.metrics = {
      finalEquity: balance,
      netPnl: balance - doc.startingBalance,
      grossProfit,
      grossLoss,
      fees: feesPaid,
      trades: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: trades.length ? wins.length / trades.length : 0,
      maxDrawdown: maxDd,
      sharpe: computeSharpe(equityCurve.map((e) => e.equity)),
    };
    doc.equityCurve = equityCurve.filter((_, i) => i % Math.max(1, Math.floor(equityCurve.length / 1000)) === 0) as never;
    doc.trades = trades as never;
    doc.status = 'done';
    doc.progress = 1;
    await doc.save();
  } catch (e) {
    doc.status = 'failed';
    doc.error = (e as Error).message;
    await doc.save();
  } finally {
    resetConfig();
  }
}

function checkExit(p: SimPosition, c: Candle): { price: number; reason: string } | null {
  if (p.side === Side.LONG) {
    if (c.low <= p.liquidationPrice) return { price: p.liquidationPrice, reason: TradeReason.LIQUIDATION };
    if (c.low <= p.stopPrice) return { price: p.stopPrice, reason: TradeReason.SL };
    if (c.high >= p.takeProfitPrice) return { price: p.takeProfitPrice, reason: TradeReason.TP };
  } else {
    if (c.high >= p.liquidationPrice) return { price: p.liquidationPrice, reason: TradeReason.LIQUIDATION };
    if (c.high >= p.stopPrice) return { price: p.stopPrice, reason: TradeReason.SL };
    if (c.low <= p.takeProfitPrice) return { price: p.takeProfitPrice, reason: TradeReason.TP };
  }
  return null;
}

function computeSharpe(equity: number[]): number {
  if (equity.length < 2) return 0;
  const returns: number[] = [];
  for (let i = 1; i < equity.length; i++) {
    const a = equity[i - 1] as number;
    const b = equity[i] as number;
    if (a > 0) returns.push((b - a) / a);
  }
  if (returns.length === 0) return 0;
  const m = returns.reduce((s, r) => s + r, 0) / returns.length;
  const v = returns.reduce((s, r) => s + (r - m) ** 2, 0) / returns.length;
  const sd = Math.sqrt(v);
  if (sd === 0) return 0;
  return (m / sd) * Math.sqrt(365 * 24 * 60); // annualized for 1m bars (rough)
}

export function startBacktestWorker(market: MarketDataService): Worker {
  const w = new Worker<{ id: string }>(
    'backtest',
    async (job: Job<{ id: string }>) => {
      log.info({ jobId: job.data.id }, 'worker picked up');
      await runBacktest(job.data.id, market);
    },
    { connection: queueConn, concurrency: 1 },
  );
  w.on('failed', (job, err) => log.error({ id: job?.id, err: err.message }, 'job failed'));
  return w;
}
