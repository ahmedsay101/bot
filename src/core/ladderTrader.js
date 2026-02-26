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
 * Each filled order gets its own individual TP and SL.
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
    this.pendingExitsById = new Map();     // orderId → exit info
    this.positions = new Map();            // positionId → position

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
    // Cancel all pending exits
    for (const order of this.pendingExitsById.values()) {
      try {
        await this.api.cancelOrder({ symbol: this.symbol, orderId: order.orderId });
      } catch (err) {
        log(`TRADER ${this.symbol}`, `Exit cancel failed ${order.orderId}: ${err.message}`);
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

    const exitMatch = this._findPending(this.pendingExitsById, event);
    if (exitMatch) {
      const pendingExit = exitMatch.value;
      log(`TRADER ${this.symbol}`, `Exit order ${event.status}: id=${event.orderId} reason=${pendingExit.reason} type=${event.orderType}`);
      this.pendingExitsById.delete(exitMatch.key);
      const position = this.positions.get(pendingExit.positionId);
      if (position && pendingExit.reason === "stop-loss" && !position.isClosing) {
        log(`TRADER ${this.symbol}`, `SL REJECTED — closing position at market`);
        const currentPrice = Number(this.lastPrice) || Number(position.entryPrice);
        this._closePosition(position, "sl-rejected", currentPrice);
      }
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
      const tpPercent = this._getTakeProfitPercent();
      const slPercent = this._getStopLossPercent();
      const takeProfitPrice =
        pendingEntry.direction === "LONG"
          ? pctChange(entryPrice, tpPercent)
          : pctChange(entryPrice, -tpPercent);
      const stopLossPrice =
        pendingEntry.direction === "LONG"
          ? pctChange(entryPrice, -slPercent)
          : pctChange(entryPrice, slPercent);

      const positionId = `POS-${event.orderId}`;
      const position = {
        id: positionId,
        direction: pendingEntry.direction,
        entryOrderId: event.orderId,
        entryPrice,
        quantity: pendingEntry.quantity,
        takeProfitPrice,
        stopLossPrice,
        tpOrderId: null,
        slOrderId: null,
        levelIndex: pendingEntry.levelIndex
      };

      this.positions.set(positionId, position);
      this._placeExitOrders(position);

      log(
        `TRADER ${this.symbol}`,
        `Filled ${position.direction} L${position.levelIndex} @ ${formatNumber(entryPrice, 6)}`
      );

      // After a fill, check if we need more rungs on this side
      this._maybeRefillLadder();
      this._updateStore();
      return;
    }

    // ── Exit fill ──
    const exitMatch = this._findPending(this.pendingExitsById, event);
    if (!exitMatch) {
      log(`TRADER ${this.symbol}`, `No pending found for fill id=${event.orderId} numId=${event.numericOrderId || ""} clientId=${event.clientOrderId || ""}`);
      return;
    }
    const pendingExit = exitMatch.value;
    this.pendingExitsById.delete(exitMatch.key);

    const position = this.positions.get(pendingExit.positionId);
    if (!position) return;
    if (position.isClosing) return;

    const exitPrice = Number(event.price || pendingExit.price);
    this._finalizeClose(position, pendingExit.reason, exitPrice, event.orderId);
  }

  // ── Exit (TP / SL) orders ──────────────────────────────────────

  async _placeExitOrders(position) {
    const tpSide = position.direction === "LONG" ? "SELL" : "BUY";
    const slSide = position.direction === "LONG" ? "SELL" : "BUY";
    const positionSide = this._getPositionSide(position.direction);
    const currentPrice = Number(this.lastPrice) || Number(position.entryPrice);

    const triggerHit = position.direction === "LONG"
      ? currentPrice <= position.stopLossPrice
      : currentPrice >= position.stopLossPrice;
    const closeToTrigger =
      Math.abs(currentPrice - position.stopLossPrice) <= currentPrice * 0.0002;

    // Place TP first
    let tp;
    try {
      tp = await this.api.placeLimitOrder({
        symbol: this.symbol,
        side: tpSide,
        quantity: position.quantity,
        price: Number(position.takeProfitPrice.toFixed(6)),
        reduceOnly: true,
        positionSide
      });
      log(
        `TRADER ${this.symbol}`,
        `TP order placed id=${tp.orderId || ""} price=${formatNumber(position.takeProfitPrice, 6)} side=${tpSide}`
      );
    } catch (err) {
      log(`TRADER ${this.symbol}`, `TP order failed: ${err.message}`);
      throw err;
    }

    // If SL would trigger immediately, close at market
    if (triggerHit || closeToTrigger) {
      log(
        `TRADER ${this.symbol}`,
        `SL trigger unsafe at ${formatNumber(currentPrice, 6)}; closing market now`
      );
      await this._closePosition(position, "stop-loss", currentPrice);
      return;
    }

    // Place SL
    let sl;
    try {
      sl = await this.api.placeStopLimitOrder({
        symbol: this.symbol,
        side: slSide,
        quantity: position.quantity,
        stopPrice: Number(position.stopLossPrice.toFixed(6)),
        reduceOnly: true,
        positionSide
      });
      log(
        `TRADER ${this.symbol}`,
        `SL order placed id=${sl.orderId || ""} trigger=${formatNumber(position.stopLossPrice, 6)} side=${slSide}`
      );
    } catch (err) {
      log(`TRADER ${this.symbol}`, `SL order failed: ${err.message}`);
      if (err.message && err.message.includes("-2021")) {
        log(`TRADER ${this.symbol}`, `SL would immediately trigger — closing at market`);
        await this._closePosition(position, "stop-loss", currentPrice);
        return;
      }
      throw err;
    }

    position.tpOrderId = tp.orderId;
    position.slOrderId = sl.orderId;

    this.pendingExitsById.set(tp.orderId, {
      orderId: tp.orderId,
      positionId: position.id,
      reason: "take-profit",
      price: position.takeProfitPrice
    });
    this.pendingExitsById.set(sl.orderId, {
      orderId: sl.orderId,
      positionId: position.id,
      reason: "stop-loss",
      price: position.stopLossPrice
    });

    log(
      `TRADER ${this.symbol}`,
      `TP @ ${formatNumber(position.takeProfitPrice, 6)} / SL @ ${formatNumber(position.stopLossPrice, 6)}`
    );
  }

  // ── Price events ────────────────────────────────────────────────

  async _onMarkPrice({ symbol, price }) {
    if (!this.active || symbol !== this.symbol) return;
    this.lastPrice = price;
    await this._maybeForceClose(price);
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
    await this._maybeForceClose(price);
    this._updateStore();
  }

  /** In test mode, simulate TP/SL hits since there is no exchange. */
  async _maybeForceClose(price) {
    if (config.mode !== "test" || this.positions.size === 0) return;
    for (const pos of Array.from(this.positions.values())) {
      if (pos.isClosing) continue;
      const hitTp =
        pos.direction === "LONG"
          ? price >= pos.takeProfitPrice
          : price <= pos.takeProfitPrice;
      const hitSl =
        pos.direction === "LONG"
          ? price <= pos.stopLossPrice
          : price >= pos.stopLossPrice;

      if (!hitTp && !hitSl) continue;
      const reason = hitTp ? "take-profit" : "stop-loss";
      await this._finalizeClose(pos, reason, price, null);
      if (!this.active) return;
    }
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

    // Cancel the opposite exit order
    if (pos.tpOrderId) await this.api.cancelOrder({ symbol: this.symbol, orderId: pos.tpOrderId });
    if (pos.slOrderId) await this.api.cancelOrder({ symbol: this.symbol, orderId: pos.slOrderId });

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
    const tp = this._getTakeProfitPercent();
    const sl = this._getStopLossPercent();

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
        entryPrice: pos.entryPrice,
        takeProfitPrice: pos.takeProfitPrice,
        stopLossPrice: pos.stopLossPrice
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
        takeProfitPercent: tp,
        stopLossPercent: sl,
        levels
      },
      openPositionsDetail: Array.from(this.positions.values()).map((pos) => ({
        levelIndex: pos.levelIndex,
        side: pos.direction,
        entryPrice: pos.entryPrice,
        takeProfitPrice: pos.takeProfitPrice,
        stopLossPrice: pos.stopLossPrice,
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
