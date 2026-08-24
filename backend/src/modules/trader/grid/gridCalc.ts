/**
 * Pure directional-grid math (Decimal.js).
 * Capital MODE A: scaled (50/50 sides + L/triangular).
 * Capital MODE B: 100% of current trader capital for the single active position.
 * Per-level TP only (no stop loss) = +/− configured grid spacing % from entry.
 */
import Decimal from 'decimal.js';
import type { SymbolInfo, TradeSide } from '../../../types';
import { adjustPrice } from '../../utils/precision';
import { calcQuantityFromNotional } from '../../calc/allocation';
import { calcPositionNotional } from '../../calc/leverage';

export type GridDirection = TradeSide;

export type GridLevelStatus =
  | 'PENDING'
  | 'ACTIVE'
  | 'TP_HIT'
  | 'SL_HIT'
  | 'CANCELLED'
  | 'SKIPPED';

/** When true: triangular side-pool scaling. When false: 100% current capital, max 1 active. */
export type GridCapitalScaling = boolean;

/** Trader capital is split equally across LONG and SHORT pools (scaled mode). */
export const SIDE_CAPITAL_SPLIT = 2;
/** @deprecated alias — prefer SIDE_CAPITAL_SPLIT */
export const GRID_SIDE_PAIR_FACTOR = SIDE_CAPITAL_SPLIT;
export const DEFAULT_MAX_OPEN_POSITIONS = SIDE_CAPITAL_SPLIT;

export interface GridLevelPlan {
  level: number;
  direction: GridDirection;
  weight: number;
  allocationPct: string;
  triggerPrice: string;
  limitPrice: string;
  /** Precomputed at plan time from trigger; refreshed from actual entry on fill. No SL. */
  tpPrice: string;
  /** Always null for grid_directional (SL removed). Kept for schema/compat. */
  slPrice: string | null;
  theoreticalMargin: string;
  allocatedMargin: string;
  notional: string;
  quantity: string;
}

export interface GridPlanResult {
  startPrice: string;
  levelsPerSide: number;
  distancePercent: string;
  gridDistanceAbs: string;
  totalWeight: number;
  traderAllocation: string;
  longSideCapital: string;
  shortSideCapital: string;
  leverage: number;
  capitalScalingEnabled: boolean;
  /**
   * Scaled ON: unused (null conceptually; may echo side unit).
   * Scaled OFF: full trader capital preview (100% for the single active position) — not capital÷levels.
   */
  capitalPerLevel: string;
  totalLevels: number;
  /** Max simultaneous opens: levels*2 when scaled, 1 when not. */
  maxActivePositions: number;
  levels: GridLevelPlan[];
}

export function totalGridLevels(levelsPerSide: number): number {
  return Math.max(1, Math.floor(levelsPerSide)) * SIDE_CAPITAL_SPLIT;
}

export function triangularWeight(n: number): number {
  const levels = Math.max(1, Math.floor(n));
  return (levels * (levels + 1)) / 2;
}

/** Ascending weight: Level L weight = L (closest = smallest). Equal mode → weight 1. */
export function levelWeight(
  level: number,
  levelsPerSide: number,
  capitalScalingEnabled = true,
): number {
  if (!capitalScalingEnabled) return 1;
  const n = Math.max(1, Math.floor(levelsPerSide));
  const L = Math.min(Math.max(1, Math.floor(level)), n);
  return L;
}

/** Half of trader allocation reserved for one side (scaled mode). */
export function sideCapitalFromTrader(traderAllocation: string | Decimal): Decimal {
  return Decimal.max(new Decimal(0), new Decimal(traderAllocation)).div(SIDE_CAPITAL_SPLIT);
}

/**
 * Fraction of capital for level L.
 * Scaled ON: of **side** capital → L / triangular(N)
 * Scaled OFF: full current trader capital (entry opportunity, not a reserved slice) → 1
 */
export function levelAllocationFraction(
  level: number,
  levelsPerSide: number,
  capitalScalingEnabled = true,
): Decimal {
  const n = Math.max(1, Math.floor(levelsPerSide));
  if (!capitalScalingEnabled) {
    return new Decimal(1);
  }
  const total = triangularWeight(n);
  if (total <= 0) return new Decimal(0);
  return new Decimal(levelWeight(level, n, true)).div(total);
}

/**
 * Margin for a level.
 * Scaled ON: sideCapital × (L / triangular(N))
 * Scaled OFF: pool is treated as **current trader capital** → 100% of pool
 */
