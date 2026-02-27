const config = require("../utils/config");
const { log } = require("../utils/logger");
const { pctChange } = require("../utils/math");
const store = require("../state/store");

function formatNumber(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return Number(value).toFixed(digits);
}

/**
 * FlipTrader – martingale-style trader that doubles the opposite side on each fill.
 *
 * 1. Places TWO stop-limit entries: one LONG above price, one SHORT below price,
 *    each sized at positionNotionalUSDT.
 * 2. When one side fills, the filled position gets TP and SL orders.
 *    The opposite pending entry is cancelled and re-placed with DOUBLE the notional.
 * 3. If the position hits TP → trader is destroyed (win).
 * 4. If the position hits SL → the position closes, the doubled opposite entry
 *    should fill as price continues, doubling again on the new opposite side.
 * 5. If maxDoubles is reached → trader is destroyed (risk limit).
 */
class FlipTrader {
  constructor({ symbol, api, onDestroy }) {
    this.id = `${symbol}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    this.symbol = symbol;
    this.api = api;
    this.onDestroy = onDestroy;
    this.traderType = "FLIP";

    this.basePrice = null;
    this.active = true;
    this.createdAt = new Date().toISOString();
    this.tradeHistory = [];
    this.realizedPnl = 0;
    this.feesPaid = 0;
    this.lastPrice = null;
    this.equity = 0;

    // Current multiplier: starts at 1x, doubles on each flip
    this.currentMultiplier = 1;
    this.doubleCount = 0;

    // Pending entry orders: at most one LONG and one SHORT at any time
    this.pendingEntriesById = new Map();  // orderId → { orderId, direction, price, quantity, notional }
    // Pending exit orders (TP / SL) for the active position
    this.pendingExitsById = new Map();    // orderId → { orderId, type ("TP"|"SL"), positionId }
    // Active position (at most one)
    this.positions = new Map();           // positionId → position

    this._onMarkPrice = this._onMarkPrice.bind(this);
    this._onBookTicker = this._onBookTicker.bind(this);
    this._onOrderFilled = this._onOrderFilled.bind(this);
    this._onOrderCancelled = this._onOrderCancelled.bind(this);
  }

  // ── Config helpers ──────────────────────────────────────────────

  _getSpacingPercent() {
    return Number(config.levelSpacingPercent) || 1;
  }

  _getTakeProfitPercent() {
    return Number(config.takeProfitPercent) || 1;
  }

  _getStopLossPercent() {
    return Number(config.stopLossPercent) || 1;
  }

  _getMaxDoubles() {
    return Number(config.maxDoubles) || 5;
  }

  _getBaseNotional() {
    return Number(config.positionNotionalUSDT) || 10;
  }

  _getPositionSide(direction) {
    return direction === "LONG" ? "LONG" : "SHORT";
  }

  _calcQuantity(price, notional) {
    if (notional <= 0) return 0;
    const qty = notional / price;
    return Number(qty.toFixed(4));
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  async start() {
    this.equity = await this.api.getBalance();
    this.basePrice = await this.api.getMarkPrice(this.symbol);
    this.lastPrice = this.basePrice;

    await this._placeInitialEntries();

    this.api.on("markPrice", this._onMarkPrice);
    this.api.on("bookTicker", this._onBookTicker);
    this.api.on("orderFilled", this._onOrderFilled);
    this.api.on("orderCancelled", this._onOrderCancelled);

    log(`TRADER ${this.symbol}`, "Initialized (FLIP)");
    this._updateStore();
  }

  async destroy(reason, options = {}) {
    if (!this.active) return;
    const { closePositions = true } = options;
    this.active = false;

    this.api.off("markPrice", this._onMarkPrice);
    this.api.off("bookTicker", this._onBookTicker);
    this.api.off("orderFilled", this._onOrderFilled);
    this.api.off("orderCancelled", this._onOrderCancelled);

    // Cancel all pending entries
    for (const order of this.pendingEntriesById.values()) {
      try {
        await this.api.cancelOrder({ symbol: this.symbol, orderId: order.orderId });
      } catch (err) {
        log(`TRADER ${this.symbol}`, `Entry cancel failed ${order.orderId}: ${err.message}`);
      }
    }

    await this.api.cancelAllOpenOrders(this.symbol);
    if (closePositions) await this._closeAllPositions("destroy", this.lastPrice || this.basePrice);

    store.removeTrader(this.id, {
      id: this.id,
      symbol: this.symbol,
      realizedPnl: this.realizedPnl,
      createdAt: this.createdAt,
      closedAt: new Date().toISOString(),
      reason
    });

    log(`TRADER ${this.symbol}`, `Destroyed (${reason})`);
    if (this.onDestroy) this.onDestroy(this.symbol, this.realizedPnl);
  }

  // ── Entry placement ─────────────────────────────────────────────

  /**
   * Place the initial pair: one LONG above, one SHORT below,
   * both at 1x base notional.
   */
  async _placeInitialEntries() {
    const spacing = this._getSpacingPercent();
    const notional = this._getBaseNotional();

    const longPrice = pctChange(this.basePrice, spacing);
    const shortPrice = pctChange(this.basePrice, -spacing);

    await this._placeEntryOrder("LONG", longPrice, notional);
    await this._placeEntryOrder("SHORT", shortPrice, notional);
  }

  async _placeEntryOrder(direction, price, notional) {
    const side = direction === "LONG" ? "BUY" : "SELL";
    const qty = this._calcQuantity(price, notional);
    const positionSide = this._getPositionSide(direction);
    const result = await this.api.placeStopLimitOrder({
      symbol: this.symbol,
      side,
      quantity: qty,
      stopPrice: Number(price.toFixed(6)),
      price: Number(price.toFixed(6)),
      reduceOnly: false,
      positionSide
    });

    this.pendingEntriesById.set(result.orderId, {
      orderId: result.orderId,
      direction,
      price,
      quantity: qty,
      notional
    });

    log(
      `TRADER ${this.symbol}`,
      `Placed ${direction} entry @ ${formatNumber(price, 6)} notional=$${formatNumber(notional)}`
    );
  }

  // ── Exit (TP/SL) placement ──────────────────────────────────────

  async _placeExitOrders(position) {
    const tpPercent = this._getTakeProfitPercent();
    const slPercent = this._getStopLossPercent();

    if (position.direction === "LONG") {
      // TP above entry, SL below entry
      const tpPrice = pctChange(position.entryPrice, tpPercent);
      const slPrice = pctChange(position.entryPrice, -slPercent);
      await this._placeExitOrder(position, "TP", tpPrice, "SELL");
      await this._placeExitOrder(position, "SL", slPrice, "SELL");
    } else {
      // SHORT: TP below entry, SL above entry
      const tpPrice = pctChange(position.entryPrice, -tpPercent);
      const slPrice = pctChange(position.entryPrice, slPercent);
      await this._placeExitOrder(position, "TP", tpPrice, "BUY");
      await this._placeExitOrder(position, "SL", slPrice, "BUY");
    }
  }

  async _placeExitOrder(position, type, price, side) {
    const positionSide = this._getPositionSide(position.direction);
    const result = await this.api.placeStopLimitOrder({
      symbol: this.symbol,
      side,
      quantity: position.quantity,
      stopPrice: Number(price.toFixed(6)),
      price: Number(price.toFixed(6)),
      reduceOnly: true,
      positionSide
    });

    this.pendingExitsById.set(result.orderId, {
      orderId: result.orderId,
      type,
      positionId: position.id,
      price,
      direction: position.direction
    });

    log(
      `TRADER ${this.symbol}`,
      `Placed ${type} for ${position.direction} @ ${formatNumber(price, 6)}`
    );
  }

  // ── Order events ────────────────────────────────────────────────

  _findPending(map, event) {
    let match = map.get(event.orderId);
    if (match) return { key: event.orderId, value: match };
    if (event.numericOrderId !== undefined) {
      match = map.get(event.numericOrderId);
      if (match) return { key: event.numericOrderId, value: match };
      match = map.get(String(event.numericOrderId));
      if (match) return { key: String(event.numericOrderId), value: match };
    }
    if (event.clientOrderId) {
      match = map.get(event.clientOrderId);
      if (match) return { key: event.clientOrderId, value: match };
    }
    if (typeof event.orderId === "number") {
      match = map.get(String(event.orderId));
      if (match) return { key: String(event.orderId), value: match };
    } else if (typeof event.orderId === "string" && /^\d+$/.test(event.orderId)) {
      match = map.get(Number(event.orderId));
      if (match) return { key: Number(event.orderId), value: match };
    }
    return null;
  }

  _onOrderCancelled(event) {
    if (!this.active || event.symbol !== this.symbol) return;

    const entryMatch = this._findPending(this.pendingEntriesById, event);
    if (entryMatch) {
      this.pendingEntriesById.delete(entryMatch.key);
      this._updateStore();
      return;
    }

    const exitMatch = this._findPending(this.pendingExitsById, event);
    if (exitMatch) {
      this.pendingExitsById.delete(exitMatch.key);
      this._updateStore();
      return;
    }
  }

  async _onOrderFilled(event) {
    if (!this.active || event.symbol !== this.symbol) return;

    // ── Entry fill ──
    const entryMatch = this._findPending(this.pendingEntriesById, event);
    if (entryMatch) {
      await this._handleEntryFill(entryMatch, event);
      return;
    }

    // ── Exit fill (TP or SL) ──
    const exitMatch = this._findPending(this.pendingExitsById, event);
    if (exitMatch) {
      await this._handleExitFill(exitMatch, event);
      return;
    }
  }

  async _handleEntryFill(entryMatch, event) {
    const pendingEntry = entryMatch.value;
    this.pendingEntriesById.delete(entryMatch.key);

    const entryPrice = Number(event.price || pendingEntry.price);
    const positionId = `POS-${event.orderId}`;

    const position = {
      id: positionId,
      direction: pendingEntry.direction,
      entryOrderId: event.orderId,
      entryPrice,
      quantity: pendingEntry.quantity,
      notional: pendingEntry.notional
    };

    this.positions.set(positionId, position);

    log(
      `TRADER ${this.symbol}`,
      `Filled ${position.direction} @ ${formatNumber(entryPrice, 6)} ` +
      `(${this.currentMultiplier}x, double #${this.doubleCount})`
    );

    // Place TP and SL for this position
    await this._placeExitOrders(position);

    // Cancel the opposite entry and replace with doubled notional
    await this._flipOppositeEntry(pendingEntry.direction);

    this._updateStore();
  }

