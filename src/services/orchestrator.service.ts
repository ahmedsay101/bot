import { CONFIG } from '../core/config.js';
import { Side, OrderType, TradeReason, Channels } from '../core/constants.js';
import { sleep } from '../utils/time.js';
import { scoped } from '../utils/logger.js';
import { publish } from './redis.service.js';
import { MarketDataService } from './marketData.service.js';
import { SymbolScannerService } from './symbolScanner.service.js';
import { evaluate } from './strategy.service.js';
import { RiskManager } from './riskManager.service.js';
import { PortfolioService } from './portfolio.service.js';
import { SetupService, sideToSetupType, type Setup } from './setup.service.js';
import { newClientOrderId, TestExecutionService } from './execution/index.js';
import type { IExecutionService } from './execution/execution.interface.js';

const log = scoped('ORCH');

/** Snapshot of the last decision for a symbol — surfaced via /debug. */
export interface SymbolEvaluation {
  symbol: string;
  ts: number;
  regime: string;
  rsi: number;            // 1m RSI
  rsi15m: number;         // RSI from the setup that created the opportunity
  slope: number;
  atr: number;            // raw ATR (price units)
  atrPercent: number;     // normalized: ATR / price * 100
  signal: string;          // OPEN | CLOSE | HOLD
  side?: 'LONG' | 'SHORT';
  reason: string;
  hasPosition: boolean;
  /** Trade-ready: active setup + RSI extreme on 1m. */
  eligible: boolean;
  status: 'WAITING' | 'SIGNAL' | 'EXECUTED' | 'REJECTED';
  rejectReason?: string;
  // Setup engine state (15m → 1m sequential signal):
  setupType: 'LONG' | 'SHORT' | 'NONE';
  setupAgeMs: number;
  setupExpiresInMs: number;
  setupStatus: 'NONE' | 'ACTIVE' | 'EXPIRED' | 'TRIGGERED' | 'COOLDOWN';
  cooldownRemainingMs: number;
}

export interface OrchestratorState {
  shuttingDown: boolean;
  lastScanAt: number;
  lastLoopAt: number;
  selected: string[];
}

export class Orchestrator {
  private readonly state: OrchestratorState = {
    shuttingDown: false,
    lastScanAt: 0,
    lastLoopAt: 0,
    selected: [],
  };

  /** Per-symbol last evaluation (for /debug + dashboard panel). */
  private readonly lastEvaluations = new Map<string, SymbolEvaluation>();

  constructor(
    private readonly market: MarketDataService,
    private readonly scanner: SymbolScannerService,
    private readonly risk: RiskManager,
    private readonly portfolio: PortfolioService,
    private readonly execution: IExecutionService,
    private readonly setups: SetupService,
  ) {}

  getState(): Readonly<OrchestratorState> {
    return this.state;
  }

  /** All cached per-symbol evaluations, newest first. */
  getLastEvaluations(): SymbolEvaluation[] {
    return [...this.lastEvaluations.values()].sort((a, b) => b.ts - a.ts);
  }

  /** Setup + cooldown snapshot for the /debug endpoint. */
  getSetupSnapshot(): ReturnType<SetupService['snapshot']> {
    return this.setups.snapshot();
  }

  shutdown(): void {
    this.state.shuttingDown = true;
  }

  async run(): Promise<void> {
    await this.execution.reconcile();

    while (!this.state.shuttingDown) {
      const cfg = CONFIG();
      this.state.lastLoopAt = Date.now();

      // Kill switch — flatten everything
      if (cfg.killSwitch) {
        await this.flattenAll(TradeReason.KILL_SWITCH);
        await sleep(cfg.loop.intervalMs);
        continue;
      }

      try {
        // Periodic scan
        if (Date.now() - this.state.lastScanAt >= cfg.loop.scannerIntervalMs) {
          const result = await this.scanner.run();
          this.state.selected = result.selected;
          this.state.lastScanAt = Date.now();

          // Update market subscriptions: bookTicker for all selected, kline for both intervals
          const subs = result.selected.flatMap((s) => [
            { symbol: s, interval: cfg.timeframes.strategy },
            { symbol: s, interval: cfg.timeframes.scanner },
          ]);
          this.market.setSubscriptions(subs);
        }

        // Allocate margin
        const balance = (await this.execution.getBalance()).balance;
        const allocation = this.portfolio.allocate(this.state.selected, balance);

        // Per-symbol decision loop
        for (const symbol of this.state.selected) {
          await this.processSymbol(symbol, allocation.marginPerSymbol);
          if (this.state.shuttingDown) break;
        }

        // Snapshot
        const bal = await this.execution.getBalance();
        await this.portfolio.snapshot(bal);
        void publish(Channels.BALANCE_UPDATED, bal);
      } catch (e) {
        log.error({ err: (e as Error).message, stack: (e as Error).stack }, 'loop error');
      }

      await sleep(cfg.loop.intervalMs);
    }
    log.info('shutting down — flattening positions');
    await this.flattenAll(TradeReason.SHUTDOWN);
  }

