import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { Trader } from '../trader/Trader';
import type { IExecutionProvider } from '../execution/IExecutionProvider';
import type { WebSocketManager } from '../websocket/manager';
import type { BinanceClient } from '../binance/client';
import type { Ticker24h, TraderConfig, OrderUpdate, PriceUpdate, TraderMode, HedgeLevel } from '../../types';
import { createContextLogger } from '../logger';
import { withRetry } from '../utils/retry';
import type { PrismaClient } from '@prisma/client';

const log = createContextLogger('TraderManager');

const LEVERAGED_TOKEN_SUFFIXES = ['UP', 'DOWN', 'BEAR', 'BULL', '2L', '2S', '3L', '3S'];

function isLeveragedToken(symbol: string): boolean {
  return LEVERAGED_TOKEN_SUFFIXES.some((suffix) => symbol.endsWith(suffix));
}

export class TraderManager extends EventEmitter {
  private traders = new Map<string, Trader>();          // traderId → Trader
  private symbolToTrader = new Map<string, string>();   // symbol → traderId
  private topGainers: Ticker24h[] = [];
  private refreshTimer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private isPaused = false;

  constructor(
    private readonly executionProvider: IExecutionProvider,
    private readonly wsManager: WebSocketManager,
    private readonly binanceClient: BinanceClient,
    private readonly traderConfig: TraderConfig,
    private readonly db: PrismaClient,
    private readonly mode: TraderMode,
  ) {
    super();
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    log.info('TraderManager starting...');

    // Restore persisted traders
    await this.restoreTraders();

    // Subscribe to price feeds for active traders
    if (this.traders.size > 0) {
      const symbols = [...this.symbolToTrader.keys()];
      await this.wsManager.subscribeMultipleMarkPrices(symbols);
    }

    // Wire up WebSocket events
    this.wsManager.on('priceUpdate', (update: PriceUpdate) => this.onPriceUpdate(update));
    this.wsManager.on('orderUpdate', (update: OrderUpdate) => void this.onOrderUpdate(update));

    // Subscribe to user data stream
    try {
      const listenKey = await this.createListenKey();
      await this.wsManager.subscribeUserDataStream(listenKey);
    } catch (err) {
      log.error('Failed to subscribe to user data stream', { error: String(err) });
    }

    // Fill remaining trader slots
    await this.refreshAndFillSlots();

    // Start periodic refresh
    this.refreshTimer = setInterval(() => {
      void this.refreshAndFillSlots();
    }, this.traderConfig.refreshInterval);

    log.info(`TraderManager started with ${this.traders.size} traders`);
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    if (this.refreshTimer != null) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    await this.wsManager.shutdown();
    log.info('TraderManager stopped');
  }

  async pause(): Promise<void> {
    this.isPaused = true;
    for (const trader of this.traders.values()) {
      await trader.pause();
    }
    log.info('All traders paused');
  }

  async resume(): Promise<void> {
    this.isPaused = false;
    for (const trader of this.traders.values()) {
      await trader.resume();
    }
    log.info('All traders resumed');
  }

  async emergencyStop(): Promise<void> {
    log.warn('EMERGENCY STOP triggered');
    this.isRunning = false;
    if (this.refreshTimer != null) clearInterval(this.refreshTimer);
    for (const trader of this.traders.values()) {
      try {
        await trader.emergencyStop();
      } catch (err) {
        log.error(`Emergency stop failed for trader ${trader.getId()}`, { error: String(err) });
      }
    }
  }