  /**
   * Cancel the opposite-side pending entry and re-place it at 2x the current notional.
   * If maxDoubles is already reached when this flip would happen, destroy instead.
   */
  async _flipOppositeEntry(filledDirection) {
    const oppositeDirection = filledDirection === "LONG" ? "SHORT" : "LONG";

    // Find and cancel the opposite entry
    for (const [key, entry] of this.pendingEntriesById) {
      if (entry.direction === oppositeDirection) {
        try {
          await this.api.cancelOrder({ symbol: this.symbol, orderId: entry.orderId });
        } catch (err) {
          log(`TRADER ${this.symbol}`, `Cancel opposite entry failed: ${err.message}`);
        }
        this.pendingEntriesById.delete(key);
        break;
      }
    }

    // Double the multiplier
    this.currentMultiplier *= 2;
    this.doubleCount++;

    // Check if we've exceeded max doubles
    if (this.doubleCount > this._getMaxDoubles()) {
      log(`TRADER ${this.symbol}`, `Max doubles (${this._getMaxDoubles()}) reached — destroying`);
      await this.destroy("max-doubles", { closePositions: true });
      return;
    }

    // Place the new opposite entry with doubled notional
    const newNotional = this._getBaseNotional() * this.currentMultiplier;
    const spacing = this._getSpacingPercent();
    const currentPrice = this.lastPrice || this.basePrice;

    let entryPrice;
    if (oppositeDirection === "LONG") {
      entryPrice = pctChange(currentPrice, spacing);
    } else {
      entryPrice = pctChange(currentPrice, -spacing);
    }

    await this._placeEntryOrder(oppositeDirection, entryPrice, newNotional);

    log(
      `TRADER ${this.symbol}`,
      `Flipped: ${oppositeDirection} entry now ${this.currentMultiplier}x ($${formatNumber(newNotional)})`
    );
  }

