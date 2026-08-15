/**
 * Rolling 24-hour account balance high/low (Decimal.js only).
 * Uses wallet/account balance — never equity or unrealized PnL.
 */
import Decimal from 'decimal.js';

export const BALANCE_HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface BalanceHistoryPoint {
  recordedAt: Date | number;
  balance: string | Decimal;
}

export interface BalanceRange24h {
  currentBalance: string;
  highestBalance24h: string;
  lowestBalance24h: string;
}

function toMs(t: Date | number): number {
  return typeof t === 'number' ? t : t.getTime();
}

/**
 * Rolling window: [now − 24h, now] (inclusive start).
 * A snapshot at exactly now−24h is included; anything older is excluded
 * from high/low (even as a carry-forward — see acceptance: 25h-old $300 must not affect).
 *
 * high/low = max/min over currentBalance and all snapshots with recordedAt >= windowStart.
 */
export function calcBalanceRange24h(
  currentBalance: string | Decimal,
  history: BalanceHistoryPoint[],
  nowMs: number = Date.now(),
): BalanceRange24h {
  const current = new Decimal(currentBalance);
  const windowStart = nowMs - BALANCE_HISTORY_WINDOW_MS;

  let high = current;
  let low = current;

  for (const point of history) {
    const ts = toMs(point.recordedAt);
    if (ts < windowStart || ts > nowMs) continue;
    const bal = new Decimal(point.balance);
    high = Decimal.max(high, bal);
    low = Decimal.min(low, bal);
  }

  return {
    currentBalance: current.toFixed(8),
    highestBalance24h: high.toFixed(8),
    lowestBalance24h: low.toFixed(8),
  };
}

/**
 * Decide which history rows to delete after computing the range.
 * Keeps: all points in [windowStart, ∞) plus the single newest point before windowStart (anchor).
 */
export function selectExpiredBalanceSnapshotIds(
  history: Array<{ id: string; recordedAt: Date | number }>,
  nowMs: number = Date.now(),
): string[] {
  const windowStart = nowMs - BALANCE_HISTORY_WINDOW_MS;
  const sorted = [...history].sort((a, b) => toMs(a.recordedAt) - toMs(b.recordedAt));
  const before = sorted.filter((p) => toMs(p.recordedAt) < windowStart);
  if (before.length <= 1) return [];
  // Keep newest before window; delete older anchors
  return before.slice(0, -1).map((p) => p.id);
}