export function calculatePositionAllocation(
  pool: string | Decimal,
  level: number,
  levelsPerSide: number,
  capitalScalingEnabled = true,
): Decimal {
  const capital = Decimal.max(new Decimal(0), new Decimal(pool));
  if (!capitalScalingEnabled) {
    return capital;
  }
  return capital.mul(levelAllocationFraction(level, levelsPerSide, true));
}

/**
 * @deprecated Equal-split was an incorrect OFF-mode formula.
 * OFF mode uses 100% of current trader capital for the single active position.
 * Kept for any external callers; prefer calculatePositionAllocation(..., false).
 */
export function equalCapitalPerLevel(
  traderAllocation: string | Decimal,
  levelsPerSide: number,
): Decimal {
  const total = totalGridLevels(levelsPerSide);
  return Decimal.max(new Decimal(0), new Decimal(traderAllocation)).div(total);
}

export function calcGridDistanceAbs(
  startPrice: string | Decimal,
  distancePercent: string | number,
): Decimal {
  return new Decimal(startPrice).mul(new Decimal(distancePercent).div(100)).abs();
}

export function inferGridDistanceAbsFromTriggers(
  levels: Array<{ level: number; direction: string; triggerPrice: string }>,
): Decimal | null {
  for (const direction of ['LONG', 'SHORT']) {
    const side = levels
      .filter((l) => l.direction === direction)
      .sort((a, b) => a.level - b.level);
    if (side.length < 2) continue;
    const a = new Decimal(side[0]!.triggerPrice);
    const b = new Decimal(side[1]!.triggerPrice);
    const step = a.minus(b).abs();
    if (step.gt(0)) return step;
  }
  return null;
}

export function resolveGridDistanceAbs(params: {
  levels?: Array<{ level: number; direction: string; triggerPrice: string }>;
  startPrice?: string | Decimal | null;
  distancePercent?: string | number | null;
  storedAbs?: string | Decimal | null;
}): Decimal {
  if (params.levels != null && params.levels.length > 0) {
    const inferred = inferGridDistanceAbsFromTriggers(params.levels);
    if (inferred != null) return inferred;
  }
  if (params.storedAbs != null && new Decimal(params.storedAbs).gt(0)) {
    return new Decimal(params.storedAbs).abs();
  }
  if (params.startPrice != null && params.distancePercent != null) {
    return calcGridDistanceAbs(params.startPrice, params.distancePercent);
  }
  throw new Error('Cannot resolve gridDistanceAbs: no levels, storedAbs, or start/percent');
}

/**
 * Grid orientation (normal directional):
 * LONG entries BELOW start; SHORT entries ABOVE start.
 * LONG L: start × (1 − spacing×L)
 * SHORT L: start × (1 + spacing×L)
 */
export function calcGridTriggerPrice(
  startPrice: string | Decimal,
  level: number,
  direction: GridDirection,
  distancePercent: string | number,
): Decimal {
  const start = new Decimal(startPrice);
  const L = Math.max(1, Math.floor(level));
  const dist = new Decimal(distancePercent).div(100);
  const factor = direction === 'LONG'
    ? new Decimal(1).minus(dist.mul(L))
    : new Decimal(1).plus(dist.mul(L));
  const px = start.mul(factor);
  if (px.lte(0)) {
    throw new Error(`Grid trigger non-positive for ${direction} L${L}: ${px.toFixed()}`);
  }
  return px;
}

/**
 * Per-level TP from entry using grid spacing % (NO stop loss).
 * LONG:  TP = entry×(1+s)  → TP > entry
 * SHORT: TP = entry×(1−s)  → TP < entry
 */
export function calcLevelTpPrice(
  entryPrice: string | Decimal,
  direction: GridDirection,
  spacingPercent: string | number,
  symbolInfo: SymbolInfo,
): string {
  const entry = new Decimal(entryPrice);
  const pct = new Decimal(spacingPercent).div(100);
  const tpRaw = direction === 'LONG'
    ? entry.mul(new Decimal(1).plus(pct))
    : entry.mul(new Decimal(1).minus(pct));
  if (tpRaw.lte(0)) {
    throw new Error(
      `TP non-positive for ${direction} entry=${entry.toFixed()} spacing=${spacingPercent}`,
    );
  }
  const tpPrice = adjustPrice(tpRaw, symbolInfo);
  assertDirectionalTp(direction, entryPrice, tpPrice);
  return tpPrice;
}