  async _handleExitFill(exitMatch, event) {
    const exitInfo = exitMatch.value;
    this.pendingExitsById.delete(exitMatch.key);

    const position = this.positions.get(exitInfo.positionId);
    if (!position) return;

    const exitPrice = Number(event.price || exitInfo.price);
    const reason = exitInfo.type === "TP" ? "take-profit" : "stop-loss";

    // Cancel the other exit order for this position (TP cancels SL, SL cancels TP)
    await this._cancelExitsForPosition(exitInfo.positionId, exitMatch.key);

    await this._finalizeClose(position, reason, exitPrice, event.orderId);

    if (exitInfo.type === "TP") {
      // Take profit hit → destroy the trader (win)
      log(`TRADER ${this.symbol}`, `Take profit hit — destroying (win)`);
      await this.destroy("take-profit", { closePositions: false });
    }
    // If SL, the trader stays alive — the doubled opposite entry should fill next
  }

  async _cancelExitsForPosition(positionId, excludeKey) {
    for (const [key, exit] of this.pendingExitsById) {
      if (exit.positionId === positionId && key !== excludeKey) {
        try {
          await this.api.cancelOrder({ symbol: this.symbol, orderId: exit.orderId });
        } catch (err) {
          log(`TRADER ${this.symbol}`, `Exit cancel failed ${exit.orderId}: ${err.message}`);
        }
        this.pendingExitsById.delete(key);
      }
    }
  }

