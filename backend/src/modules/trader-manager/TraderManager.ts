import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { Trader } from '../trader/Trader';
import type { IExecutionProvider } from '../execution/IExecutionProvider';
import type { WebSocketManager } from '../websocket/manager';
import type { BinanceClient } from '../binance/client';
import type { EquityService } from '../calc/EquityService';
import type {
  Ticker24h,
  TraderConfig,
  OrderUpdate,
  PriceUpdate,
  TraderMode,
  HedgeLevel,
  TraderSummaryView,
  DashboardEvent,
  OrderStatus,
} from '../../types';
import { calcTotalPnl } from '../calc/allocation';
import { createContextLogger } from '../logger';
import { withRetry } from '../utils/retry';
import type { PrismaClient } from '@prisma/client';

const log = createContextLogger('TraderManager');

const LEVERAGED_TOKEN_SUFFIXES = ['UP', 'DOWN', 'BEAR', 'BULL', '2L', '2S', '3L', '3S'];

function isLeveragedToken(symbol: string): boolean {
  return LEVERAGED_TOKEN_SUFFIXES.some((suffix) => symbol.endsWith(suffix));
}

const OPEN_ORDER_STATUSES: OrderStatus[] = ['PENDING', 'NEW', 'PARTIALLY_FILLED'];

export class TraderManager extends EventEmitter {
  private traders = new Map<string, Trader>();
  private symbolToTrader = new Map<string, string>();
  private topGainers: Ticker24h[] = [];
  private refreshTimer: NodeJS.Timeout | null = null;
  private summaryTimer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private isPaused = false;
  private lastSummaryAt = 0;

  constructor(
    private readonly executionProvider: IExecutionProvider,
    private readonly wsManager: WebSocketManager,
    private readonly binanceClient: BinanceClient,
    private readonly traderConfig: TraderConfig,
    private readonly db: PrismaClient,
    private readonly mode: TraderMode,
    private readonly equityService: EquityService,
  ) {
    super();
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    log.info('TraderManager starting...');

    await this.restoreTraders();

    if (this.traders.size > 0) {
      const symbols = [...this.symbolToTrader.keys()];
      await this.wsManager.subscribeMultipleMarkPrices(symbols);
    }

    this.wsManager.on('priceUpdate', (update: PriceUpdate) => this.onPriceUpdate(update));
    this.wsManager.on('orderUpdate', (update: OrderUpdate) => void this.handleOrderUpdate(update));

    try {
      const listenKey = await this.createListenKey();
      await this.wsManager.subscribeUserDataStream(listenKey);
    } catch (err) {
      log.error('Failed to subscribe to user data stream', { error: String(err) });
    }

    await this.refreshAndFillSlots();

    this.refreshTimer = setInterval(() => {
      void this.refreshAndFillSlots();
    }, this.traderConfig.refreshInterval);

    this.summaryTimer = setInterval(() => {
      void this.broadcastSummary();
    }, 2000);

    log.info(`TraderManager started with ${this.traders.size} traders`);
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    if (this.refreshTimer != null) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.summaryTimer != null) {
      clearInterval(this.summaryTimer);
      this.summaryTimer = null;
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
    if (this.summaryTimer != null) clearInterval(this.summaryTimer);
    for (const trader of this.traders.values()) {
      try {
        await trader.emergencyStop();
      } catch (err) {
        log.error(`Emergency stop failed for trader ${trader.getId()}`, { error: String(err) });
      }
    }
  }

  /** Shared path for Live user-data stream and Simulation orderFill events. */
  async handleOrderUpdate(update: OrderUpdate): Promise<void> {
    const traderId = this.symbolToTrader.get(update.symbol);
    if (traderId == null) return;
    const trader = this.traders.get(traderId);
    if (trader == null) return;
    await trader.onOrderUpdate(update);
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
          this.equityService,
        );

        const shortEp = dbTrader.shortEntryPrice;
        if (shortEp === '0' || shortEp === '0.0' || Number(shortEp) === 0) {
          throw new Error(`Corrupt state: shortEntryPrice is ${shortEp}`);
        }

