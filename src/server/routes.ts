import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { verifyPassword } from '../services/auth.service.js';
import { signToken, authMiddleware, type AuthedRequest } from './auth.middleware.js';
import { CONFIG } from '../core/config.js';
import { saveSettings } from '../services/settings.service.js';
import { env } from '../core/env.js';
import { OrderModel, PositionModel, TradeModel, BalanceModel, ScanModel, BacktestModel } from '../models/index.js';
import type { Orchestrator } from '../services/orchestrator.service.js';
import type { IExecutionService } from '../services/execution/execution.interface.js';
import type { MarketDataService } from '../services/marketData.service.js';
import { detectRegime } from '../services/regime.service.js';
import { rsi, atr, sma, slope as slopeOf } from '../indicators/index.js';
import { backtestQueue } from '../services/backtest.service.js';

const LoginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export interface RouterDeps {
  orchestrator: Orchestrator;
  execution: IExecutionService;
  market: MarketDataService;
}

export function buildRouter(deps: RouterDeps): Router {
  const r = Router();

  r.post('/auth/login', async (req: Request, res: Response) => {
    const parsed = LoginSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'bad_request' });
    const ok = await verifyPassword(parsed.data.username, parsed.data.password);
    if (!ok) return res.status(401).json({ error: 'invalid_credentials' });
    return res.json({ token: signToken({ username: parsed.data.username, role: 'admin' }) });
  });

  // Everything else requires auth
  r.use(authMiddleware);

  r.get('/me', (req: AuthedRequest, res: Response) => {
    res.json({ user: req.user });
  });

  r.get('/status', async (_req: Request, res: Response) => {
    const balance = await deps.execution.getBalance();
    const positions = await deps.execution.getAllPositions();
    res.json({
      mode: env.MODE,
      balance,
      positions,
      killSwitch: CONFIG().killSwitch,
      orchestrator: deps.orchestrator.getState(),
    });
  });

  r.get('/symbols/scan', async (_req: Request, res: Response) => {
    const lastInMem = (deps as RouterDeps).orchestrator;
    void lastInMem;
    const last = await ScanModel.findOne().sort({ ts: -1 }).lean();
    res.json(last ?? null);
  });

  r.get('/positions', async (_req: Request, res: Response) => {
    res.json(await PositionModel.find({ mode: env.MODE }).lean());
  });

  r.get('/orders', async (req: Request, res: Response) => {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const q: Record<string, unknown> = { mode: env.MODE };
    if (status) q.status = status;
    res.json(await OrderModel.find(q).sort({ createdAt: -1 }).limit(200).lean());
  });

  r.get('/trades', async (req: Request, res: Response) => {
    const limit = Math.min(parseInt(String(req.query.limit ?? '100'), 10) || 100, 500);
    const q: Record<string, unknown> = { mode: env.MODE };
    if (typeof req.query.symbol === 'string') q.symbol = req.query.symbol;
    res.json(await TradeModel.find(q).sort({ closedAt: -1 }).limit(limit).lean());
  });

  r.get('/balance/history', async (_req: Request, res: Response) => {
    const docs = await BalanceModel.find({ mode: env.MODE }).sort({ ts: -1 }).limit(500).lean();
    res.json(docs.reverse());
  });

  r.get('/strategy/:symbol', async (req: Request, res: Response) => {
    const cfg = CONFIG();
    const symbol = req.params.symbol as string;
    const candles = deps.market.getCandles(symbol, cfg.timeframes.strategy);
    if (candles.length < 50) return res.status(404).json({ error: 'no_data' });
    const closes = candles.map((c) => c.close);
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);
    const rsiSeries = rsi(closes, cfg.indicators.rsiPeriod);
    const atrSeries = atr(highs, lows, closes, cfg.indicators.atrPeriod);
    const maSeries = sma(closes, cfg.indicators.maPeriod);
    const slopeSeries = slopeOf(maSeries);
    const regime = detectRegime(candles);
    const i = candles.length - 1;
    res.json({
      symbol,
      candles: candles.slice(-200),
      indicators: {
        rsi: rsiSeries.slice(-200),
        atr: atrSeries.slice(-200),
        ma: maSeries.slice(-200),
        slope: slopeSeries.slice(-200),
      },
      latest: {
        close: closes[i],
        rsi: rsiSeries[i],
        atr: atrSeries[i],
        ma: maSeries[i],
        slope: slopeSeries[i],
      },
      regime,
    });
  });

  r.get('/settings', (_req: Request, res: Response) => {
    res.json(CONFIG());
  });

  r.put('/settings', async (req: AuthedRequest, res: Response) => {
    try {
      const cfg = await saveSettings(req.body, req.user?.username ?? 'admin');
      res.json(cfg);
    } catch (e) {
      res.status(400).json({ error: 'invalid_settings', detail: (e as Error).message });
    }
  });

  r.post('/kill-switch', async (req: AuthedRequest, res: Response) => {
    const enabled = Boolean((req.body as { enabled?: boolean })?.enabled);
    const cfg = await saveSettings({ killSwitch: enabled }, req.user?.username ?? 'admin');
    res.json({ killSwitch: cfg.killSwitch });
  });

  // Backtest
  const BacktestSchemaIn = z.object({
    symbol: z.string(),
    interval: z.string().default('1m'),
    fromTs: z.number().int(),
    toTs: z.number().int(),
    startingBalance: z.number().positive().default(600),
    paramsPatch: z.record(z.unknown()).optional(),
  });

  r.post('/backtest', async (req: Request, res: Response) => {
    const parsed = BacktestSchemaIn.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'bad_request', detail: parsed.error.format() });
    const doc = await BacktestModel.create({ status: 'queued', ...parsed.data });
    await backtestQueue.add('run', { id: String(doc._id) });
    res.json({ id: String(doc._id), status: 'queued' });
  });

  r.get('/backtest/:id', async (req: Request, res: Response) => {
    const doc = await BacktestModel.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ error: 'not_found' });
    res.json(doc);
  });

  r.get('/backtest', async (_req: Request, res: Response) => {
    res.json(await BacktestModel.find().sort({ createdAt: -1 }).limit(50).lean());
  });

  return r;
}