/**
 * @deprecated Grid strategy has no SL — returns slPrice=null.
 * Prefer calcLevelTpPrice.
 */
export function calcLevelTpSlPrices(
  entryPrice: string | Decimal,
  direction: GridDirection,
  spacingPercent: string | number,
  symbolInfo: SymbolInfo,
): { tpPrice: string; slPrice: string | null } {
  return {
    tpPrice: calcLevelTpPrice(entryPrice, direction, spacingPercent, symbolInfo),
    slPrice: null,
  };
}

/** True when TP respects normal directional invariant relative to entry (no SL). */
export function isValidDirectionalTp(
  direction: GridDirection,
  entryPrice: string | Decimal,
  tpPrice: string | Decimal,
): boolean {
  const entry = new Decimal(entryPrice);
  const tp = new Decimal(tpPrice);
  return direction === 'LONG' ? tp.gt(entry) : tp.lt(entry);
}

export function assertDirectionalTp(
  direction: GridDirection,
  entryPrice: string | Decimal,
  tpPrice: string | Decimal,
): void {
  if (!isValidDirectionalTp(direction, entryPrice, tpPrice)) {
    throw new Error(
      `Invalid ${direction} TP: entry=${new Decimal(entryPrice).toFixed()} `
      + `tp=${new Decimal(tpPrice).toFixed()}`,
    );
  }
}

/** @deprecated Use isValidDirectionalTp — SL removed from grid. */
export function isValidDirectionalTpSl(
  direction: GridDirection,
  entryPrice: string | Decimal,
  tpPrice: string | Decimal,
  _slPrice?: string | Decimal | null,
): boolean {
  return isValidDirectionalTp(direction, entryPrice, tpPrice);
}

/** @deprecated Use assertDirectionalTp. */
export function assertDirectionalTpSl(
  direction: GridDirection,
  entryPrice: string | Decimal,
  tpPrice: string | Decimal,
  _slPrice?: string | Decimal | null,
): void {
  assertDirectionalTp(direction, entryPrice, tpPrice);
}

/** @deprecated Absolute-step TP for compat — prefer percent-based calcLevelTpPrice. */
export function calcLevelTpPriceFromAbs(
  entryPrice: string | Decimal,
  direction: GridDirection,
  gridDistanceAbs: string | Decimal,
  symbolInfo: SymbolInfo,
): string {
  const entry = new Decimal(entryPrice);
  const step = new Decimal(gridDistanceAbs).abs();
  const raw = direction === 'LONG' ? entry.plus(step) : entry.minus(step);
  if (raw.lte(0)) {
    throw new Error(`TP non-positive for ${direction} entry=${entry.toFixed()}`);
  }
  return adjustPrice(raw, symbolInfo);
}

/**
 * Final grid boundary destroy (strict past the last level).
 * LONG side (below start): destroy when mark < lastLongLevel.
 * SHORT side (above start): destroy when mark > lastShortLevel.
 * Touching the final level (==) does NOT destroy.
 */
export function isPastFinalLongLevel(
  markPrice: string | Decimal,
  lastLongLevel: string | Decimal,
): boolean {
  return new Decimal(markPrice).lt(new Decimal(lastLongLevel));
}

export function isPastFinalShortLevel(
  markPrice: string | Decimal,
  lastShortLevel: string | Decimal,
): boolean {
  return new Decimal(markPrice).gt(new Decimal(lastShortLevel));
}

/**
 * Informational display bounds (last level ± spacing) — NOT destroy triggers.
 * Destroy uses isPastFinalLongLevel / isPastFinalShortLevel on the last triggers.
 */
export function getUpperGridExhaustionPrice(
  lastHighestLevel: string | Decimal,
  gridSpacingPercent: string | number,
): Decimal {
  const last = new Decimal(lastHighestLevel);
  const pct = new Decimal(gridSpacingPercent).div(100);
  return last.mul(new Decimal(1).plus(pct));
}

export function getLowerGridExhaustionPrice(
  lastLowestLevel: string | Decimal,
  gridSpacingPercent: string | number,
): Decimal {
  const last = new Decimal(lastLowestLevel);
  const pct = new Decimal(gridSpacingPercent).div(100);
  const out = last.mul(new Decimal(1).minus(pct));
  if (out.lte(0)) {
    throw new Error(`Lower bound non-positive for last=${last.toFixed()} spacing=${gridSpacingPercent}`);
  }
  return out;
}

