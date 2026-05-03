/**
 * Grid + Hedge bot — type definitions for the state machine.
 *
 * Strict, exhaustive types. No indicators referenced anywhere — all decisions
 * derive from price structure (recent highs/lows) and live mid-price.
 */

export const BotState = {
  GRID: 'GRID',
  HEDGE: 'HEDGE',
  RESET: 'RESET',
} as const;
export type BotState = (typeof BotState)[keyof typeof BotState];

/** A single grid level with its placed order (if any) and any open position
 * opened from a fill at that level. */
export interface GridLevel {
  /** Level price (already quantized to symbol tickSize when placed). */
  price: number;
  /** BUY level (below mid at build time) or SELL level (above mid). */
  side: 'BUY' | 'SELL';
  /** Open clientOrderId for the entry, or null if no open order at this level. */
  entryOrderId: string | null;
  /** Open clientOrderId for the corresponding TP, or null. */
  tpOrderId: string | null;
  /** Take-profit target price (next level in the profit direction). */
  tpPrice: number;
  /** True once filled — i.e. position open at this level awaiting TP. */
  filled: boolean;
  /** Realized fill price + qty (for accounting). */
  filledPrice: number;
  filledQty: number;
}

export interface GridPosition {
  /** levelPrice — links back to the originating GridLevel. */
  levelPrice: number;
  side: 'LONG' | 'SHORT';
  size: number;
  entryPrice: number;
  tpPrice: number;
  openedAt: number;
}

export interface HedgePosition {
  side: 'LONG' | 'SHORT';
  size: number;
  entryPrice: number;
  openedAt: number;
  /** clientOrderId of the entry market order. */
  orderId: string;
}

export type GridEventType =
  | 'STATE_CHANGE'
  | 'RANGE_BUILT'
  | 'GRID_PLACED'
  | 'GRID_FILLED'
  | 'GRID_TP_FILLED'
  | 'BREAKOUT_DETECTED'
  | 'HEDGE_OPENED'
  | 'HEDGE_CLOSED'
  | 'TREND_CONFIRMED'
  | 'FAKE_BREAKOUT'
  | 'CHOP_DETECTED'
  | 'RESET_TRIGGERED'
  | 'COOLDOWN_DONE'
  | 'ERROR';

export interface GridEvent {
  ts: number;
  symbol: string;
  type: GridEventType;
  msg: string;
  data?: Record<string, unknown>;
}

export interface DebugSnapshot {
  symbol: string;
  state: BotState;
  upperBand: number;
  lowerBand: number;
  currentPrice: number;
  rangePercent: number;
  breakoutDetected: boolean;
  breakoutDirection: 'UP' | 'DOWN' | null;
  hedgeActive: boolean;
  netPosition: number;
  openLongPositions: number;
  openShortPositions: number;
  totalOpenPositions: number;
  hedge: HedgePosition | null;
  positions: GridPosition[];
  levels: GridLevel[];
  cooldownRemainingMs: number;
  lastTransitionAt: number;
  recentEvents: GridEvent[];
}
