import { CONFIG } from '../core/config.js';
import { Channels, TradeReason } from '../core/constants.js';
import { sleep } from '../utils/time.js';
import { scoped } from '../utils/logger.js';
import { publish } from './redis.service.js';
import { MarketDataService } from './marketData.service.js';
import { SymbolUniverseService } from './symbolUniverse.service.js';
import {
  GridEngine,
  type IGridExecutionAdapter,
  type FillRecord,
  type PlaceOrderArgs,
} from './gridEngine.service.js';
import { GridStateModel } from '../models/gridState.model.js';
import type { IExecutionService } from './execution/execution.interface.js';
import { TestExecutionService } from './execution/testExecution.service.js';
import { env } from '../core/env.js';

const log = scoped('GRID-ORCH');

export interface GridOrchestratorState {
  shuttingDown: boolean;
  lastUniverseAt: number;
  lastLoopAt: number;
  selected: string[];
}

/**
 * Drives N per-symbol GridEngines. Replaces the legacy mean-reversion
 * Orchestrator. Loop responsibilities:
 *   1. periodically refresh symbol universe (top-N USDT by 24h vol)
 *   2. update market subscriptions (bookTicker + grid timeframe candles)
 *   3. on every loop tick: call engine.tick() per symbol
 *   4. fan out fills from the executor into the right engine
 *   5. enforce kill switch (flatten all)
 */
export class GridOrchestrator {
  private readonly state: GridOrchestratorState = {
    shuttingDown: false,
    lastUniverseAt: 0,
    lastLoopAt: 0,
    selected: [],
  };

  private readonly engines = new Map<string, GridEngine>();
  private fillUnsub: (() => void) | null = null;

  constructor(
    private readonly market: MarketDataService,
    private readonly universe: SymbolUniverseService,
    private readonly execution: IExecutionService,
  ) {}

  getState(): Readonly<GridOrchestratorState> {
    return this.state;
  }

  /** All current per-symbol engine snapshots (for the dashboard). */
  snapshots(): ReturnType<GridEngine['snapshot']>[] {
    return [...this.engines.values()].map((e) => e.snapshot());
  }

  getEngine(symbol: string): GridEngine | undefined {
    return this.engines.get(symbol);
  }

  shutdown(): void {
    this.state.shuttingDown = true;
  }

  async run(): Promise<void> {
    await this.execution.reconcile();

    // Route fills to the right engine.
    this.fillUnsub = this.execution.onFill((ev) => {
      const eng = this.engines.get(ev.symbol);
      if (!eng) return;
      if (
        ev.purpose !== 'GRID' &&
        ev.purpose !== 'GRID_TP' &&
        ev.purpose !== 'HEDGE' &&
        ev.purpose !== 'HEDGE_CLOSE'
      ) {
        return;
      }
      const f: FillRecord = {
        clientOrderId: ev.clientOrderId,
        symbol: ev.symbol,
        side: ev.side,
        qty: ev.qty,
        price: ev.price,
        fee: ev.fee,
        ts: ev.ts,
        purpose: ev.purpose,
      };
      void eng.onFill(f);
    });

    while (!this.state.shuttingDown) {
      const cfg = CONFIG();
      this.state.lastLoopAt = Date.now();

      if (cfg.killSwitch) {
        await this.flattenAll(TradeReason.KILL_SWITCH);
        await sleep(cfg.loop.intervalMs);
        continue;
      }

      try {
        // Universe refresh on schedule (use the existing scanner interval).
        if (Date.now() - this.state.lastUniverseAt >= cfg.loop.scannerIntervalMs) {
          const selected = await this.universe.select().catch((e) => {
            log.error({ err: (e as Error).message }, 'universe failed');
            return null;
          });
          if (selected) {
            this.state.selected = selected;
            this.state.lastUniverseAt = Date.now();
            this.syncEngines(selected);
            // Subscribe bookTicker + grid timeframe candles for each.
            const subs = selected.map((s) => ({ symbol: s, interval: cfg.grid.timeframe }));
            this.market.setSubscriptions(subs);
            // Pre-warm the candle buffers.
            for (const sym of selected) {
              await this.market
                .warmCandles(sym, cfg.grid.timeframe, Math.max(cfg.grid.lookback * 2, 60))
                .catch(() => undefined);
            }
          }
        }

        // Tick each engine once per loop.
        for (const [, eng] of this.engines) {
          await eng.tick();
          if (this.state.shuttingDown) break;
        }

        // Snapshot for dashboard / pubsub.
        const bal = await this.execution.getBalance();
        void publish(Channels.BALANCE_UPDATED, bal);
      } catch (e) {
        log.error({ err: (e as Error).message, stack: (e as Error).stack }, 'loop error');
      }

      await sleep(cfg.loop.intervalMs);
    }

    log.info('shutting down — flattening positions');
    await this.flattenAll(TradeReason.SHUTDOWN);
    this.fillUnsub?.();
  }