export function isPricePastUpperExhaustion(
  price: string | Decimal,
  lastHighestLevel: string | Decimal,
  gridSpacingPercent: string | number,
): boolean {
  return new Decimal(price).gt(getUpperGridExhaustionPrice(lastHighestLevel, gridSpacingPercent));
}

export function isPricePastLowerExhaustion(
  price: string | Decimal,
  lastLowestLevel: string | Decimal,
  gridSpacingPercent: string | number,
): boolean {
  return new Decimal(price).lt(getLowerGridExhaustionPrice(lastLowestLevel, gridSpacingPercent));
}

/**
 * Limit price for planned entries.
 * LONG dip (BUY): limit at/below trigger; SHORT rally (SELL): limit at/above trigger.
 */
export function calcGridLimitPrice(
  triggerPrice: string,
  direction: GridDirection,
  symbolInfo: SymbolInfo,
): string {
  let limit = adjustPrice(triggerPrice, symbolInfo);
  const stop = new Decimal(triggerPrice);
  const lim = new Decimal(limit);
  const tick = new Decimal(symbolInfo.tickSize);
  if (direction === 'LONG' && lim.gt(stop)) {
    limit = adjustPrice(Decimal.max(tick, stop.minus(tick)), symbolInfo);
  } else if (direction === 'SHORT' && lim.lt(stop)) {
    limit = adjustPrice(stop.plus(tick), symbolInfo);
  }
  return limit;
}

export function buildGridLevelPrices(
  startPrice: string,
  levelsPerSide: number,
  distancePercent: string | number,
  symbolInfo: SymbolInfo,
  capitalScalingEnabled = true,
): Array<{
  level: number;
  direction: GridDirection;
  triggerPrice: string;
  limitPrice: string;
  tpPrice: string;
  slPrice: string | null;
  weight: number;
  allocationPct: string;
}> {
  const n = Math.max(1, Math.floor(levelsPerSide));
  const startAdj = adjustPrice(startPrice, symbolInfo);
  const out: Array<{
    level: number;
    direction: GridDirection;
    triggerPrice: string;
    limitPrice: string;
    tpPrice: string;
    slPrice: string | null;
    weight: number;
    allocationPct: string;
  }> = [];
  for (const direction of ['LONG', 'SHORT'] as GridDirection[]) {
    for (let level = 1; level <= n; level++) {
      const raw = calcGridTriggerPrice(startAdj, level, direction, distancePercent);
      const triggerPrice = adjustPrice(raw, symbolInfo);
      const limitPrice = calcGridLimitPrice(triggerPrice, direction, symbolInfo);
      const { tpPrice, slPrice } = calcLevelTpSlPrices(
        triggerPrice,
        direction,
        distancePercent,
        symbolInfo,
      );
      const frac = levelAllocationFraction(level, n, capitalScalingEnabled);
      out.push({
        level,
        direction,
        triggerPrice,
        limitPrice,
        tpPrice,
        slPrice,
        weight: levelWeight(level, n, capitalScalingEnabled),
        allocationPct: frac.toFixed(8),
      });
    }
  }
  return out;
}