  private async restoreTraders(): Promise<void> {
    const activeTraders = await this.db.trader.findMany({
      where: { status: { in: ['INITIALIZING', 'ACTIVE', 'PAUSED', 'COMPLETING'] } },
      include: { orders: { orderBy: { createdAt: 'asc' } } },
    });

    for (const dbTrader of activeTraders) {
      if (this.symbolToTrader.has(dbTrader.symbol)) {
        log.warn(`Duplicate symbol ${dbTrader.symbol} found in DB — skipping second entry`);
        continue;
      }

      try {
        const trader = new Trader(
          dbTrader.id,
          dbTrader.symbol,
          dbTrader.mode as TraderMode,
          this.executionProvider,
          this.traderConfig,
          this.db,
        );

        const hedgeLevels = await this.db.$queryRaw<Array<{ level: number; entryPrice: string; stopPrice: string; tpPrice: string; status: string }>>`
          SELECT DISTINCT ON ("hedgeLevel") "hedgeLevel" as level, price as "entryPrice", "stopPrice",
                 '0' as "tpPrice", status
          FROM "Order"
          WHERE "traderId" = ${dbTrader.id} AND role = 'HEDGE'
          ORDER BY "hedgeLevel", "createdAt" DESC
        `;

        // Detect corrupt state from a previous zero-price fill
        const shortEp = dbTrader.shortEntryPrice;
        if (shortEp === '0' || shortEp === '0.0' || Number(shortEp) === 0) {
          throw new Error(`Corrupt state: shortEntryPrice is ${shortEp}`);
        }

        await trader.restore({
          shortEntryPrice: dbTrader.shortEntryPrice,
          shortTpPrice: dbTrader.shortTpPrice,
          currentHedgeLevel: dbTrader.currentHedgeLevel,
          hedgeLevels: hedgeLevels.map((h) => ({
            level: h.level,
            entryPrice: h.entryPrice,
            stopPrice: h.stopPrice ?? '0',
            tpPrice: h.tpPrice,
            status: h.status as import('../../types').HedgeLevel['status'],
          })),
          status: dbTrader.status as import('../../types').TraderStatus,
          realizedPnl: dbTrader.realizedPnl,
          unrealizedPnl: dbTrader.unrealizedPnl,
        });

        this.wireTraderEvents(trader);
        this.traders.set(trader.getId(), trader);
        this.symbolToTrader.set(dbTrader.symbol, trader.getId());

        log.info(`Restored trader ${trader.getId()} for ${dbTrader.symbol}`);
      } catch (err) {
        // Symbol may have been delisted; mark as FAILED and continue
        log.warn(`Failed to restore trader for ${dbTrader.symbol}, marking FAILED`, { error: String(err) });
        await this.db.trader.update({
          where: { id: dbTrader.id },
          data: { status: 'FAILED' },
        });
      }
    }

    log.info(`Restored ${this.traders.size} active traders from database`);
  }

  private async refreshAndFillSlots(): Promise<void> {
    if (this.isPaused) return;

    try {
      this.topGainers = await withRetry(
        () => this.binanceClient.get24hTickers(),
        { maxAttempts: 3, delayMs: 2000 },
      );

      // Sort by price change percent descending
      this.topGainers.sort(
        (a, b) => parseFloat(b.priceChangePercent) - parseFloat(a.priceChangePercent),
      );

      const activeCount = this.getActiveTraderCount();
      const slotsNeeded = this.traderConfig.maxTraders - activeCount;

      if (slotsNeeded <= 0) return;

      const eligibleGainers = this.topGainers.filter((t) => this.isEligibleSymbol(t.symbol));
      log.info(`${eligibleGainers.length} eligible gainers, need ${slotsNeeded} new traders`);

      for (let i = 0; i < Math.min(slotsNeeded, eligibleGainers.length); i++) {
        const ticker = eligibleGainers[i];
        if (ticker == null) break;
        await this.createTrader(ticker.symbol);
      }
    } catch (err) {
      log.error('Error refreshing trader slots', { error: String(err) });
    }
  }

  private isEligibleSymbol(symbol: string): boolean {
    if (this.symbolToTrader.has(symbol)) return false;
    if (isLeveragedToken(symbol)) return false;
    if (!symbol.endsWith('USDT')) return false;
    return true;
  }