  private syncEngines(symbols: string[]): void {
    const want = new Set(symbols);
    // Remove stale.
    for (const [sym, eng] of [...this.engines]) {
      if (!want.has(sym)) {
        void eng.flattenAll('symbol_dropped');
        this.engines.delete(sym);
      }
    }
    // Add new.
    for (const sym of symbols) {
      if (this.engines.has(sym)) continue;
      this.engines.set(sym, this.buildEngine(sym));
      log.info({ symbol: sym }, 'engine_attached');
    }
  }

  private buildEngine(symbol: string): GridEngine {
    const adapter = this.buildAdapter();
    return new GridEngine({
      symbol,
      exec: adapter,
      getCurrentPrice: () => {
        const bt = this.market.getBookTicker(symbol);
        if (!bt) return null;
        return (bt.bidPrice + bt.askPrice) / 2;
      },
      getCandles: () => this.market.getCandles(symbol, CONFIG().grid.timeframe),
      persist: async (snap) => {
        await GridStateModel.updateOne(
          { symbol, mode: env.MODE },
          {
            $set: {
              symbol,
              mode: env.MODE,
              state: snap.state,
              upperBand: snap.upperBand,
              lowerBand: snap.lowerBand,
              rangePercent: snap.rangePercent,
              currentPrice: snap.currentPrice,
              breakoutDetected: snap.breakoutDetected,
              breakoutDirection: snap.breakoutDirection,
              hedgeActive: snap.hedgeActive,
              netPosition: snap.netPosition,
              openLongPositions: snap.openLongPositions,
              openShortPositions: snap.openShortPositions,
              totalOpenPositions: snap.totalOpenPositions,
              hedge: snap.hedge,
              positions: snap.positions,
              levels: snap.levels,
              cooldownUntil: Date.now() + snap.cooldownRemainingMs,
              lastTransitionAt: snap.lastTransitionAt,
              recentEvents: snap.recentEvents.slice(-25),
            },
          },
          { upsert: true },
        );
      },
    });
  }

  private buildAdapter(): IGridExecutionAdapter {
    const exec = this.execution;
    const market = this.market;
    return {
      placeOrder: async (args: PlaceOrderArgs) => {
        await exec.placeOrder({
          clientOrderId: args.clientOrderId,
          symbol: args.symbol,
          side: args.side,
          positionSide: args.positionSide,
          type: args.type,
          qty: args.qty,
          ...(args.price !== undefined && { price: args.price }),
          ...(args.reduceOnly !== undefined && { reduceOnly: args.reduceOnly }),
          purpose: args.purpose,
        });
      },
      cancelOrder: async (sym, cid) => exec.cancelOrder(sym, cid),
      creditRealizedPnl: async (args) => {
        if (exec instanceof TestExecutionService) {
          await exec.creditRealizedPnl(args);
        }
        // Live mode: realized PnL is tracked by the exchange; nothing to do.
      },
      symbolFilters: (symbol) => {
        const info = market.getSymbolInfo(symbol);
        return {
          tickSize: info?.filters.tickSize ?? 0.01,
          stepSize: info?.filters.stepSize ?? 0.001,
          minNotional: info?.filters.minNotional ?? 5,
        };
      },
    };
  }

  private async flattenAll(reason: string): Promise<void> {
    for (const eng of this.engines.values()) {
      await eng.flattenAll(reason).catch((e) => log.error({ err: (e as Error).message }, 'flatten failed'));
    }
  }
}