        const restored = this.reconstructStateFromOrders(dbTrader);

        await trader.restore({
          shortEntryPrice: dbTrader.shortEntryPrice,
          shortTpPrice: dbTrader.shortTpPrice,
          shortQuantity: restored.shortQuantity,
          currentHedgeLevel: dbTrader.currentHedgeLevel,
          hedgeLevels: restored.hedgeLevels,
          status: dbTrader.status as import('../../types').TraderStatus,
          realizedPnl: dbTrader.realizedPnl,
          unrealizedPnl: dbTrader.unrealizedPnl,
          pendingClientOrderIds: restored.pendingClientOrderIds,
          shortClientOrderId: restored.shortClientOrderId,
          shortTpClientOrderId: restored.shortTpClientOrderId,
          activeHedgeClientOrderId: restored.activeHedgeClientOrderId,
          hedgeOrderIds: restored.hedgeOrderIds,
        });

        this.wireTraderEvents(trader);
        this.traders.set(trader.getId(), trader);
        this.symbolToTrader.set(dbTrader.symbol, trader.getId());

        log.info(`Restored trader ${trader.getId()} for ${dbTrader.symbol}`);
      } catch (err) {
        log.warn(`Failed to restore trader for ${dbTrader.symbol}, marking FAILED`, { error: String(err) });
        await this.db.trader.update({
          where: { id: dbTrader.id },
          data: { status: 'FAILED' },
        });
      }
    }

    log.info(`Restored ${this.traders.size} active traders from database`);
  }

  private reconstructStateFromOrders(dbTrader: {
    id: string;
    positionSize: string;
    currentHedgeLevel: number;
    hedgeEntryPrice: string | null;
    hedgeTpPrice: string | null;
    hedgeStopPrice: string | null;
    orders: Array<{
      clientOrderId: string;
      type: string;
      status: string;
      role: string;
      hedgeLevel: number;
      quantity: string;
      price: string | null;
      stopPrice: string | null;
      filledQuantity: string;
    }>;
  }): {
    shortQuantity: string | null;
    hedgeLevels: HedgeLevel[];
    pendingClientOrderIds: string[];
    shortClientOrderId: string | null;
    shortTpClientOrderId: string | null;
    activeHedgeClientOrderId: string | null;
    hedgeOrderIds: Array<{ level: number; tpClientId: string; slClientId: string }>;
  } {
    const orders = dbTrader.orders;
    const shortMarket = [...orders].reverse().find((o) => o.role === 'SHORT' && o.type === 'MARKET');
    const shortTp = [...orders].reverse().find((o) => o.role === 'SHORT' && (o.type === 'TAKE_PROFIT' || o.type === 'TAKE_PROFIT_MARKET'));

    const shortQuantity =
      shortMarket?.filledQuantity && shortMarket.filledQuantity !== '0'
        ? shortMarket.filledQuantity
        : shortMarket?.quantity ?? (dbTrader.positionSize !== '100' ? dbTrader.positionSize : null);

    const levels = new Set(orders.filter((o) => o.role === 'HEDGE').map((o) => o.hedgeLevel));
    const hedgeLevels: HedgeLevel[] = [];

    for (const level of [...levels].sort((a, b) => a - b)) {
      const levelOrders = orders.filter((o) => o.role === 'HEDGE' && o.hedgeLevel === level);
      const entryOrder = [...levelOrders].reverse().find((o) => o.type === 'STOP_LIMIT');
      const tpOrder = [...levelOrders].reverse().find((o) => o.type === 'TAKE_PROFIT' || o.type === 'TAKE_PROFIT_MARKET');
      const slOrder = [...levelOrders].reverse().find((o) => o.type === 'STOP_MARKET');

      if (entryOrder == null && dbTrader.hedgeEntryPrice == null) continue;

      const entryFilled = entryOrder?.status === 'FILLED' || entryOrder?.status === 'PARTIALLY_FILLED';
      const tpFilled = tpOrder?.status === 'FILLED';
      const slFilled = slOrder?.status === 'FILLED';

      let status: HedgeLevel['status'] = 'PENDING';
      if (tpFilled) status = 'HIT_TP';
      else if (slFilled) status = 'HIT_SL';
      else if (entryFilled) status = 'OPEN';
      else if (entryOrder != null && OPEN_ORDER_STATUSES.includes(entryOrder.status as OrderStatus)) status = 'ACTIVE';

      hedgeLevels.push({
        level,
        entryPrice: entryOrder?.price ?? dbTrader.hedgeEntryPrice ?? '0',
        stopPrice: slOrder?.stopPrice ?? entryOrder?.stopPrice ?? dbTrader.hedgeStopPrice ?? '0',
        tpPrice: tpOrder?.price ?? tpOrder?.stopPrice ?? dbTrader.hedgeTpPrice ?? '0',
        quantity: entryOrder?.filledQuantity && entryOrder.filledQuantity !== '0'
          ? entryOrder.filledQuantity
          : entryOrder?.quantity ?? shortQuantity ?? '0',
        status,
      });
    }

    // If no hedge orders reconstructed but trader has hedge metadata, seed level 1
    if (hedgeLevels.length === 0 && dbTrader.hedgeEntryPrice != null) {
      hedgeLevels.push({
        level: Math.max(1, dbTrader.currentHedgeLevel),
        entryPrice: dbTrader.hedgeEntryPrice,
        stopPrice: dbTrader.hedgeStopPrice ?? '0',
        tpPrice: dbTrader.hedgeTpPrice ?? '0',
        quantity: shortQuantity ?? '0',
        status: 'ACTIVE',
      });
    }

    const pendingClientOrderIds = orders
      .filter((o) => OPEN_ORDER_STATUSES.includes(o.status as OrderStatus))
      .map((o) => o.clientOrderId);

    const hedgeOrderIds: Array<{ level: number; tpClientId: string; slClientId: string }> = [];
    for (const level of hedgeLevels) {
      if (level.status !== 'OPEN') continue;
      const levelOrders = orders.filter((o) => o.role === 'HEDGE' && o.hedgeLevel === level.level);
      const tp = [...levelOrders].reverse().find((o) =>
        (o.type === 'TAKE_PROFIT' || o.type === 'TAKE_PROFIT_MARKET') && OPEN_ORDER_STATUSES.includes(o.status as OrderStatus),
      );
      const sl = [...levelOrders].reverse().find((o) =>
        o.type === 'STOP_MARKET' && OPEN_ORDER_STATUSES.includes(o.status as OrderStatus),
      );
      if (tp != null && sl != null) {
        hedgeOrderIds.push({ level: level.level, tpClientId: tp.clientOrderId, slClientId: sl.clientOrderId });
      }
    }

    const activeHedge = [...orders].reverse().find((o) =>
      o.role === 'HEDGE' && o.type === 'STOP_LIMIT' && OPEN_ORDER_STATUSES.includes(o.status as OrderStatus),
    );

    return {
      shortQuantity,
      hedgeLevels,
      pendingClientOrderIds,
      shortClientOrderId: shortMarket?.clientOrderId ?? null,
      shortTpClientOrderId: shortTp?.clientOrderId ?? null,
      activeHedgeClientOrderId: activeHedge?.clientOrderId ?? null,
      hedgeOrderIds,
    };
  }

  private async refreshAndFillSlots(): Promise<void> {
    if (this.isPaused) return;

    try {
      this.topGainers = await withRetry(
        () => this.binanceClient.get24hTickers(),
        { maxAttempts: 3, delayMs: 2000 },
      );

      this.topGainers.sort(
        (a, b) => parseFloat(b.priceChangePercent) - parseFloat(a.priceChangePercent),
      );

      await this.broadcastSummary(true);

      const activeCount = this.getActiveTraderCount();
      const slotsNeeded = this.traderConfig.maxTraders - activeCount;

      if (slotsNeeded <= 0) return;

      const eligibleGainers = this.topGainers.filter((t) => this.isEligibleSymbol(t.symbol));
      log.info(`${eligibleGainers.length} eligible gainers, need ${slotsNeeded} new traders`);

      for (let i = 0; i < Math.min(slotsNeeded, eligibleGainers.length); i++) {
        const ticker = eligibleGainers[i];
        if (ticker == null) break;
        try {
          await this.createTrader(ticker.symbol);
        } catch (err) {
          log.error(`Failed to create trader for ${ticker.symbol}`, { error: String(err) });
        }
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
    if (this.symbolToTrader.has(symbol)) {
      log.warn(`Attempted to create duplicate trader for ${symbol}`);
      return;
    }

    const traderId = uuidv4();
    log.info(`Creating new trader ${traderId} for ${symbol}`);

    const allocation = await this.equityService.getAllocation(
      this.traderConfig.maxTraders,
      this.traderConfig.leverage,
    );

    const dbTrader = await this.db.trader.create({
      data: {
        id: traderId,
        symbol,
        mode: this.mode,
        status: 'INITIALIZING',
        leverage: this.traderConfig.leverage,
        marginMode: this.traderConfig.marginMode,
        initialCapital: allocation.traderEquity.toFixed(8),
        positionSize: allocation.positionNotional.toFixed(8),
      },
    });

    const trader = new Trader(
      dbTrader.id,
      symbol,
      this.mode,
      this.executionProvider,
      this.traderConfig,
      this.db,
      this.equityService,
    );

    this.wireTraderEvents(trader);
    this.symbolToTrader.set(symbol, traderId);

    try {
      await this.wsManager.subscribeMarkPrice(symbol);
    } catch (err) {
      log.warn(`Price feed subscription failed for ${symbol}, falling back to REST`, { error: String(err) });
    }

    try {
      await trader.initialize();
      this.traders.set(traderId, trader);
      await this.broadcastSummary(true);
    } catch (err) {
      log.error(`Failed to initialize trader for ${symbol}`, { error: String(err) });
      this.symbolToTrader.delete(symbol);
      this.wsManager.unsubscribe(`${symbol.toLowerCase()}@markPrice@1s`).catch(() => {});
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
        if (this.isRunning && !this.isPaused) {
          await this.refreshAndFillSlots();
        }
      } else if (event.type === 'FAILED') {
        this.traders.delete(event.traderId);
        this.symbolToTrader.delete(event.symbol);
      }

      this.emit('traderEvent', event as DashboardEvent);

      if (event.type === 'COMPLETED' || event.type === 'FAILED' || event.type === 'STATUS_CHANGED') {
        void this.broadcastSummary(true);
      }
    });
  }

  private onPriceUpdate(update: PriceUpdate): void {
    const traderId = this.symbolToTrader.get(update.symbol);
    if (traderId == null) return;
    const trader = this.traders.get(traderId);
    trader?.onPriceUpdate(update.price);
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

  async broadcastSummary(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastSummaryAt < 1500) return;
    this.lastSummaryAt = now;

    try {
      const totalEquity = await this.equityService.getTotalEquity();
      // Realized includes completed traders (DB); unrealized is live in-memory only
      const realizedDec = await this.equityService.getTotalRealizedPnl();
      const unrealized = this.getTotalUnrealizedPnl();
      const totalPnl = calcTotalPnl(realizedDec, unrealized);

      const event: DashboardEvent = {
        type: 'SUMMARY',
        data: {
          totalEquity: totalEquity.toFixed(2),
          totalPnl: totalPnl.toFixed(8),
          totalRealizedPnl: realizedDec.toFixed(8),
          totalUnrealizedPnl: unrealized,
          activeTraders: this.getActiveTraderCount(),
          maxTraders: this.traderConfig.maxTraders,
          topGainers: this.topGainers.slice(0, 20),
          tradingMode: this.mode,
        },
      };
      this.emit('traderEvent', event);
    } catch (err) {
      log.warn('Failed to broadcast summary', { error: String(err) });
    }
  }

  getActiveTraderCount(): number {
    return [...this.traders.values()].filter(
      (t) => t.getStatus() === 'ACTIVE' || t.getStatus() === 'INITIALIZING',
    ).length;
  }

  getTraderSummary(): TraderSummaryView[] {
    return [...this.traders.values()].map((t) => t.toSummary());
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
