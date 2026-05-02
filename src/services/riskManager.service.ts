import { CONFIG } from '../core/config.js';
import { Side } from '../core/constants.js';
import { quantize, stepDecimals, round } from '../utils/math.js';
import type { ExchangeSymbolInfo } from '../api/binance.rest.js';

export interface SizingInput {
  symbol: string;
  side: Side;
  entryPrice: number;
  atrValue: number;
  marginAllocated: number;
  symbolInfo: ExchangeSymbolInfo | undefined;
}

export interface SizingResult {
  qty: number;
  notional: number;
  margin: number;
  leverage: number;
  stopPrice: number;
  takeProfitPrice: number;
  liquidationPrice: number;
  riskUsdt: number;
}

const MAINTENANCE_MARGIN_RATE = 0.004; // approximate, USDT-M tier 1

export class RiskManager {
  /** Compute stop and TP prices, then size position so loss-at-stop ≈ riskPerTrade × marginAllocated. */
  size(input: SizingInput): SizingResult | null {
    const cfg = CONFIG();
    const { side, entryPrice, atrValue, marginAllocated, symbolInfo } = input;

    if (!isFinite(entryPrice) || entryPrice <= 0) return null;
    if (!isFinite(atrValue) || atrValue <= 0) return null;

    const slDist = atrValue * cfg.exits.slAtrMultiple;
    const tpDist = atrValue * cfg.exits.tpAtrMultiple;
    const stopPrice =
      side === Side.LONG ? entryPrice - slDist : entryPrice + slDist;
    const takeProfitPrice =
      side === Side.LONG ? entryPrice + tpDist : entryPrice - tpDist;

    if (stopPrice <= 0) return null;

    const tickSize = symbolInfo?.filters.tickSize ?? 0.01;
    const stepSize = symbolInfo?.filters.stepSize ?? 0.001;
    const minQty = symbolInfo?.filters.minQty ?? 0;
    const minNotional = symbolInfo?.filters.minNotional ?? 5;

    const stopRounded = roundToTick(stopPrice, tickSize);
    const tpRounded = roundToTick(takeProfitPrice, tickSize);
    const entryRounded = roundToTick(entryPrice, tickSize);

    const riskUsdt = marginAllocated * cfg.trading.riskPerTrade;
    const perUnitRisk = Math.abs(entryRounded - stopRounded);
    if (perUnitRisk <= 0) return null;

    let qty = riskUsdt / perUnitRisk;
    qty = quantize(qty, stepSize);
    if (qty < minQty || qty <= 0) return null;

    const notional = qty * entryRounded;
    if (notional < minNotional) return null;

    const leverage = cfg.trading.leverage;
    const requiredMargin = notional / leverage;
    if (requiredMargin > marginAllocated) {
      // Cap by available margin
      const maxNotional = marginAllocated * leverage;
      qty = quantize(maxNotional / entryRounded, stepSize);
      if (qty < minQty || qty * entryRounded < minNotional) return null;
    }

    const liquidationPrice = computeLiquidationPrice(side, entryRounded, leverage);

    return {
      qty,
      notional: round(qty * entryRounded, 8),
      margin: round((qty * entryRounded) / leverage, 8),
      leverage,
      stopPrice: stopRounded,
      takeProfitPrice: tpRounded,
      liquidationPrice: roundToTick(liquidationPrice, tickSize),
      riskUsdt: round(qty * perUnitRisk, 8),
    };
  }

  isKillSwitchOn(): boolean {
    return CONFIG().killSwitch === true;
  }

  /**
   * Recompute SL/TP from a *known actual* entry price (e.g. avgFillPrice
   * after a market order). Critical for low-priced or low-ATR symbols where
   * the gap between signal.price (candle close) and the actual fill can be
   * larger than tpAtrMultiple * ATR — in which case TP can land BELOW entry
   * for a LONG and trigger immediately as a fake "take_profit" loss.
   */
  computeStops(
    side: Side,
    actualEntryPrice: number,
    atrValue: number,
    symbolInfo: ExchangeSymbolInfo | undefined,
  ): { stopPrice: number; takeProfitPrice: number } | null {
    if (!isFinite(actualEntryPrice) || actualEntryPrice <= 0) return null;
    if (!isFinite(atrValue) || atrValue <= 0) return null;
    const cfg = CONFIG();
    const slDist = atrValue * cfg.exits.slAtrMultiple;
    const tpDist = atrValue * cfg.exits.tpAtrMultiple;
    const stop = side === Side.LONG ? actualEntryPrice - slDist : actualEntryPrice + slDist;
    const tp = side === Side.LONG ? actualEntryPrice + tpDist : actualEntryPrice - tpDist;
    if (stop <= 0 || tp <= 0) return null;
    const tickSize = symbolInfo?.filters.tickSize ?? 0.01;
    const stopPrice = roundToTick(stop, tickSize);
    const takeProfitPrice = roundToTick(tp, tickSize);
    // Defensive sanity: TP must be on the profitable side, SL on the loss side.
    if (side === Side.LONG) {
      if (takeProfitPrice <= actualEntryPrice || stopPrice >= actualEntryPrice) return null;
    } else {
      if (takeProfitPrice >= actualEntryPrice || stopPrice <= actualEntryPrice) return null;
    }
    return { stopPrice, takeProfitPrice };
  }
}

function roundToTick(price: number, tick: number): number {
  if (tick <= 0) return price;
  const decimals = stepDecimals(tick);
  return round(Math.round(price / tick) * tick, decimals);
}

/**
 * Approximate isolated-margin liquidation for one-way mode.
 *   LONG  liq ≈ entry × (1 - 1/leverage + maintenance)
 *   SHORT liq ≈ entry × (1 + 1/leverage - maintenance)
 */
export function computeLiquidationPrice(side: Side, entry: number, leverage: number): number {
  const inv = 1 / leverage;
  if (side === Side.LONG) return entry * (1 - inv + MAINTENANCE_MARGIN_RATE);
  return entry * (1 + inv - MAINTENANCE_MARGIN_RATE);
}