  // ── Price events ────────────────────────────────────────────────

  async _onMarkPrice({ symbol, price }) {
    if (!this.active || symbol !== this.symbol) return;
    this.lastPrice = price;
    this._updateStore();
  }

  async _onBookTicker({ symbol, bid, ask }) {
    if (!this.active || symbol !== this.symbol) return;
    const bidNum = Number(bid);
    const askNum = Number(ask);
    let price = null;
    if (Number.isFinite(bidNum) && Number.isFinite(askNum)) {
      price = (bidNum + askNum) / 2;
    } else if (Number.isFinite(bidNum)) {
      price = bidNum;
    } else if (Number.isFinite(askNum)) {
      price = askNum;
    }
    if (!Number.isFinite(price)) return;
    this.lastPrice = price;
    this._updateStore();
  }

  // ── Position closing ────────────────────────────────────────────

  async _closeAllPositions(reason, fallbackPrice) {
    const entries = Array.from(this.positions.values());
    for (const pos of entries) {
      await this._closePosition(pos, reason, fallbackPrice);
    }
  }

  async _closePosition(pos, reason, fallbackPrice) {
    const side = pos.direction === "LONG" ? "SELL" : "BUY";
    const positionSide = this._getPositionSide(pos.direction);
    const result = await this.api.placeMarketOrder({
      symbol: this.symbol,
      side,
      quantity: pos.quantity,
      positionSide
    });
    const exitPrice = result.price || fallbackPrice;
    await this._finalizeClose(pos, reason, exitPrice, result.orderId);
  }