export function buildGridPlan(params: {
  startPrice: string;
  traderAllocation: string | Decimal;
  leverage: number;
  levelsPerSide: number;
  distancePercent: string | number;
  symbolInfo: SymbolInfo;
  /** Default true — preserve triangular scaling. */
  capitalScalingEnabled?: boolean;
}): GridPlanResult {
  const n = Math.max(1, Math.floor(params.levelsPerSide));
  const scaling = params.capitalScalingEnabled !== false;
  const allocation = new Decimal(params.traderAllocation);
  const longSide = sideCapitalFromTrader(allocation);
  const shortSide = sideCapitalFromTrader(allocation);
  const lev = Math.max(1, params.leverage);
  const startAdj = adjustPrice(params.startPrice, params.symbolInfo);
  const distAbs = calcGridDistanceAbs(startAdj, params.distancePercent);
  const priceRows = buildGridLevelPrices(
    startAdj,
    n,
    params.distancePercent,
    params.symbolInfo,
    scaling,
  );

  const levels: GridLevelPlan[] = [];
  for (const row of priceRows) {
    // Scaled ON: triangular from side pool. Scaled OFF: 100% trader capital (entry opportunity; actual size at activate uses currentCapital).
    const theoreticalMargin = scaling
      ? calculatePositionAllocation(
        row.direction === 'LONG' ? longSide : shortSide,
        row.level,
        n,
        true,
      )
      : allocation;
    const theoreticalNotional = calcPositionNotional(theoreticalMargin, lev);
    let quantity: string;
    try {
      quantity = calcQuantityFromNotional(theoreticalNotional, row.triggerPrice, params.symbolInfo);
    } catch {
      quantity = '0';
    }
    const qty = new Decimal(quantity);
    const notional = qty.mul(row.triggerPrice);
    const allocatedMargin = lev > 0 ? notional.div(lev) : notional;
    levels.push({
      level: row.level,
      direction: row.direction,
      weight: row.weight,
      allocationPct: row.allocationPct,
      triggerPrice: row.triggerPrice,
      limitPrice: row.limitPrice,
      tpPrice: row.tpPrice,
      slPrice: row.slPrice,
      theoreticalMargin: theoreticalMargin.toFixed(8),
      allocatedMargin: allocatedMargin.toFixed(8),
      notional: notional.toFixed(8),
      quantity,
    });
  }

  return {
    startPrice: startAdj,
    levelsPerSide: n,
    distancePercent: String(params.distancePercent),
    gridDistanceAbs: distAbs.toFixed(8),
    totalWeight: scaling ? triangularWeight(n) : totalGridLevels(n),
    traderAllocation: allocation.toFixed(8),
    longSideCapital: longSide.toFixed(8),
    shortSideCapital: shortSide.toFixed(8),
    leverage: lev,
    capitalScalingEnabled: scaling,
    // OFF: show full capital (100% active), never capital÷levels
    capitalPerLevel: scaling ? '0' : allocation.toFixed(8),
    totalLevels: totalGridLevels(n),
    maxActivePositions: scaling ? totalGridLevels(n) : 1,
    levels,
  };
}

export function sizeLevelPosition(params: {
  /** Side capital pool when capitalScalingEnabled=true. */
  sideCapital?: string | Decimal;
  /**
   * Current trader capital when capitalScalingEnabled=false.
   * Active position receives 100% of this amount (not divided by level count).
   */
  currentTraderCapital?: string | Decimal;
  /** @deprecated alias for currentTraderCapital / sideCapital */
  traderAllocation?: string | Decimal;
  /** @deprecated use sideCapital */
  currentCapital?: string | Decimal;
  level: number;
  levelsPerSide: number;
  leverage: number;
  entryPrice: string;
  symbolInfo: SymbolInfo;
  capitalScalingEnabled?: boolean;
}): { allocatedMargin: string; notional: string; quantity: string; weight: number; allocationPct: string } {
  const scaling = params.capitalScalingEnabled !== false;
  const lev = Math.max(1, params.leverage);
  const weight = levelWeight(params.level, params.levelsPerSide, scaling);
  let margin: Decimal;
  let frac: Decimal;
  if (!scaling) {
    // MODE B: 100% of current trader capital — grid levels are entry opportunities only
    margin = Decimal.max(
      new Decimal(0),
      new Decimal(
        params.currentTraderCapital
        ?? params.traderAllocation
        ?? params.currentCapital
        ?? params.sideCapital
        ?? '0',
      ),
    );
    frac = new Decimal(1);
  } else {
    // MODE A: existing triangular side-pool scaling (unchanged)
    const pool = params.sideCapital ?? params.currentCapital ?? '0';
    frac = levelAllocationFraction(params.level, params.levelsPerSide, true);
    margin = calculatePositionAllocation(pool, params.level, params.levelsPerSide, true);
  }
  const theoreticalNotional = calcPositionNotional(margin, lev);
  let quantity: string;
  try {
    quantity = calcQuantityFromNotional(theoreticalNotional, params.entryPrice, params.symbolInfo);
  } catch {
    quantity = '0';
  }
  const notional = new Decimal(quantity).mul(params.entryPrice);
  const allocatedMargin = lev > 0 ? notional.div(lev) : notional;
  return {
    allocatedMargin: allocatedMargin.toFixed(8),
    notional: notional.toFixed(8),
    quantity,
    weight,
    allocationPct: frac.toFixed(8),
  };
}

export function traderProfitPercent(
  netProfit: string | Decimal,
  traderAllocation: string | Decimal,
): Decimal {
  const alloc = new Decimal(traderAllocation);
  if (alloc.isZero()) return new Decimal(0);
  return new Decimal(netProfit).div(alloc).mul(100);
}

