import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { Trader } from '../trader/Trader';
import type { IExecutionProvider } from '../execution/IExecutionProvider';
import type { WebSocketManager } from '../websocket/manager';
import type { BinanceClient } from '../binance/client';
import type { AccountLedger } from '../calc/AccountLedger';
import type {
  Ticker24h,
  TraderConfig,
  OrderUpdate,
  PriceUpdate,
  TraderMode,
  TraderSummaryView,
  DashboardEvent,
  OrderStatus,
  TradeSide,
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

const OPEN_ORDER_STATUSES: OrderStatus[] = ['PENDING', 'NEW', 'TRIGGERED', 'PARTIALLY_FILLED'];

/** Infer BUY/SELL when DB row lacks side. */
function inferOrderSide(o: { side?: string; role: string; type: string }): 'BUY' | 'SELL' {
  if (o.side === 'BUY' || o.side === 'SELL') return o.side;
  const isLong = o.role === 'LONG' || o.role === 'HEDGE';
  if (o.type === 'MARKET') return isLong ? 'BUY' : 'SELL';
  // TP/SL close: opposite of entry
  return isLong ? 'SELL' : 'BUY';
}

export class TraderManager extends EventEmitter {
  private traders = new Map<string, Trader>();
  private symbolToTrader = new Map<string, string>();
  private topGainers: Ticker24h[] = [];
  private refreshTimer: NodeJS.Timeout | null = null;
  private summaryTimer: NodeJS.Timeout | null = null;
  private pricePollTimer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private isPaused = false;
  private lastSummaryAt = 0;
  private refreshInFlight = false;
  /** Serialize order updates per trader to prevent double-complete races. */
  private orderQueues = new Map<string, Promise<void>>();
  private boundPriceHandler: ((u: PriceUpdate) => void) | null = null;
  private boundOrderHandler: ((u: OrderUpdate) => void) | null = null;

  constructor(
    private readonly executionProvider: IExecutionProvider,
    private readonly wsManager: WebSocketManager,
    private readonly binanceClient: BinanceClient,
    private readonly traderConfig: TraderConfig,
    private readonly db: PrismaClient,
    private readonly mode: TraderMode,
    private readonly accountLedger: AccountLedger,
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

    this.boundPriceHandler = (update: PriceUpdate) => this.onPriceUpdate(update);
    this.boundOrderHandler = (update: OrderUpdate) => void this.handleOrderUpdate(update);
    this.wsManager.on('priceUpdate', this.boundPriceHandler);
    this.wsManager.on('orderUpdate', this.boundOrderHandler);

    try {
      const listenKey = await this.createListenKey();
      await this.wsManager.subscribeUserDataStream(listenKey);
    } catch (err) {
      log.error('Failed to subscribe to user data stream', { error: String(err) });
      // LIVE cannot complete/trade without fill notifications
      if (this.mode === 'LIVE') {
        throw new Error(`LIVE mode requires user-data stream: ${String(err)}`);
      }
    }

    await this.refreshAndFillSlots();

    this.refreshTimer = setInterval(() => {
      void this.refreshAndFillSlots();
    }, this.traderConfig.refreshInterval);

    // Push live trader snapshots + summary every second (UI realtime backbone)
    this.summaryTimer = setInterval(() => {
      this.broadcastAllSnapshots();
      void this.broadcastSummary(true);
    }, 1000);

    // REST fallback if Binance mark-price WS stalls (also feeds simulation triggers)
    this.pricePollTimer = setInterval(() => {
      void this.pollMarkPrices();
    }, 1500);

    log.info(`TraderManager started with ${this.traders.size}/${this.traderConfig.maxTraders} traders`);
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
    if (this.pricePollTimer != null) {
      clearInterval(this.pricePollTimer);
      this.pricePollTimer = null;
    }
    if (this.boundPriceHandler != null) {
      this.wsManager.off('priceUpdate', this.boundPriceHandler);
      this.boundPriceHandler = null;
    }
    if (this.boundOrderHandler != null) {
      this.wsManager.off('orderUpdate', this.boundOrderHandler);
      this.boundOrderHandler = null;
    }
    for (const trader of this.traders.values()) {
      trader.destroy();
    }
    this.traders.clear();
    this.symbolToTrader.clear();
    this.orderQueues.clear();
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
    if (this.refreshTimer != null) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.summaryTimer != null) {
      clearInterval(this.summaryTimer);
      this.summaryTimer = null;
    }
    if (this.pricePollTimer != null) {
      clearInterval(this.pricePollTimer);
      this.pricePollTimer = null;
    }
    for (const trader of [...this.traders.values()]) {
      try {
        await trader.emergencyStop();
      } catch (err) {
        log.error(`Emergency stop failed for trader ${trader.getId()}`, { error: String(err) });
      }
      trader.destroy();
    }
    this.traders.clear();
    this.symbolToTrader.clear();
    this.orderQueues.clear();
    void this.broadcastSummary(true);
  }

  /** Hot-apply config from API without restart. */
  applyRuntimeConfig(patch: Record<string, unknown>): void {
    const cfg = this.traderConfig as unknown as Record<string, unknown>;
    const keys = [
      'maxTraders', 'initialCapital', 'positionSize', 'leverage', 'marginMode',
      'traderLifetimeHours', 'takeProfitPercent', 'stopLossPercent', 'startingSide',
      'refreshInterval', 'retryLimit', 'feeRate', 'slippage',
    ] as const;
    for (const k of keys) {
      if (k in patch && patch[k] != null) cfg[k] = patch[k];
    }
    // Cap extras if maxTraders decreased
    if (this.traders.size > this.traderConfig.maxTraders) {
      void this.enforceMaxTradersCap();
    }
    log.info('Runtime config applied', { maxTraders: this.traderConfig.maxTraders });
  }

  getRuntimeConfig(): TraderConfig {
    return { ...this.traderConfig };
  }

  private async enforceMaxTradersCap(): Promise<void> {
    const ordered = [...this.traders.values()];
    const extras = ordered.slice(this.traderConfig.maxTraders);
    for (const t of extras) {
      try {
        await t.emergencyStop();
      } catch (err) {
        log.error(`Failed stopping excess trader ${t.getId()}`, { error: String(err) });
      }
      t.destroy();
      this.traders.delete(t.getId());
      this.symbolToTrader.delete(t.getSymbol());
    }
  }

  /** Shared path for Live user-data stream and Simulation orderFill events. */
  async handleOrderUpdate(update: OrderUpdate): Promise<void> {
    const traderId = this.symbolToTrader.get(update.symbol);
    if (traderId == null) return;
    const trader = this.traders.get(traderId);
    if (trader == null) return;

    const prev = this.orderQueues.get(traderId) ?? Promise.resolve();
    const next = prev
      .then(() => trader.onOrderUpdate(update))
      .catch((err) => {
        log.error(`Order update failed for trader ${traderId}`, { error: String(err) });
      });
    this.orderQueues.set(traderId, next);
    await next;
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
          this.accountLedger,
        );

        const orders = dbTrader.orders;
        const pendingClientOrderIds = orders
          .filter((o) => OPEN_ORDER_STATUSES.includes(o.status as OrderStatus))
          .map((o) => o.clientOrderId);

        const posNum = dbTrader.currentPositionNumber;
        const entryOrder = [...orders].reverse().find(
          (o) => o.type === 'MARKET' && o.hedgeLevel === posNum,
        );
        const tpOrder = [...orders].reverse().find(
          (o) =>
            (o.type === 'TAKE_PROFIT' || o.type === 'TAKE_PROFIT_MARKET')
            && o.hedgeLevel === posNum
            && OPEN_ORDER_STATUSES.includes(o.status as OrderStatus),
        );
        const slOrder = [...orders].reverse().find(
          (o) =>
            o.type === 'STOP_MARKET'
            && o.hedgeLevel === posNum
            && OPEN_ORDER_STATUSES.includes(o.status as OrderStatus),
        );

        const side = (dbTrader.currentSide as TradeSide | null) ?? null;
        const positionOpen =
          side != null
          && dbTrader.entryPrice != null
          && dbTrader.entryPrice !== '0'
          && (tpOrder != null || slOrder != null);

        const orderViews = orders.map((o) => ({
          clientOrderId: o.clientOrderId,
          role: o.role as import('../../types').HedgeRole,
          type: o.type as import('../../types').OrderType,
          status: o.status as OrderStatus,
          side: inferOrderSide(o),
          price: o.price,
          stopPrice: o.stopPrice,
          hedgeLevel: o.hedgeLevel,
          quantity: o.quantity,
        }));

        await trader.restore({
          status: dbTrader.status as import('../../types').TraderStatus,
          realizedPnl: dbTrader.realizedPnl,
          unrealizedPnl: dbTrader.unrealizedPnl,
          startedAt: dbTrader.startedAt,
          endsAt: dbTrader.endsAt,
          currentSide: side,
          currentPositionNumber: posNum,
          entryPrice: dbTrader.entryPrice,
          tpPrice: dbTrader.tpPrice,
          slPrice: dbTrader.slPrice,
          quantity: dbTrader.quantity,
          positionsOpened: dbTrader.positionsOpened,
          positionsClosed: dbTrader.positionsClosed,
          winningPositions: dbTrader.winningPositions,
          losingPositions: dbTrader.losingPositions,
          takeProfits: dbTrader.takeProfits,
          stopLosses: dbTrader.stopLosses,
          longPositions: dbTrader.longPositions,
          shortPositions: dbTrader.shortPositions,
          totalFees: dbTrader.totalFees,
          timelineJson: dbTrader.timelineJson,
          pendingClientOrderIds,
          entryClientOrderId: entryOrder?.clientOrderId ?? null,
          tpClientOrderId: tpOrder?.clientOrderId ?? null,
          slClientOrderId: slOrder?.clientOrderId ?? null,
          positionOpen,
          orderViews,
        });

        if (this.mode === 'SIMULATION') {
          this.rehydrateSimulation(dbTrader, {
            positionOpen,
            side,
            entryPrice: dbTrader.entryPrice,
            quantity: dbTrader.quantity,
          });
        }

        this.wireTraderEvents(trader);
        this.traders.set(trader.getId(), trader);
        this.symbolToTrader.set(dbTrader.symbol, trader.getId());

        if (dbTrader.status === 'COMPLETING') {
          await trader.resumeCompleting();
        }

        log.info(`Restored trader ${trader.getId()} for ${dbTrader.symbol}`);
      } catch (err) {
        log.warn(`Failed to restore trader for ${dbTrader.symbol}, marking FAILED`, { error: String(err) });
        await this.db.trader.update({
          where: { id: dbTrader.id },
          data: { status: 'FAILED' },
        });
      }
    }

    if (this.traders.size > this.traderConfig.maxTraders) {
      const ordered = [...this.traders.values()];
      const extras = ordered.slice(this.traderConfig.maxTraders);
      log.warn(`Restored ${ordered.length} traders but max is ${this.traderConfig.maxTraders} — stopping ${extras.length} extras`);
      for (const t of extras) {
        try {
          await t.emergencyStop();
        } catch (err) {
          log.error(`Failed stopping excess trader ${t.getId()}`, { error: String(err) });
        }
        this.traders.delete(t.getId());
        this.symbolToTrader.delete(t.getSymbol());
      }
    }

    log.info(`Restored ${this.traders.size}/${this.traderConfig.maxTraders} active traders from database`);
  }

  /** Rebuild sim book for open V2 position + TP/SL. */
  private rehydrateSimulation(
    dbTrader: {
      id: string;
      symbol: string;
      leverage: number;
      orders: Array<{
        clientOrderId: string;
        type: string;
        status: string;
        role: string;
        side?: string;
        hedgeLevel: number;
        quantity: string;
        filledQuantity: string;
        price: string | null;
        stopPrice: string | null;
      }>;
    },
    state: {
      positionOpen: boolean;
      side: TradeSide | null;
      entryPrice: string | null;
      quantity: string | null;
    },
  ): void {
    const sim = this.executionProvider as {
      rehydrate?: (p: {
        positions: Array<{ symbol: string; side: 'LONG' | 'SHORT'; entryPrice: string; quantity: string; leverage?: number }>;
        orders: Array<{
          clientOrderId: string;
          traderId: string;
          symbol: string;
          side: 'BUY' | 'SELL';
          type: import('../../types').OrderType;
          role: import('../../types').HedgeRole;
          hedgeLevel: number;
          quantity: string;
          filledQuantity?: string;
          price?: string | null;
          stopPrice?: string | null;
          status: OrderStatus;
          positionSide?: 'LONG' | 'SHORT' | 'BOTH';
        }>;
      }) => void;
    };
    if (sim.rehydrate == null) return;

    const positions: Array<{ symbol: string; side: 'LONG' | 'SHORT'; entryPrice: string; quantity: string; leverage?: number }> = [];
    if (
      state.positionOpen
      && state.side != null
      && state.entryPrice != null
      && state.quantity != null
      && state.quantity !== '0'
    ) {
      positions.push({
        symbol: dbTrader.symbol,
        side: state.side,
        entryPrice: state.entryPrice,
        quantity: state.quantity,
        leverage: dbTrader.leverage,
      });
    }

    const openOrders = dbTrader.orders
      .filter((o) => OPEN_ORDER_STATUSES.includes(o.status as OrderStatus))
      .map((o) => {
        const role = o.role as import('../../types').HedgeRole;
        const posSide: 'LONG' | 'SHORT' =
          role === 'SHORT' ? 'SHORT' : 'LONG';
        return {
          clientOrderId: o.clientOrderId,
          traderId: dbTrader.id,
          symbol: dbTrader.symbol,
          side: inferOrderSide(o),
          type: o.type as import('../../types').OrderType,
          role,
          hedgeLevel: o.hedgeLevel,
          quantity: o.quantity,
          filledQuantity: o.filledQuantity,
          price: o.price,
          stopPrice: o.stopPrice,
          status: o.status as OrderStatus,
          positionSide: posSide,
        };
      });

    sim.rehydrate({ positions, orders: openOrders });
  }

  private async refreshAndFillSlots(): Promise<void> {
    if (this.isPaused || this.refreshInFlight) return;
    this.refreshInFlight = true;

    try {
      this.topGainers = await withRetry(
        () => this.binanceClient.get24hTickers(),
        { maxAttempts: 3, delayMs: 2000 },
      );

      this.topGainers.sort(
        (a, b) => parseFloat(b.priceChangePercent) - parseFloat(a.priceChangePercent),
      );

      await this.broadcastSummary(true);

      const occupied = this.getOccupiedSlots();
      const slotsNeeded = this.traderConfig.maxTraders - occupied;

      if (slotsNeeded <= 0) return;

      const eligibleGainers = this.topGainers.filter((t) => this.isEligibleSymbol(t.symbol));
      log.info(`${eligibleGainers.length} eligible gainers, need ${slotsNeeded} new traders (occupied=${occupied})`);

      for (let i = 0; i < Math.min(slotsNeeded, eligibleGainers.length); i++) {
        if (this.getOccupiedSlots() >= this.traderConfig.maxTraders) break;
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
    } finally {
      this.refreshInFlight = false;
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
    if (this.getOccupiedSlots() >= this.traderConfig.maxTraders) {
      log.warn(`At max traders (${this.traderConfig.maxTraders}) — refusing ${symbol}`);
      return;
    }

    const traderId = uuidv4();
    log.info(`[LIFECYCLE] TRADER_SLOT_CREATE`, {
      traderId,
      symbol,
      occupied: this.getOccupiedSlots(),
      maxTraders: this.traderConfig.maxTraders,
    });

    const allocation = await this.accountLedger.getAllocation(
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
      this.accountLedger,
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
      log.info(`[LIFECYCLE] TRADER_SLOT_ACTIVE`, {
        traderId,
        symbol,
        occupied: this.getOccupiedSlots(),
        maxTraders: this.traderConfig.maxTraders,
      });
      await this.broadcastSummary(true);
    } catch (err) {
      log.error(`[LIFECYCLE] TRADER_SLOT_FAILED`, { traderId, symbol, error: String(err) });
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
        this.orderQueues.delete(event.traderId);
        trader.destroy();
        log.info(`[LIFECYCLE] SLOT_RELEASED`, { symbol: event.symbol, traderId: event.traderId });
        this.emit('traderEvent', event as DashboardEvent);
        void this.broadcastSummary(true);
        // Always refill immediately — bypass refreshInFlight by waiting then forcing
        if (this.isRunning && !this.isPaused) {
          // Clear in-flight gate so replacement is not deferred to next interval
          this.refreshInFlight = false;
          log.info(`[LIFECYCLE] REPLACEMENT_SEARCH`, { freedSymbol: event.symbol });
          await this.refreshAndFillSlots();
        }
        return;
      }

      if (event.type === 'FAILED') {
        this.traders.delete(event.traderId);
        this.symbolToTrader.delete(event.symbol);
        this.orderQueues.delete(event.traderId);
        trader.destroy();
      }

      this.emit('traderEvent', event as DashboardEvent);

      if (event.type === 'FAILED' || event.type === 'STATUS_CHANGED') {
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

  /** REST mark-price poll — keeps marks/PnL/sim triggers alive if WS is quiet. */
  private async pollMarkPrices(): Promise<void> {
    const symbols = [...this.symbolToTrader.keys()];
    await Promise.all(
      symbols.map(async (symbol) => {
        try {
          const price = await this.binanceClient.getMarkPrice(symbol);
          const sim = this.executionProvider as { onPriceUpdate?: (s: string, p: string) => void };
          sim.onPriceUpdate?.(symbol, price);
          this.onPriceUpdate({ symbol, price, timestamp: Date.now() });
        } catch {
          // non-fatal; next tick retries
        }
      }),
    );
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
      const unrealized = this.getTotalUnrealizedPnl();
      const openNotionals = this.getOpenNotionals();
      const openPositions = this.countOpenPositions();
      const snap = await this.accountLedger.getSnapshot({
        unrealizedPnl: unrealized,
        openNotionals,
        leverage: this.traderConfig.leverage,
      });
      const totalPnl = calcTotalPnl(snap.realizedPnl, snap.unrealizedPnl);

      const event: DashboardEvent = {
        type: 'SUMMARY',
        data: {
          balance: snap.balance,
          equity: snap.equity,
          totalPnl: totalPnl.toFixed(8),
          totalRealizedPnl: snap.realizedPnl,
          totalUnrealizedPnl: snap.unrealizedPnl,
          dailyPnl: snap.dailyPnl,
          openPositionValue: snap.openPositionValue,
          usedMargin: snap.usedMargin,
          availableMargin: snap.availableMargin,
          openPositions,
          activeTraders: this.getOccupiedSlots(),
          maxTraders: this.traderConfig.maxTraders,
          topGainers: this.topGainers.slice(0, 20),
          tradingMode: this.mode,
          botStatus: this.isPaused ? 'PAUSED' : this.isRunning ? 'RUNNING' : 'STOPPED',
        },
      };
      this.emit('traderEvent', event);
    } catch (err) {
      log.warn('Failed to broadcast summary', { error: String(err) });
    }
  }

  private getOpenNotionals(): string[] {
    const notionals: string[] = [];
    for (const t of this.traders.values()) {
      const n = t.getOpenNotional();
      if (n != null && t.isActive()) notionals.push(n);
    }
    return notionals;
  }

  private countOpenPositions(): number {
    return [...this.traders.values()].filter((t) => t.hasOpenPosition() && t.isActive()).length;
  }

  getActiveTraderCount(): number {
    return [...this.traders.values()].filter(
      (t) => t.getStatus() === 'ACTIVE' || t.getStatus() === 'INITIALIZING',
    ).length;
  }

  /** Includes in-flight initializations (symbol reserved before traders map entry). */
  getOccupiedSlots(): number {
    return this.symbolToTrader.size;
  }

  getMaxTraders(): number {
    return this.traderConfig.maxTraders;
  }

  getTraderSummary(): TraderSummaryView[] {
    return [...this.traders.values()].map((t) => t.toSummary());
  }

  /** Push every active trader snapshot to dashboard clients. */
  broadcastAllSnapshots(): void {
    for (const trader of this.traders.values()) {
      const event: DashboardEvent = { type: 'TRADER_SNAPSHOT', trader: trader.toSummary() };
      this.emit('traderEvent', event);
    }
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