  private async createTrader(symbol: string): Promise<void> {
    // Double-check for duplicates
    if (this.symbolToTrader.has(symbol)) {
      log.warn(`Attempted to create duplicate trader for ${symbol}`);
      return;
    }

    const traderId = uuidv4();
    log.info(`Creating new trader ${traderId} for ${symbol}`);

    // Persist to DB before initialization
    const dbTrader = await this.db.trader.create({
      data: {
        id: traderId,
        symbol,
        mode: this.mode,
        status: 'INITIALIZING',
        leverage: this.traderConfig.leverage,
        marginMode: this.traderConfig.marginMode,
        initialCapital: this.traderConfig.initialCapital,
        positionSize: this.traderConfig.positionSize,
      },
    });

    const trader = new Trader(
      dbTrader.id,
      symbol,
      this.mode,
      this.executionProvider,
      this.traderConfig,
      this.db,
    );

    this.wireTraderEvents(trader);
    this.traders.set(traderId, trader);
    this.symbolToTrader.set(symbol, traderId);

    // Subscribe to mark price
    await this.wsManager.subscribeMarkPrice(symbol);

    try {
      await trader.initialize();
    } catch (err) {
      log.error(`Failed to initialize trader for ${symbol}`, { error: String(err) });
      this.traders.delete(traderId);
      this.symbolToTrader.delete(symbol);
      await this.db.trader.update({
        where: { id: traderId },
        data: { status: 'FAILED' },
      });
    }
  }

  private wireTraderEvents(trader: Trader): void {
    trader.on('traderEvent', async (event: import('../trader/Trader').TraderEvent) => {
      if (event.type === 'COMPLETED') {
        this.traders.delete(event.traderId);
        this.symbolToTrader.delete(event.symbol);
        log.info(`Trader slot freed for ${event.symbol}`);
        // Immediately try to fill the freed slot
        if (this.isRunning && !this.isPaused) {
          await this.refreshAndFillSlots();
        }
      } else if (event.type === 'FAILED') {
        this.traders.delete(event.traderId);
        this.symbolToTrader.delete(event.symbol);
      }
      this.emit('traderEvent', event);
    });
  }

  private onPriceUpdate(update: PriceUpdate): void {
    const traderId = this.symbolToTrader.get(update.symbol);
    if (traderId == null) return;
    const trader = this.traders.get(traderId);
    trader?.onPriceUpdate(update.price);
  }

  private async onOrderUpdate(update: OrderUpdate): Promise<void> {
    // Route to the correct trader
    for (const trader of this.traders.values()) {
      if (update.symbol === trader.getSymbol()) {
        await trader.onOrderUpdate(update);
      }
    }
  }

  private async createListenKey(): Promise<string> {
    const url = `${process.env.BINANCE_FUTURES_BASE_URL ?? 'https://fapi.binance.com/fapi/v1'}/listenKey`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'X-MBX-APIKEY': process.env.BINANCE_API_KEY ?? '' },
    });
    if (!res.ok) throw new Error(`Failed to create listen key: ${res.status}`);
    const body = await res.json() as { listenKey: string };
    return body.listenKey;
  }

  getActiveTraderCount(): number {
    return [...this.traders.values()].filter(
      (t) => t.getStatus() === 'ACTIVE' || t.getStatus() === 'INITIALIZING',
    ).length;
  }

  getTraderSummary(): Array<{
    id: string;
    symbol: string;
    status: string;
    realizedPnl: string;
    unrealizedPnl: string;
    hedgeLevel: number;
    entryPrice: string | null;
    tpPrice: string | null;
    markPrice: string;
    hedgeLevels: HedgeLevel[];
  }> {
    return [...this.traders.values()].map((t) => ({
      id: t.getId(),
      symbol: t.getSymbol(),
      status: t.getStatus(),
      realizedPnl: t.getRealizedPnl(),
      unrealizedPnl: t.getUnrealizedPnl(),
      hedgeLevel: t.getCurrentHedgeLevel(),
      entryPrice: t.getShortEntryPrice(),
      tpPrice: t.getShortTpPrice(),
      markPrice: t.getMarkPrice(),
      hedgeLevels: t.getHedgeLevels(),
    }));
  }
    }));
  }

  getTopGainers(): Ticker24h[] {
    return this.topGainers.slice(0, 20);
  }

  getTotalRealizedPnl(): string {
    return [...this.traders.values()]
      .reduce((acc, t) => acc.plus(t.getRealizedPnl()), new Decimal(0))
      .toFixed(8);
  }

  getTotalUnrealizedPnl(): string {
    return [...this.traders.values()]
      .reduce((acc, t) => acc.plus(t.getUnrealizedPnl()), new Decimal(0))
      .toFixed(8);
  }
}