export function calcTraderTpTarget(
  initialCapital: string | Decimal,
  takeProfitPercent: string | Decimal,
): Decimal {
  return new Decimal(initialCapital).mul(new Decimal(takeProfitPercent)).div(100);
}

export function isTraderTpReached(
  netPnl: string | Decimal,
  initialCapital: string | Decimal,
  takeProfitPercent: string | Decimal,
): boolean {
  const target = calcTraderTpTarget(initialCapital, takeProfitPercent);
  if (target.lte(0)) return false;
  return new Decimal(netPnl).gte(target);
}

export function isLevelTerminal(status: string): boolean {
  return status === 'TP_HIT' || status === 'SL_HIT' || status === 'CANCELLED' || status === 'SKIPPED';
}

/** @deprecated Exhaustion no longer destroys traders; retained for counts/display. */
export function isLevelExhaustionCounted(status: string): boolean {
  return status === 'ACTIVE' || status === 'TP_HIT';
}

export function isLevelTpComplete(status: string): boolean {
  return status === 'TP_HIT';
}

/** True when every grid level has individually hit TP (SL does not count). */
export function allGridLevelsHitTp(statuses: string[]): boolean {
  if (statuses.length === 0) return false;
  return statuses.every((s) => s === 'TP_HIT');
}

/**
 * LONG (below start): eligible when mark is at/below trigger (dip entry).
 * SHORT (above start): eligible when mark is at/above trigger (rally entry).
 * Does not require exact equality — gaps count.
 */
export function isEntryTriggered(
  direction: TradeSide,
  markPrice: string | Decimal,
  triggerPrice: string | Decimal,
): boolean {
  const mark = new Decimal(markPrice);
  const trigger = new Decimal(triggerPrice);
  return direction === 'LONG' ? mark.lte(trigger) : mark.gte(trigger);
}

/**
 * Detect that mark moved through a trigger between previous and current.
 * LONG: downward cross (was above trigger, now at/below).
 * SHORT: upward cross (was below trigger, now at/above).
 */
export function didCrossEntry(
  direction: TradeSide,
  previousPrice: string | Decimal,
  currentPrice: string | Decimal,
  triggerPrice: string | Decimal,
): boolean {
  const prev = new Decimal(previousPrice);
  const curr = new Decimal(currentPrice);
  const trigger = new Decimal(triggerPrice);
  if (direction === 'LONG') {
    return curr.lte(trigger) && prev.gt(trigger);
  }
  return curr.gte(trigger) && prev.lt(trigger);
}

/**
 * List PENDING levels whose entry is satisfied by mark.
 * mark < start → LONG side; mark > start → SHORT side.
 */
export function findTriggeredPendingLevels<T extends {
  direction: TradeSide;
  status: string;
  triggerPrice: string;
  level: number;
  clientOrderId?: string | null;
}>(
  levels: T[],
  markPrice: string | Decimal,
  startPrice: string | Decimal,
): T[] {
  const mark = new Decimal(markPrice);
  const start = new Decimal(startPrice);
  const side: TradeSide | null = mark.lt(start) ? 'LONG' : mark.gt(start) ? 'SHORT' : null;
  if (side == null) return [];
  return levels
    .filter((l) => l.direction === side && l.status === 'PENDING' && l.clientOrderId == null)
    .filter((l) => isEntryTriggered(side, mark, l.triggerPrice))
    .sort((a, b) => a.level - b.level);
}

/**
 * Binance MARK_PRICE stop semantics for protective exits.
 * LONG close = SELL: TP when mark >= tp, SL when mark <= sl
 * SHORT close = BUY: TP when mark <= tp, SL when mark >= sl
 */
export function isTpTriggeredByMark(
  direction: TradeSide,
  markPrice: string | Decimal,
  tpPrice: string | Decimal,
): boolean {
  const mark = new Decimal(markPrice);
  const tp = new Decimal(tpPrice);
  return direction === 'LONG' ? mark.gte(tp) : mark.lte(tp);
}

export function isSlTriggeredByMark(
  direction: TradeSide,
  markPrice: string | Decimal,
  slPrice: string | Decimal,
): boolean {
  const mark = new Decimal(markPrice);
  const sl = new Decimal(slPrice);
  return direction === 'LONG' ? mark.lte(sl) : mark.gte(sl);
}
