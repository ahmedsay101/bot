import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { GridDirectionalTrader } from '../trader/grid/GridDirectionalTrader';
import { NearPriceDirectionalTrader } from '../trader/near-price/NearPriceDirectionalTrader';
import type { IManagedTrader } from '../trader/IManagedTrader';
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
} from '../../types';
import { calcTotalPnl } from '../calc/allocation';
import { createContextLogger } from '../logger';
import { withRetry } from '../utils/retry';
import { explainTopGainerSelection } from './poolSelection';
import type { PrismaClient } from '@prisma/client';

const log = createContextLogger('TraderManager');

const LEVERAGED_TOKEN_SUFFIXES = ['UP', 'DOWN', 'BEAR', 'BULL', '2L', '2S', '3L', '3S'];
/** Skip symbols that failed create recently so the same broken top-gainer cannot block the slot forever. */
const CREATE_FAIL_COOLDOWN_MS = 60_000;

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
  private traders = new Map<string, IManagedTrader>();
  private symbolToTrader = new Map<string, string>();
  private topGainers: Ticker24h[] = [];
  /** Retained for dashboard API shape — no longer populated by a creation gate. */
  private trendCandidates: unknown[] = [];
  /** Symbols currently mid-create (prevents duplicate concurrent creates). */
  private pendingCreates = new Set<string>();
  /** symbol → last failed create timestamp (ms). */
  private recentCreateFailures = new Map<string, number>();
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

    await this.reconcileTraderPool();

    this.refreshTimer = setInterval(() => {
      void this.reconcileTraderPool();
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
      'traderLifetimeHours',
      'gridLevelsPerSide', 'gridDistancePercent', 'gridCapitalScalingEnabled',
      'traderTakeProfitPercent', 'traderMaxLifetimeHours',
      'refreshInterval', 'retryLimit', 'feeRate', 'makerFeeRate', 'takerFeeRate', 'slippage',
    ] as const;
    for (const k of keys) {
      if (k in patch && patch[k] != null) cfg[k] = patch[k];
    }
    // Keep feeRate ↔ takerFeeRate in sync for hot-apply / legacy clients
    if (patch.takerFeeRate != null) cfg.feeRate = patch.takerFeeRate;
    else if (patch.feeRate != null) cfg.takerFeeRate = patch.feeRate;
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
        const behavior = (dbTrader as { behavior?: string | null }).behavior
          ?? this.traderConfig.traderBehavior
          ?? 'grid_directional';
        if (behavior !== 'grid_directional' && behavior !== 'near_price_directional') {
          await this.retireNonGridTrader(dbTrader);
          continue;
        }

        const orders = dbTrader.orders;
        const trader: IManagedTrader = behavior === 'near_price_directional'
          ? new NearPriceDirectionalTrader(
            dbTrader.id,
            dbTrader.symbol,
            dbTrader.mode as TraderMode,
            this.executionProvider,
            this.traderConfig,
            this.db,
            this.accountLedger,
          )
          : new GridDirectionalTrader(
            dbTrader.id,
            dbTrader.symbol,
            dbTrader.mode as TraderMode,
            this.executionProvider,
            this.traderConfig,
            this.db,
            this.accountLedger,
          );

        let gridLevels: unknown[] = [];
        try {
          const gridApi = (this.db as any).gridLevel;
          if (gridApi?.findMany != null) {
            gridLevels = await gridApi.findMany({
              where: { traderId: dbTrader.id },
              orderBy: [{ direction: 'asc' }, { level: 'asc' }],
            });
          }
        } catch (err) {
          log.warn(`Failed loading grid levels for ${dbTrader.id}`, { error: String(err) });
        }

        const openPositions = await this.db.position.findMany({
          where: { traderId: dbTrader.id, isOpen: true },
        });
        const openWithOrderIds = openPositions.map((p) => {
          const match = orders.find(
            (o) =>
              o.hedgeLevel === p.hedgeLevel
              && (o.role === p.side || (o.role === 'HEDGE' && p.side === 'LONG'))
              && o.status === 'FILLED'
              && (o.type === 'STOP_LIMIT' || o.type === 'STOP_MARKET'),
          );
          return { ...p, clientOrderId: match?.clientOrderId ?? null, entryFee: null as string | null };
        });

        const pendingClientOrderIds = orders
          .filter((o) => OPEN_ORDER_STATUSES.includes(o.status as OrderStatus))
          .map((o) => o.clientOrderId);
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

        const dbAny = dbTrader as typeof dbTrader & {
          behavior?: string | null;
          startPrice?: string | null;
          gridLevelsPerSide?: number | null;
          gridDistancePercent?: string | null;
          traderTakeProfitPercent?: string | null;
          exitReason?: string | null;
        };

        await trader.restore({
          status: dbTrader.status as import('../../types').TraderStatus,
          realizedPnl: dbTrader.realizedPnl,
          unrealizedPnl: dbTrader.unrealizedPnl,
          startedAt: dbTrader.startedAt,
          endsAt: dbTrader.endsAt,
          startPrice: dbAny.startPrice ?? '0',
          levelsPerSide: dbAny.gridLevelsPerSide ?? this.traderConfig.gridLevelsPerSide ?? 10,
          distancePercent: dbAny.gridDistancePercent ?? this.traderConfig.gridDistancePercent ?? '2',
          takeProfitPercent:
            dbAny.traderTakeProfitPercent ?? this.traderConfig.traderTakeProfitPercent ?? '10',
          traderAllocatedAmount: dbTrader.traderAllocatedAmount,
          currentCapital: (dbTrader as any).currentCapital ?? dbTrader.traderAllocatedAmount,
          currentSide: dbTrader.currentSide,
          entryPrice: dbTrader.entryPrice,
          tpPrice: dbTrader.tpPrice,
          slPrice: dbTrader.slPrice,
          quantity: dbTrader.quantity,
          takeProfits: dbTrader.takeProfits,
          stopLosses: dbTrader.stopLosses,
          longFilled: (gridLevels as Array<{ status: string; direction: string }>).filter(
            (l) => (l.status === 'TP_HIT' || l.status === 'SL_HIT' || l.status === 'FILLED') && l.direction === 'LONG',
          ).length,
          shortFilled: (gridLevels as Array<{ status: string; direction: string }>).filter(
            (l) => (l.status === 'TP_HIT' || l.status === 'SL_HIT' || l.status === 'FILLED') && l.direction === 'SHORT',
          ).length,
          exitReason: dbAny.exitReason ?? dbTrader.completionReason,
          positionsOpened: dbTrader.positionsOpened,
          positionsClosed: dbTrader.positionsClosed,
          winningPositions: dbTrader.winningPositions,
          losingPositions: dbTrader.losingPositions,
          longPositions: dbTrader.longPositions,
          shortPositions: dbTrader.shortPositions,
          totalFees: dbTrader.totalFees,
          timelineJson: dbTrader.timelineJson,
          pendingClientOrderIds,
          orderViews,
          gridLevels,
          openPositions: openWithOrderIds,
          currentPositionNumber: dbTrader.currentPositionNumber,
        });

        // Rebuild sim conditional book so TP/SL continue to fire after restart
        const sim = this.executionProvider as {
          isSimulation?: boolean;
          rehydrate?: (p: {
            positions: Array<{
              symbol: string;
              side: 'LONG' | 'SHORT';
              entryPrice: string;
              quantity: string;
              leverage?: number;
            }>;
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
          getSymbolInfo?: (s: string) => Promise<unknown>;
        };
        if (sim.isSimulation && typeof sim.rehydrate === 'function') {
          try {
            await sim.getSymbolInfo?.(dbTrader.symbol);
          } catch { /* non-fatal */ }
          sim.rehydrate({
            positions: openPositions.map((p) => ({
              symbol: dbTrader.symbol,
              side: p.side as 'LONG' | 'SHORT',
              entryPrice: p.entryPrice,
              quantity: p.quantity,
              leverage: p.leverage,
            })),
            orders: orders
              .filter((o) => OPEN_ORDER_STATUSES.includes(o.status as OrderStatus))
              .map((o) => ({
                clientOrderId: o.clientOrderId,
                traderId: dbTrader.id,
                symbol: dbTrader.symbol,
                side: inferOrderSide(o),
                type: o.type as import('../../types').OrderType,
                role: o.role as import('../../types').HedgeRole,
                hedgeLevel: o.hedgeLevel,
                quantity: o.quantity,
                filledQuantity: o.filledQuantity,
                price: o.price,
                stopPrice: o.stopPrice,
                status: o.status as OrderStatus,
                positionSide: (o as { positionSide?: 'LONG' | 'SHORT' | 'BOTH' }).positionSide,
              })),
          });
        }

        this.wireTraderEvents(trader);
        this.traders.set(trader.getId(), trader);
        this.symbolToTrader.set(dbTrader.symbol, trader.getId());

        if (dbTrader.status === 'COMPLETING') {
          await trader.resumeCompleting();
        }

        log.info(`Restored grid trader ${trader.getId()} for ${dbTrader.symbol}`);
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

  /**
   * Grid-only branch: flatten exchange exposure for legacy reversal traders, then mark COMPLETED.
   * Prevents orphaned Binance orders/positions while a new grid trader may reclaim the symbol.
   */
  private async retireNonGridTrader(dbTrader: { id: string; symbol: string }): Promise<void> {
    log.warn(
      `Retiring non-grid trader ${dbTrader.id} (${dbTrader.symbol}) with exchange cleanup — this branch is grid-only`,
    );

    try {
      await this.executionProvider.cancelAllOrders(dbTrader.symbol);
    } catch (err) {
      log.warn(`cancelAllOrders failed while retiring ${dbTrader.symbol}`, { error: String(err) });
    }

    try {
      const positions = await this.executionProvider.getPositions(dbTrader.symbol);
      for (const pos of positions) {
        const qty = new Decimal(pos.quantity).abs();
        if (qty.lte(0)) continue;
        try {
          await this.executionProvider.closePosition(
            dbTrader.symbol,
            pos.side as 'LONG' | 'SHORT',
            qty.toFixed(),
          );
        } catch (err) {
          log.error(`closePosition failed while retiring ${dbTrader.symbol}`, {
            side: pos.side,
            error: String(err),
          });
        }
      }
    } catch (err) {
      log.warn(`getPositions failed while retiring ${dbTrader.symbol}`, { error: String(err) });
    }

    try {
      await this.db.order.updateMany({
        where: { traderId: dbTrader.id, status: { in: OPEN_ORDER_STATUSES } },
        data: { status: 'CANCELED' },
      });
      await this.db.position.updateMany({
        where: { traderId: dbTrader.id, isOpen: true },
        data: { isOpen: false, closedAt: new Date() },
      });
      await this.db.trader.update({
        where: { id: dbTrader.id },
        data: {
          status: 'COMPLETED',
          completionReason: 'legacy_reversal_skipped',
          completedAt: new Date(),
        },
      });
    } catch (err) {
      log.error(`DB cleanup failed while retiring ${dbTrader.id}`, { error: String(err) });
      await this.db.trader.update({
        where: { id: dbTrader.id },
        data: { status: 'FAILED', completionReason: 'legacy_reversal_cleanup_failed' },
      }).catch(() => {});
    }
  }

  /**
   * SSOT for trader-pool management (NO trend gate).
   * 1) Fetch top gainers (TOP_GAINERS_LIMIT)
   * 2) Filter structural / occupied / blocked / pending
   * 3) Create until activeTraders === MAX_TRADERS or no eligible symbols remain
   * refreshInFlight serializes concurrent scans (no over-creation).
   */
  async reconcileTraderPool(): Promise<void> {
    if (this.isPaused || this.refreshInFlight) return;
    this.refreshInFlight = true;
    const scanStarted = Date.now();

    try {
      let tickers: Ticker24h[];
      try {
        tickers = await withRetry(
          () => this.binanceClient.get24hTickers(),
          { maxAttempts: 3, delayMs: 2000 },
        );
      } catch (err) {
        log.error('Binance top-gainer fetch failed — keeping current trader pool', {
          error: String(err),
        });
        return;
      }

      tickers.sort(
        (a, b) => parseFloat(b.priceChangePercent) - parseFloat(a.priceChangePercent),
      );
      const limit = Math.max(1, this.traderConfig.topGainersLimit ?? 50);
      this.topGainers = tickers.slice(0, limit);
      this.trendCandidates = [];
      await this.broadcastSummary(true);

      const occupied = new Set(this.symbolToTrader.keys());
      const availableSlots = Math.max(0, this.traderConfig.maxTraders - occupied.size);
      const now = Date.now();
      for (const [sym, ts] of this.recentCreateFailures) {
        if (now - ts > CREATE_FAIL_COOLDOWN_MS) this.recentCreateFailures.delete(sym);
      }

      log.info('[LIFECYCLE] TOP_GAINER_SCAN', {
        maxTraders: this.traderConfig.maxTraders,
        activeTraders: occupied.size,
        availableSlots,
        topGainers: this.topGainers.slice(0, 15).map((t, i) => `${i + 1}. ${t.symbol} ${t.priceChangePercent}%`),
        pendingCreates: [...this.pendingCreates],
        durationMs: Date.now() - scanStarted,
      });

      if (availableSlots <= 0) {
        log.info('[LIFECYCLE] TARGET_REACHED — no creates', {
          occupied: occupied.size,
          maxTraders: this.traderConfig.maxTraders,
        });
        return;
      }

      // Walk highest→lowest gainers until slots full; never stop at first N rejects.
      const rankedSymbols = this.topGainers.map((t) => t.symbol);
      const preview = explainTopGainerSelection({
        rankedSymbols,
        maxTraders: this.traderConfig.maxTraders,
        occupiedSymbols: occupied,
        blockedSymbols: this.recentCreateFailures.size > 0
          ? new Set(this.recentCreateFailures.keys())
          : undefined,
        skipSymbols: this.pendingCreates,
        isValidSymbol: (s) => this.isStructurallyValidSymbol(s),
      });

      for (const d of preview.decisions) {
        if (d.action === 'skip') {
          log.info('[LIFECYCLE] TOP_GAINER_CANDIDATE', {
            candidate: d.symbol,
            skipped: d.reason,
          });
        }
      }

      if (preview.selected.length === 0) {
        log.warn('[LIFECYCLE] NO_ELIGIBLE_TOP_GAINERS', {
          availableSlots: preview.slotsNeeded,
          scanned: rankedSymbols.length,
          occupied: occupied.size,
          decisions: preview.decisions.slice(0, 30),
        });
        return;
      }

      // Create one-by-one; on failure continue to next ranked candidate (same scan).
      for (const symbol of rankedSymbols) {
        if (this.getOccupiedSlots() >= this.traderConfig.maxTraders) {
          log.info('[LIFECYCLE] TARGET_REACHED', {
            activeTraders: this.getOccupiedSlots(),
            maxTraders: this.traderConfig.maxTraders,
          });
          break;
        }
        if (this.symbolToTrader.has(symbol)) continue;
        if (this.pendingCreates.has(symbol)) continue;
        if (!this.isStructurallyValidSymbol(symbol)) continue;
        const failAt = this.recentCreateFailures.get(symbol);
        if (failAt != null && Date.now() - failAt < CREATE_FAIL_COOLDOWN_MS) continue;

        this.pendingCreates.add(symbol);
        try {
          log.info('[LIFECYCLE] TOP_GAINER_CANDIDATE', {
            candidate: symbol,
            selected: true,
            occupied: this.getOccupiedSlots(),
            maxTraders: this.traderConfig.maxTraders,
          });
          const ok = await this.createTrader(symbol);
          if (ok) {
            log.info('[LIFECYCLE] CREATING_TRADER_OK', {
              symbol,
              activeTraders: this.getOccupiedSlots(),
              maxTraders: this.traderConfig.maxTraders,
            });
          } else {
            this.recentCreateFailures.set(symbol, Date.now());
            log.warn('[LIFECYCLE] CREATING_TRADER_FAILED — trying next candidate', { symbol });
          }
        } catch (err) {
          this.recentCreateFailures.set(symbol, Date.now());
          log.error(`Failed to create trader for ${symbol}`, { error: String(err) });
        } finally {
          this.pendingCreates.delete(symbol);
        }
      }

      if (this.getOccupiedSlots() < this.traderConfig.maxTraders) {
        log.warn('[LIFECYCLE] SLOTS_REMAIN_UNFILLED', {
          activeTraders: this.getOccupiedSlots(),
          maxTraders: this.traderConfig.maxTraders,
          scanned: rankedSymbols.length,
        });
      } else {
        log.info('[LIFECYCLE] TARGET_REACHED', {
          activeTraders: this.getOccupiedSlots(),
          maxTraders: this.traderConfig.maxTraders,
        });
      }
    } catch (err) {
      log.error('Error reconciling trader pool', { error: String(err) });
    } finally {
      this.refreshInFlight = false;
    }
  }

  /** @deprecated use reconcileTraderPool */
  private async refreshAndFillSlots(): Promise<void> {
    await this.reconcileTraderPool();
  }

  /** Structural filters only (USDT, non-leveraged) — does not check occupied. */
  private isStructurallyValidSymbol(symbol: string): boolean {
    if (isLeveragedToken(symbol)) return false;
    if (!symbol.endsWith('USDT')) return false;
    return true;
  }

  private isEligibleSymbol(symbol: string): boolean {
    if (this.symbolToTrader.has(symbol)) return false;
    return this.isStructurallyValidSymbol(symbol);
  }

  private async createTrader(symbol: string): Promise<boolean> {
    if (this.symbolToTrader.has(symbol)) {
      log.warn(`Attempted to create duplicate trader for ${symbol}`);
      return false;
    }
    if (this.getOccupiedSlots() >= this.traderConfig.maxTraders) {
      log.warn(`At max traders (${this.traderConfig.maxTraders}) — refusing ${symbol}`);
      return false;
    }
    if (!this.isStructurallyValidSymbol(symbol)) {
      log.warn(`Symbol structurally invalid — refusing ${symbol}`);
      return false;
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

    const behavior = this.traderConfig.traderBehavior ?? 'grid_directional';
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
        behavior,
        gridLevelsPerSide: this.traderConfig.gridLevelsPerSide ?? 10,
        gridDistancePercent: behavior === 'near_price_directional'
          ? (this.traderConfig.gridSpacingPercent ?? this.traderConfig.gridDistancePercent ?? '2')
          : (this.traderConfig.gridDistancePercent ?? '2'),
        traderTakeProfitPercent: this.traderConfig.traderTakeProfitPercent ?? '10',
      } as any,
    });

    const trader: IManagedTrader = behavior === 'near_price_directional'
      ? new NearPriceDirectionalTrader(
        dbTrader.id,
        symbol,
        this.mode,
        this.executionProvider,
        this.traderConfig,
        this.db,
        this.accountLedger,
      )
      : new GridDirectionalTrader(
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
      return true;
    } catch (err) {
      log.error(`[LIFECYCLE] TRADER_SLOT_FAILED`, { traderId, symbol, error: String(err) });
      this.symbolToTrader.delete(symbol);
      this.wsManager.unsubscribe(`${symbol.toLowerCase()}@markPrice@1s`).catch(() => {});
      await this.db.trader.update({
        where: { id: traderId },
        data: { status: 'FAILED' },
      });
      return false;
    }
  }

  private wireTraderEvents(trader: IManagedTrader): void {
    trader.on('traderEvent', async (event: { type: string; traderId: string; symbol?: string; reason?: string; error?: string; status?: string; trader?: TraderSummaryView }) => {
      if (event.type === 'COMPLETED') {
        this.traders.delete(event.traderId);
        if (event.symbol != null) this.symbolToTrader.delete(event.symbol);
        this.orderQueues.delete(event.traderId);
        trader.destroy();
        log.info(`[LIFECYCLE] SLOT_RELEASED`, {
          symbol: event.symbol,
          traderId: event.traderId,
          reason: event.reason,
        });
        this.emit('traderEvent', event as DashboardEvent);
        void this.broadcastSummary(true);
        if (this.isRunning && !this.isPaused) {
          this.refreshInFlight = false;
          log.info(`[LIFECYCLE] REPLACEMENT_SEARCH`, {
            freedSymbol: event.symbol,
            reason: event.reason,
          });
          await this.reconcileTraderPool();
        }
        return;
      }

      if (event.type === 'FAILED') {
        this.traders.delete(event.traderId);
        if (event.symbol != null) this.symbolToTrader.delete(event.symbol);
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
    // Always feed simulation book (server also listens; duplicate evaluate is idempotent)
    const sim = this.executionProvider as { onPriceUpdate?: (s: string, p: string) => void; isSimulation?: boolean };
    if (sim.isSimulation && typeof sim.onPriceUpdate === 'function') {
      sim.onPriceUpdate(update.symbol, update.price);
    }
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
          trendCandidates: this.trendCandidates as any,
          tradingMode: this.mode,
          botStatus: this.isPaused ? 'PAUSED' : this.isRunning ? 'RUNNING' : 'STOPPED',
          traderBehavior: this.traderConfig.traderBehavior ?? 'grid_directional',
          currentBalance: snap.currentBalance ?? snap.balance,
          highestBalance24h: snap.highestBalance24h ?? snap.balance,
          lowestBalance24h: snap.lowestBalance24h ?? snap.balance,
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
    return [...this.traders.values()]
      .filter((t) => t.isActive())
      .reduce((n, t) => n + t.getOpenLegCount(), 0);
  }

  /** Open filled legs across active traders (grid may have many per symbol). */
  getOpenPositionCount(): number {
    return this.countOpenPositions();
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