  // -----------------------------------------------------------------------

  private async processSymbol(symbol: string, marginAllocated: number): Promise<void> {
    const cfg = CONFIG();
    const candles = await this.market.warmCandles(symbol, cfg.timeframes.strategy, 200);
    const position = await this.execution.getPosition(symbol);
    const setup: Setup | null = this.setups.getActive(symbol);
    const cooldownMs = this.setups.cooldownRemaining(symbol);

    const evalResult = evaluate({
      candles,
      hasOpenPosition: !!position,
      setup,
      ...(position && { positionSide: position.side }),
    });

    // ----- Decision cache + structured debug log -----
    const lastClose = candles.length ? (candles[candles.length - 1] as { close: number }).close : NaN;
    const atrRaw = evalResult.regime.atr;
    const atrPct =
      Number.isFinite(atrRaw) && Number.isFinite(lastClose) && lastClose > 0
        ? (atrRaw / lastClose) * 100
        : NaN;

    // Eligibility: active setup + 1m RSI in matching trigger band + no position.
    const rsiTriggered =
      Number.isFinite(evalResult.rsi) &&
      setup != null &&
      ((setup.type === 'LONG' && evalResult.rsi < cfg.thresholds.rsi1mTriggerLong) ||
        (setup.type === 'SHORT' && evalResult.rsi > cfg.thresholds.rsi1mTriggerShort));
    const eligible = !position && cooldownMs === 0 && rsiTriggered;

    const now = Date.now();
    let setupStatus: SymbolEvaluation['setupStatus'] = 'NONE';
    if (cooldownMs > 0) setupStatus = 'COOLDOWN';
    else if (setup) setupStatus = rsiTriggered ? 'TRIGGERED' : 'ACTIVE';

    const baseEval: SymbolEvaluation = {
      symbol,
      ts: now,
      regime: evalResult.regime.regime,
      rsi: Number.isFinite(evalResult.rsi) ? Number(evalResult.rsi.toFixed(4)) : NaN,
      rsi15m: setup ? Number(setup.rsiAtCreate.toFixed(4)) : NaN,
      slope: Number.isFinite(evalResult.regime.slope) ? Number(evalResult.regime.slope.toFixed(6)) : NaN,
      atr: Number.isFinite(atrRaw) ? Number(atrRaw.toFixed(6)) : NaN,
      atrPercent: Number.isFinite(atrPct) ? Number(atrPct.toFixed(4)) : NaN,
      signal: evalResult.signal.kind,
      reason: 'reason' in evalResult.signal ? evalResult.signal.reason : '',
      hasPosition: !!position,
      eligible,
      status: 'WAITING',
      setupType: setup ? setup.type : 'NONE',
      setupAgeMs: setup ? now - setup.createdAt : 0,
      setupExpiresInMs: setup ? Math.max(0, setup.expiresAt - now) : 0,
      setupStatus,
      cooldownRemainingMs: cooldownMs,
    };
    if (evalResult.signal.kind === 'OPEN') {
      baseEval.side = evalResult.signal.side === Side.LONG ? 'LONG' : 'SHORT';
      baseEval.status = 'SIGNAL';
    }

    const recordAndLog = (extra?: Partial<SymbolEvaluation>): void => {
      const merged: SymbolEvaluation = { ...baseEval, ...extra };
      this.lastEvaluations.set(symbol, merged);
      if (cfg.debug || merged.status === 'EXECUTED' || merged.status === 'REJECTED') {
        log.info(
          {
            symbol: merged.symbol,
            regime: merged.regime,
            rsi: merged.rsi,
            slope: merged.slope,
            atrPct: merged.atrPercent,
            signal: merged.signal,
            side: merged.side,
            eligible: merged.eligible,
            hasPosition: merged.hasPosition,
            status: merged.status,
            reason: merged.reason,
            rejectReason: merged.rejectReason,
          },
          'decision',
        );
      }
    };

    if (evalResult.signal.kind === 'HOLD') {
      recordAndLog();
      return;
    }

    if (evalResult.signal.kind === 'CLOSE') {
      try {
        await this.closePosition(symbol, evalResult.signal.reason);
        recordAndLog({ status: 'EXECUTED' });
      } catch (e) {
        recordAndLog({ status: 'REJECTED', rejectReason: (e as Error).message });
      }
      return;
    }

    // OPEN
    if (position) {
      recordAndLog({ status: 'REJECTED', rejectReason: 'already_in_position' });
      return;
    }
    if (cooldownMs > 0) {
      recordAndLog({
        status: 'REJECTED',
        rejectReason: `cooldown_${Math.ceil(cooldownMs / 1000)}s`,
      });
      return;
    }
    const sizing = this.risk.size({
      symbol,
      side: evalResult.signal.side,
      entryPrice: evalResult.signal.price,
      atrValue: evalResult.signal.atr,
      marginAllocated,
      symbolInfo: this.market.getSymbolInfo(symbol),
    });
    if (!sizing) {
      recordAndLog({ status: 'REJECTED', rejectReason: 'sizing_rejected' });
      return;
    }

    const entryReq = {
      clientOrderId: newClientOrderId('e'),
      symbol,
      side: (evalResult.signal.side === Side.LONG ? 'BUY' : 'SELL') as 'BUY' | 'SELL',
      positionSide: evalResult.signal.side,
      type: OrderType.MARKET,
      qty: sizing.qty,
      reduceOnly: false,
      purpose: 'ENTRY' as const,
    };
    log.info({ symbol, side: evalResult.signal.side, qty: sizing.qty }, 'entering');
    try {
      await this.execution.placeOrder(entryReq);
    } catch (e) {
      recordAndLog({ status: 'REJECTED', rejectReason: (e as Error).message });
      return;
    }

    // CRITICAL: recompute SL/TP from the *actual* fill price, not signal.price.
    // The signal price is the previous candle close — for low-priced or
    // low-ATR symbols (e.g. BSBUSDT at $0.70 with 0.0001 ATR) the gap between
    // candle close and live book mid can exceed tpAtrMultiple*ATR, which
    // would put TP BELOW entry for a LONG and trigger an instant fake
    // "take_profit" loss. Pull the actual entryPrice off the position the
    // executor just opened and rebuild stops from there.
    const filledPos = await this.execution.getPosition(symbol);
    const realEntry = filledPos?.entryPrice ?? evalResult.signal.price;
    const realStops = this.risk.computeStops(
      evalResult.signal.side,
      realEntry,
      evalResult.signal.atr,
      this.market.getSymbolInfo(symbol),
    );
    if (!realStops) {
      // Sanity guard: refuse to leave the position with stale/invalid stops.
      log.error(
        { symbol, realEntry, atr: evalResult.signal.atr },
        'invalid stops after fill — flattening immediately',
      );
      try {
        await this.closePosition(symbol, 'invalid_stops');
      } catch (e) {
        log.error({ err: (e as Error).message }, 'flatten after invalid_stops failed');
      }
      recordAndLog({ status: 'REJECTED', rejectReason: 'invalid_stops_after_fill' });
      this.setups.consume(symbol);
      return;
    }
    log.info(
      {
        symbol,
        signalPrice: evalResult.signal.price,
        actualEntry: realEntry,
        sl: realStops.stopPrice,
        tp: realStops.takeProfitPrice,
        atr: evalResult.signal.atr,
      },
      'stops_attached',
    );

    // Attach SL/TP — implementation differs:
    //  - test mode: stops are tracked in-memory by the simulator
    //  - live mode: place STOP_MARKET + TAKE_PROFIT_MARKET reduce-only orders
    if (this.execution instanceof TestExecutionService) {
      await this.execution.attachStops(symbol, realStops.stopPrice, realStops.takeProfitPrice);
    } else {
      const closeSide: 'BUY' | 'SELL' = evalResult.signal.side === Side.LONG ? 'SELL' : 'BUY';
      await this.execution.placeOrder({
        clientOrderId: newClientOrderId('sl'),
        symbol,
        side: closeSide,
        positionSide: evalResult.signal.side,
        type: OrderType.STOP_MARKET,
        qty: sizing.qty,
        stopPrice: realStops.stopPrice,
        reduceOnly: true,
        purpose: 'SL',
      });
      await this.execution.placeOrder({
        clientOrderId: newClientOrderId('tp'),
        symbol,
        side: closeSide,
        positionSide: evalResult.signal.side,
        type: OrderType.TAKE_PROFIT_MARKET,
        qty: sizing.qty,
        stopPrice: realStops.takeProfitPrice,
        reduceOnly: true,
        purpose: 'TP',
      });
    }

    // Setup consumed: invalidate + start cooldown so we don't immediately
    // re-enter on the same setup if RSI stays below the trigger.
    this.setups.consume(symbol);
    void sideToSetupType; // imported for type re-export

    recordAndLog({ status: 'EXECUTED' });
  }

  private async closePosition(symbol: string, reason: string): Promise<void> {
    const pos = await this.execution.getPosition(symbol);
    if (!pos) return;
    const side: 'BUY' | 'SELL' = pos.side === Side.LONG ? 'SELL' : 'BUY';
    log.info({ symbol, reason }, 'closing position');
    await this.execution.placeOrder({
      clientOrderId: newClientOrderId('x'),
      symbol,
      side,
      positionSide: pos.side,
      type: OrderType.MARKET,
      qty: pos.size,
      reduceOnly: true,
      purpose: 'EXIT',
    });
  }

  private async flattenAll(reason: string): Promise<void> {
    const positions = await this.execution.getAllPositions();
    for (const p of positions) {
      await this.closePosition(p.symbol, reason);
    }
  }
}