  async _finalizeClose(pos, reason, exitPrice, exitOrderId) {
    if (pos.isClosing) return;
    pos.isClosing = true;

    let pnl = this._calcPnl(pos, exitPrice);
    let fees = this._estimateFees(pos.entryPrice, exitPrice, pos.quantity);

    if (config.mode === "live") {
      try {
        const liveSummary = await this._getLiveTradeSummary(pos, exitOrderId);
        if (liveSummary) {
          pnl = liveSummary.grossPnl;
          fees = liveSummary.fees;
        }
      } catch (err) {
        log(`TRADER ${this.symbol}`, `Live PnL fetch failed: ${err.message}`);
      }
    }

    this.positions.delete(pos.id);
    this.realizedPnl += pnl - fees;
    this.feesPaid += fees;
    this.tradeHistory.push({
      entry: pos.entryPrice,
      exit: exitPrice,
      pnl: pnl - fees,
      reason
    });

    store.recordTrade({ pnl, fees });

    log(
      `TRADER ${this.symbol}`,
      `Closed ${pos.direction} @ ${formatNumber(exitPrice, 6)} (PnL ${formatNumber(pnl - fees)}) reason=${reason}`
    );
    this._updateStore();
  }

  async _getLiveTradeSummary(pos, exitOrderId) {
    if (!exitOrderId || !pos.entryOrderId) return null;
    const orderIds = [pos.entryOrderId, exitOrderId].filter(Boolean);
    let grossPnl = 0;
    let fees = 0;
    let hasTrades = false;

    for (const orderId of orderIds) {
      const trades = await this.api.getOrderTrades(this.symbol, orderId);
      if (!trades || trades.length === 0) continue;
      hasTrades = true;
      for (const trade of trades) {
        grossPnl += Number(trade.realizedPnl || 0);
        fees += Number(trade.commission || 0);
      }
    }

    if (!hasTrades) return null;
    return { grossPnl, fees };
  }

  // ── Math helpers ────────────────────────────────────────────────

  _calcPnl(pos, exitPrice) {
    const direction = pos.direction === "LONG" ? 1 : -1;
    return (exitPrice - pos.entryPrice) * pos.quantity * direction;
  }

  _estimateFees(entryPrice, exitPrice, quantity) {
    const notional = (entryPrice + exitPrice) * quantity;
    return notional * config.feeRate;
  }

  _calcUnrealizedPnl(price) {
    let pnl = 0;
    for (const pos of this.positions.values()) {
      const direction = pos.direction === "LONG" ? 1 : -1;
      pnl += (price - pos.entryPrice) * pos.quantity * direction;
    }
    return pnl;
  }

  // ── Store sync ──────────────────────────────────────────────────

  _updateStore() {
    if (!this.active) return;
    const price = this.lastPrice || this.basePrice || 0;
    const spacing = this._getSpacingPercent();

    const levels = [];
    for (const entry of this.pendingEntriesById.values()) {
      levels.push({
        price: entry.price,
        direction: entry.direction,
        status: `PENDING_${entry.direction}`,
        notional: entry.notional
      });
    }
    for (const pos of this.positions.values()) {
      levels.push({
        price: pos.entryPrice,
        direction: pos.direction,
        status: pos.direction,
        entryPrice: pos.entryPrice,
        notional: pos.notional
      });
    }

    store.upsertTrader({
      id: this.id,
      symbol: this.symbol,
      traderType: this.traderType,
      lastPrice: price,
      sideExposure: 0,
      openPositions: this.positions.size,
      pendingOrders: this.pendingEntriesById.size + this.pendingExitsById.size,
      realizedPnl: this.realizedPnl,
      unrealizedPnl: this._calcUnrealizedPnl(price),
      createdAt: this.createdAt,
      doubleCount: this.doubleCount,
      currentMultiplier: this.currentMultiplier,
      maxDoubles: this._getMaxDoubles(),
      gridLevels: {
        basePrice: this.basePrice,
        spacingPercent: spacing,
        levels
      },
      openPositionsDetail: Array.from(this.positions.values()).map((pos) => ({
        side: pos.direction,
        entryPrice: pos.entryPrice,
        size: pos.quantity,
        notional: pos.notional
      })),
      pendingOrdersDetail: Array.from(this.pendingEntriesById.values()).map((order) => ({
        side: order.direction,
        stopPrice: order.price,
        limitPrice: order.price,
        size: order.quantity,
        notional: order.notional
      })),
      tradeHistory: this.tradeHistory,
      status: this.active ? "ACTIVE" : "STOPPED"
    });
  }
}

module.exports = FlipTrader;
