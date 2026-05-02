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
import { newClientOrderId, TestExecutionService } from './execution/index.js';
import type { IExecutionService } from './execution/execution.interface.js';

const log = scoped('ORCH');

/** Snapshot of the last decision for a symbol — surfaced via /debug. */
export interface SymbolEvaluation {
  symbol: string;
  ts: number;
  regime: string;
  rsi: number;
  slope: number;
  atr: number;
  signal: string;          // OPEN | CLOSE | HOLD
  side?: 'LONG' | 'SHORT';
  reason: string;
  hasPosition: boolean;
  status: 'WAITING' | 'SIGNAL' | 'EXECUTED' | 'REJECTED';
  rejectReason?: string;
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
  ) {}

  getState(): Readonly<OrchestratorState> {
    return this.state;
  }

  /** All cached per-symbol evaluations, newest first. */
  getLastEvaluations(): SymbolEvaluation[] {
    return [...this.lastEvaluations.values()].sort((a, b) => b.ts - a.ts);
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

    const evalResult = evaluate({
      candles,
      hasOpenPosition: !!position,
      ...(position && { positionSide: position.side }),
    });

    // ----- Decision cache + structured debug log -----
    const baseEval: SymbolEvaluation = {
      symbol,
      ts: Date.now(),
      regime: evalResult.regime.regime,
      rsi: Number.isFinite(evalResult.rsi) ? Number(evalResult.rsi.toFixed(4)) : NaN,
      slope: Number.isFinite(evalResult.regime.slope) ? Number(evalResult.regime.slope.toFixed(6)) : NaN,
      atr: Number.isFinite(evalResult.regime.atr) ? Number(evalResult.regime.atr.toFixed(6)) : NaN,
      signal: evalResult.signal.kind,
      reason: 'reason' in evalResult.signal ? evalResult.signal.reason : '',
      hasPosition: !!position,
      status: 'WAITING',
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
            signal: merged.signal,
            side: merged.side,
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

    // Attach SL/TP — implementation differs:
    //  - test mode: stops are tracked in-memory by the simulator
    //  - live mode: place STOP_MARKET + TAKE_PROFIT_MARKET reduce-only orders
    if (this.execution instanceof TestExecutionService) {
      await this.execution.attachStops(symbol, sizing.stopPrice, sizing.takeProfitPrice);
    } else {
      const closeSide: 'BUY' | 'SELL' = evalResult.signal.side === Side.LONG ? 'SELL' : 'BUY';
      await this.execution.placeOrder({
        clientOrderId: newClientOrderId('sl'),
        symbol,
        side: closeSide,
        positionSide: evalResult.signal.side,
        type: OrderType.STOP_MARKET,
        qty: sizing.qty,
        stopPrice: sizing.stopPrice,
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
        stopPrice: sizing.takeProfitPrice,
        reduceOnly: true,
        purpose: 'TP',
      });
    }

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
