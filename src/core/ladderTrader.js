const config = require("../utils/config");
const { log } = require("../utils/logger");
const { pctChange } = require("../utils/math");
const store = require("../state/store");

function formatNumber(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return Number(value).toFixed(digits);
}

/**
 * LadderTrader – places a ladder of stop-limit orders on both sides of the price.
 *
 * LONG stop-limit orders are placed ABOVE the current price (breakout-buy).
 * SHORT stop-limit orders are placed BELOW the current price (breakout-sell).
 *
 * Stop-loss: when price returns to the starting price (basePrice), ALL open
 * positions are closed at market. This does NOT destroy the trader — the
 * ladder keeps running.
 *
 * Take-profit: not implemented yet (to be decided later).
 *
 * The ladder is "infinite": when the number of unfilled orders on one side
 * drops to `ladderRefillThreshold`, a fresh batch of orders is added further
 * out so the ladder keeps extending as price moves.
 */
class LadderTrader {
  constructor({ symbol, api, onDestroy }) {
    this.id = `${symbol}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    this.symbol = symbol;
    this.api = api;
    this.onDestroy = onDestroy;
    this.traderType = "LADDER";

    this.basePrice = null;
    this.active = true;
    this.createdAt = new Date().toISOString();
    this.tradeHistory = [];
    this.realizedPnl = 0;
    this.feesPaid = 0;
    this.lastPrice = null;
    this.equity = 0;

    // Track the highest level index placed on each side so we know where to
    // continue when adding more rungs to the ladder.
    this.nextLongLevel = 1;   // level 1, 2, 3, ...
    this.nextShortLevel = 1;  // level 1, 2, 3, ...

    this.pendingEntriesById = new Map();   // orderId → entry info
    this.positions = new Map();            // positionId → position
    this._closingOnBase = false;           // guard to avoid re-entrant base-price closes

    this._onMarkPrice = this._onMarkPrice.bind(this);
    this._onBookTicker = this._onBookTicker.bind(this);
    this._onOrderFilled = this._onOrderFilled.bind(this);
    this._onOrderCancelled = this._onOrderCancelled.bind(this);
  }

  // ── Config helpers ──────────────────────────────────────────────

  _getSpacingPercent() {
    return Number(config.levelSpacingPercent) || 1;
  }

  /** How many orders to place per side on each fill/refill. */
  _getInitialLevels() {
    return Number(config.ladderInitialLevels) || 3;
  }

  /** When unfilled orders on a side drop to this number, refill. */
  _getRefillThreshold() {
    return Number(config.ladderRefillThreshold) || 1;
  }

  _getPositionSide(direction) {
    return direction === "LONG" ? "LONG" : "SHORT";
  }

  _calcQuantity(price) {
    const notional = Number(config.positionNotionalUSDT) || 300;
    if (notional <= 0) return 0;
    const qty = notional / price;
    return Number(qty.toFixed(4));
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  async start() {
    this.equity = await this.api.getBalance();
    this.basePrice = await this.api.getMarkPrice(this.symbol);
    this.lastPrice = this.basePrice;

    await this._placeInitialLadder();

    this.api.on("markPrice", this._onMarkPrice);
    this.api.on("bookTicker", this._onBookTicker);
    this.api.on("orderFilled", this._onOrderFilled);
    this.api.on("orderCancelled", this._onOrderCancelled);

    log(`TRADER ${this.symbol}`, "Initialized (LADDER)");
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

  // ── Ladder placement ────────────────────────────────────────────

  /**
   * Place the initial batch of orders on both sides of the current price.
   * LONG stop-limit orders go above, SHORT stop-limit orders go below.
   */
  async _placeInitialLadder() {
    const count = this._getInitialLevels();
    await this._addLongLevels(count);
    await this._addShortLevels(count);
  }

  /**
   * Add `count` new LONG stop-limit orders above the current price,
   * continuing from where the ladder left off.
   */
  async _addLongLevels(count) {
    const spacing = this._getSpacingPercent();
    for (let i = 0; i < count; i++) {
      const levelIndex = this.nextLongLevel;
      const price = pctChange(this.basePrice, spacing * levelIndex);
      await this._placeEntryOrder("LONG", price, levelIndex);
      this.nextLongLevel++;
    }
  }

  /**
   * Add `count` new SHORT stop-limit orders below the current price,
   * continuing from where the ladder left off.
   */
  async _addShortLevels(count) {
    const spacing = this._getSpacingPercent();
    for (let i = 0; i < count; i++) {
      const levelIndex = this.nextShortLevel;
      const price = pctChange(this.basePrice, -(spacing * levelIndex));
      await this._placeEntryOrder("SHORT", price, levelIndex);
      this.nextShortLevel++;
    }
  }

  async _placeEntryOrder(direction, price, levelIndex) {
    const side = direction === "LONG" ? "BUY" : "SELL";
    const qty = this._calcQuantity(price);
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
      levelIndex
    });

    log(
      `TRADER ${this.symbol}`,
      `Placed ${direction} stop-limit entry L${levelIndex} @ ${formatNumber(price, 6)}`
    );
  }

  // ── Refill logic (infinite ladder) ──────────────────────────────

  /**
   * Check whether either side of the ladder needs more orders.
   * Called after every fill or cancellation.
   */
  async _maybeRefillLadder() {
    if (!this.active) return;

    const threshold = this._getRefillThreshold();
    const batch = this._getInitialLevels();

    const pendingLongs = this._countPendingBySide("LONG");
    const pendingShorts = this._countPendingBySide("SHORT");

    if (pendingLongs <= threshold) {
      log(`TRADER ${this.symbol}`, `Long ladder thin (${pendingLongs} left) — adding ${batch} more`);
      await this._addLongLevels(batch);
    }

    if (pendingShorts <= threshold) {
      log(`TRADER ${this.symbol}`, `Short ladder thin (${pendingShorts} left) — adding ${batch} more`);
      await this._addShortLevels(batch);
    }

    this._updateStore();
  }

  _countPendingBySide(direction) {
    let count = 0;
    for (const entry of this.pendingEntriesById.values()) {
      if (entry.direction === direction) count++;
    }
    return count;
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
      log(`TRADER ${this.symbol}`, `Entry order ${event.status}: id=${event.orderId} type=${event.orderType} side=${event.side}`);
      this.pendingEntriesById.delete(entryMatch.key);
      this._maybeRefillLadder();
      this._updateStore();
      return;
    }
  }

  _onOrderFilled(event) {
    if (!this.active || event.symbol !== this.symbol) return;

    // ── Entry fill ──
    const entryMatch = this._findPending(this.pendingEntriesById, event);
    if (entryMatch) {
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
        levelIndex: pendingEntry.levelIndex
      };

      this.positions.set(positionId, position);

      log(
        `TRADER ${this.symbol}`,
        `Filled ${position.direction} L${position.levelIndex} @ ${formatNumber(entryPrice, 6)}`
      );

      // After a fill, check if we need more rungs on this side
      this._maybeRefillLadder();
      this._updateStore();
      return;
    }

    // ── Exit fill (not expected in current design, but handle gracefully) ──
    log(`TRADER ${this.symbol}`, `Unexpected fill id=${event.orderId} numId=${event.numericOrderId || ""} clientId=${event.clientOrderId || ""}`);
  }

  // ── Base-price stop-loss ─────────────────────────────────────────

  async _onMarkPrice({ symbol, price }) {
    if (!this.active || symbol !== this.symbol) return;
    this.lastPrice = price;
    await this._checkBaseStop(price);
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
    await this._checkBaseStop(price);
    this._updateStore();
  }

  /**
   * When the price returns to basePrice, close ALL open positions.
   * This is the only stop-loss mechanism — no per-position TP/SL.
   * The trader keeps running after the close.
   */
  async _checkBaseStop(price) {
    if (this._closingOnBase || this.positions.size === 0) return;

    // Check if price has crossed back to (or through) the starting price.
    // LONG positions exist above basePrice → price fell back.
    // SHORT positions exist below basePrice → price rose back.
    const hasLongs = Array.from(this.positions.values()).some((p) => p.direction === "LONG");
    const hasShorts = Array.from(this.positions.values()).some((p) => p.direction === "SHORT");

    const longHit = hasLongs && price <= this.basePrice;
    const shortHit = hasShorts && price >= this.basePrice;

    if (!longHit && !shortHit) return;

    this._closingOnBase = true;
    const count = this.positions.size;
    log(`TRADER ${this.symbol}`, `Price returned to base (${formatNumber(this.basePrice, 6)}) — closing ${count} position(s)`);

    await this._closeAllPositions("base-stop", price);

    this._closingOnBase = false;
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
      `Closed ${pos.direction} L${pos.levelIndex} @ ${formatNumber(exitPrice, 6)} (PnL ${formatNumber(pnl - fees)}) reason=${reason}`
    );
    this._updateStore();

    // The ladder keeps running — we do NOT destroy on individual TP/SL.
    // Positions are independent; only the controller destroys the trader.
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

    // Build visible level list from pending entries + open positions
    const levels = [];
    for (const entry of this.pendingEntriesById.values()) {
      levels.push({
        index: entry.direction === "LONG" ? entry.levelIndex : -entry.levelIndex,
        price: entry.price,
        direction: entry.direction,
        status: `PENDING_${entry.direction}`
      });
    }
    for (const pos of this.positions.values()) {
      levels.push({
        index: pos.direction === "LONG" ? pos.levelIndex : -pos.levelIndex,
        price: pos.entryPrice,
        direction: pos.direction,
        status: pos.direction,
        entryPrice: pos.entryPrice
      });
    }
    levels.sort((a, b) => a.index - b.index);

    store.upsertTrader({
      id: this.id,
      symbol: this.symbol,
      traderType: this.traderType,
      lastPrice: price,
      sideExposure: 0,
      openPositions: this.positions.size,
      pendingOrders: this.pendingEntriesById.size,
      realizedPnl: this.realizedPnl,
      unrealizedPnl: this._calcUnrealizedPnl(price),
      createdAt: this.createdAt,
      gridLevels: {
        basePrice: this.basePrice,
        spacingPercent: spacing,
        levels
      },
      openPositionsDetail: Array.from(this.positions.values()).map((pos) => ({
        levelIndex: pos.levelIndex,
        side: pos.direction,
        entryPrice: pos.entryPrice,
        size: pos.quantity
      })),
      pendingOrdersDetail: Array.from(this.pendingEntriesById.values()).map((order) => ({
        levelIndex: order.levelIndex,
        side: order.direction,
        stopPrice: order.price,
        limitPrice: order.price,
        size: order.quantity
      })),
      tradeHistory: this.tradeHistory,
      status: this.active ? "ACTIVE" : "STOPPED"
    });
  }
}

module.exports = LadderTrader;
