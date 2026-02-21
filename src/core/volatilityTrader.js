const config = require("../utils/config");
const { log } = require("../utils/logger");
const { pctChange } = require("../utils/math");
const store = require("../state/store");

function formatNumber(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return Number(value).toFixed(digits);
}

class VolatilityTrader {
  constructor({ symbol, api, onDestroy }) {
    this.id = `VOL-${symbol}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    this.symbol = symbol;
    this.api = api;
    this.onDestroy = onDestroy;
    this.traderType = "VOLATILITY";

    this.basePrice = null;
    this.active = true;
    this.createdAt = new Date().toISOString();
    this.tradeHistory = [];
    this.realizedPnl = 0;
    this.feesPaid = 0;
    this.lastPrice = null;

    this.pendingExitsById = new Map();
    this.positions = new Map();

    // Track which side has taken profit
    this.tpHitSide = null;

    this._onMarkPrice = this._onMarkPrice.bind(this);
    this._onBookTicker = this._onBookTicker.bind(this);
    this._onOrderFilled = this._onOrderFilled.bind(this);
    this._onOrderCancelled = this._onOrderCancelled.bind(this);
  }

  _getTakeProfitPercent() {
    return Number(config.volatilityTakeProfitPercent) || 3;
  }

  _getStopLossPercent() {
    return Number(config.volatilityStopLossPercent) || 6;
  }

  _getPositionSide(direction) {
    return direction === "LONG" ? "LONG" : "SHORT";
  }

  _calcQuantity(price) {
    const notional = Number(config.volatilityPositionNotionalUSDT) || 300;
    const leverage = Number(config.leverage) || 1;
    const effectiveNotional = config.mode === "test" ? notional * leverage : notional;
    const qty = effectiveNotional / price;
    return Number(qty.toFixed(4));
  }

  async start() {
    this.basePrice = await this.api.getMarkPrice(this.symbol);
    this.lastPrice = this.basePrice;

    await this._placeInitialPositions();

    this.api.on("markPrice", this._onMarkPrice);
    this.api.on("bookTicker", this._onBookTicker);
    this.api.on("orderFilled", this._onOrderFilled);
    this.api.on("orderCancelled", this._onOrderCancelled);

    log(`VOL-TRADER ${this.symbol}`, `Initialized @ ${formatNumber(this.basePrice, 6)}`);
    this._updateStore();
  }

  async _placeInitialPositions() {
    const qty = this._calcQuantity(this.basePrice);
    const tpPercent = this._getTakeProfitPercent();
    const slPercent = this._getStopLossPercent();

    // Place LONG market order
    const longResult = await this.api.placeMarketOrder({
      symbol: this.symbol,
      side: "BUY",
      quantity: qty,
      positionSide: "LONG"
    });
    const longEntryPrice = Number(longResult.price) || this.basePrice;
    const longPosId = `VPOS-LONG-${this.id}`;
    const longPosition = {
      id: longPosId,
      direction: "LONG",
      entryPrice: longEntryPrice,
      quantity: qty,
      takeProfitPrice: pctChange(this.basePrice, tpPercent),
      stopLossPrice: pctChange(this.basePrice, -slPercent),
      tpOrderId: null,
      slOrderId: null
    };
    this.positions.set(longPosId, longPosition);

    log(`VOL-TRADER ${this.symbol}`, `Opened LONG @ ${formatNumber(longEntryPrice, 6)}`);

    // Place SHORT market order
    const shortResult = await this.api.placeMarketOrder({
      symbol: this.symbol,
      side: "SELL",
      quantity: qty,
      positionSide: "SHORT"
    });
    const shortEntryPrice = Number(shortResult.price) || this.basePrice;
    const shortPosId = `VPOS-SHORT-${this.id}`;
    const shortPosition = {
      id: shortPosId,
      direction: "SHORT",
      entryPrice: shortEntryPrice,
      quantity: qty,
      takeProfitPrice: pctChange(this.basePrice, -tpPercent),
      stopLossPrice: pctChange(this.basePrice, slPercent),
      tpOrderId: null,
      slOrderId: null
    };
    this.positions.set(shortPosId, shortPosition);

    log(`VOL-TRADER ${this.symbol}`, `Opened SHORT @ ${formatNumber(shortEntryPrice, 6)}`);

    // Place exit orders for both positions
    await this._placeExitOrders(longPosition);
    await this._placeExitOrders(shortPosition);
  }

  async _placeExitOrders(position) {
    const tpSide = position.direction === "LONG" ? "SELL" : "BUY";
    const slSide = position.direction === "LONG" ? "SELL" : "BUY";
    const positionSide = this._getPositionSide(position.direction);

    let tp;
    let sl;

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
        `VOL-TRADER ${this.symbol}`,
        `TP placed ${position.direction} id=${tp.orderId || ""} @ ${formatNumber(position.takeProfitPrice, 6)}`
      );
    } catch (err) {
      log(`VOL-TRADER ${this.symbol}`, `TP order failed for ${position.direction}: ${err.message}`);
      throw err;
    }

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
        `VOL-TRADER ${this.symbol}`,
        `SL placed ${position.direction} id=${sl.orderId || ""} @ ${formatNumber(position.stopLossPrice, 6)}`
      );
    } catch (err) {
      log(`VOL-TRADER ${this.symbol}`, `SL order failed for ${position.direction}: ${err.message}`);
      if (err.message && err.message.includes("-2021")) {
        log(`VOL-TRADER ${this.symbol}`, `SL would immediately trigger — closing at market`);
        await this._closePosition(position, "stop-loss", this.lastPrice || this.basePrice);
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
  }

  /**
   * After one side takes profit, replace the other side's exits:
   * - New TP at base price (break-even close)
   * - Keep original SL
   */
  async _replaceExitsAfterTp(remainingPos) {
    // Cancel existing exit orders for the remaining position
    if (remainingPos.tpOrderId) {
      try {
        await this.api.cancelOrder({ symbol: this.symbol, orderId: remainingPos.tpOrderId });
      } catch (err) {
        log(`VOL-TRADER ${this.symbol}`, `Cancel old TP failed: ${err.message}`);
      }
      this.pendingExitsById.delete(remainingPos.tpOrderId);
      remainingPos.tpOrderId = null;
    }
    if (remainingPos.slOrderId) {
      try {
        await this.api.cancelOrder({ symbol: this.symbol, orderId: remainingPos.slOrderId });
      } catch (err) {
        log(`VOL-TRADER ${this.symbol}`, `Cancel old SL failed: ${err.message}`);
      }
      this.pendingExitsById.delete(remainingPos.slOrderId);
      remainingPos.slOrderId = null;
    }

    // New TP at base price (break-even)
    const tpSide = remainingPos.direction === "LONG" ? "SELL" : "BUY";
    const positionSide = this._getPositionSide(remainingPos.direction);

    // Check if we should close immediately (price already past base price in the losing direction)
    const currentPrice = Number(this.lastPrice) || this.basePrice;
    const pastBase = remainingPos.direction === "LONG"
      ? currentPrice <= this.basePrice
      : currentPrice >= this.basePrice;

    if (pastBase) {
      log(`VOL-TRADER ${this.symbol}`, `Price already past base — closing ${remainingPos.direction} at market`);
      await this._closePosition(remainingPos, "base-close", currentPrice);
      return;
    }

    let tp;
    try {
      tp = await this.api.placeLimitOrder({
        symbol: this.symbol,
        side: tpSide,
        quantity: remainingPos.quantity,
        price: Number(this.basePrice.toFixed(6)),
        reduceOnly: true,
        positionSide
      });
      log(`VOL-TRADER ${this.symbol}`, `New TP (base) placed ${remainingPos.direction} @ ${formatNumber(this.basePrice, 6)}`);
    } catch (err) {
      log(`VOL-TRADER ${this.symbol}`, `New TP (base) failed: ${err.message}`);
      await this._closePosition(remainingPos, "base-close", currentPrice);
      return;
    }

    // Re-place SL at original stop loss price
    const slSide = tpSide;
    let sl;
    try {
      sl = await this.api.placeStopLimitOrder({
        symbol: this.symbol,
        side: slSide,
        quantity: remainingPos.quantity,
        stopPrice: Number(remainingPos.stopLossPrice.toFixed(6)),
        reduceOnly: true,
        positionSide
      });
      log(`VOL-TRADER ${this.symbol}`, `SL re-placed ${remainingPos.direction} @ ${formatNumber(remainingPos.stopLossPrice, 6)}`);
    } catch (err) {
      log(`VOL-TRADER ${this.symbol}`, `SL re-place failed: ${err.message}`);
    }

    remainingPos.tpOrderId = tp.orderId;
    remainingPos.takeProfitPrice = this.basePrice;

    this.pendingExitsById.set(tp.orderId, {
      orderId: tp.orderId,
      positionId: remainingPos.id,
      reason: "base-close",
      price: this.basePrice
    });

    if (sl) {
      remainingPos.slOrderId = sl.orderId;
      this.pendingExitsById.set(sl.orderId, {
        orderId: sl.orderId,
        positionId: remainingPos.id,
        reason: "stop-loss",
        price: remainingPos.stopLossPrice
      });
    }
  }

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

    const exitMatch = this._findPending(this.pendingExitsById, event);
    if (exitMatch) {
      const pendingExit = exitMatch.value;
      log(`VOL-TRADER ${this.symbol}`, `Exit order ${event.status}: id=${event.orderId} reason=${pendingExit.reason}`);
      this.pendingExitsById.delete(exitMatch.key);

      const position = this.positions.get(pendingExit.positionId);
      if (position && pendingExit.reason === "stop-loss" && !position.isClosing) {
        log(`VOL-TRADER ${this.symbol}`, `SL REJECTED — closing ${position.direction} at market`);
        const currentPrice = Number(this.lastPrice) || Number(position.entryPrice);
        this._closePosition(position, "sl-rejected", currentPrice);
      }
      this._updateStore();
    }
  }

  _onOrderFilled(event) {
    if (!this.active || event.symbol !== this.symbol) return;

    const exitMatch = this._findPending(this.pendingExitsById, event);
    if (!exitMatch) return;

    const pendingExit = exitMatch.value;
    this.pendingExitsById.delete(exitMatch.key);

    const position = this.positions.get(pendingExit.positionId);
    if (!position || position.isClosing) return;

    const exitPrice = Number(event.price || pendingExit.price);
    const reason = pendingExit.reason;

    if (reason === "take-profit" && !this.tpHitSide) {
      // First TP hit — finalize this position, then adjust the other side
      this.tpHitSide = position.direction;
      this._finalizeClose(position, reason, exitPrice, event.orderId);
    } else {
      // Either SL, base-close, or second close — finalize and destroy
      this._finalizeClose(position, reason, exitPrice, event.orderId);
    }
  }

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

  async _maybeForceClose(price) {
    if (config.mode !== "test" || this.positions.size === 0) return;
    for (const pos of Array.from(this.positions.values())) {
      if (pos.isClosing) continue;
      const hitTp = pos.direction === "LONG"
        ? price >= pos.takeProfitPrice
        : price <= pos.takeProfitPrice;
      const hitSl = pos.direction === "LONG"
        ? price <= pos.stopLossPrice
        : price >= pos.stopLossPrice;

      if (!hitTp && !hitSl) continue;

      if (hitTp && !this.tpHitSide) {
        // First TP
        this.tpHitSide = pos.direction;
        await this._finalizeClose(pos, "take-profit", price, null);
      } else {
        const reason = hitTp ? "base-close" : "stop-loss";
        await this._finalizeClose(pos, reason, price, null);
      }
      if (!this.active) return;
    }
  }

  async _closeAllPositions(reason, fallbackPrice) {
    for (const pos of Array.from(this.positions.values())) {
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

    // Cancel pending exit orders for this position
    if (pos.tpOrderId) {
      try { await this.api.cancelOrder({ symbol: this.symbol, orderId: pos.tpOrderId }); } catch (_) {}
      this.pendingExitsById.delete(pos.tpOrderId);
    }
    if (pos.slOrderId) {
      try { await this.api.cancelOrder({ symbol: this.symbol, orderId: pos.slOrderId }); } catch (_) {}
      this.pendingExitsById.delete(pos.slOrderId);
    }

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
        log(`VOL-TRADER ${this.symbol}`, `Live PnL fetch failed: ${err.message}`);
      }
    }

    this.positions.delete(pos.id);
    this.realizedPnl += pnl - fees;
    this.feesPaid += fees;
    this.tradeHistory.push({
      entry: pos.entryPrice,
      exit: exitPrice,
      pnl: pnl - fees,
      reason,
      direction: pos.direction
    });

    store.recordTrade({ pnl, fees });

    log(
      `VOL-TRADER ${this.symbol}`,
      `Closed ${pos.direction} @ ${formatNumber(exitPrice, 6)} (PnL ${formatNumber(pnl - fees)}) reason=${reason}`
    );

    this._updateStore();

    if (reason === "take-profit" && this.positions.size > 0) {
      // One side TP'd — adjust the remaining side's exits
      const remaining = Array.from(this.positions.values()).find((p) => !p.isClosing);
      if (remaining) {
        await this._replaceExitsAfterTp(remaining);
        this._updateStore();
      }
    } else if (this.positions.size === 0) {
      // Both sides closed — destroy
      await this.destroy(reason, { closePositions: false });
    }
  }

  async _getLiveTradeSummary(pos, exitOrderId) {
    if (!exitOrderId) return null;
    const trades = await this.api.getOrderTrades(this.symbol, exitOrderId);
    if (!trades || trades.length === 0) return null;
    let grossPnl = 0;
    let fees = 0;
    for (const trade of trades) {
      grossPnl += Number(trade.realizedPnl || 0);
      fees += Number(trade.commission || 0);
    }
    return { grossPnl, fees };
  }

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

  async destroy(reason, options = {}) {
    if (!this.active) return;
    const { closePositions = true } = options;
    this.active = false;
    this.api.off("markPrice", this._onMarkPrice);
    this.api.off("bookTicker", this._onBookTicker);
    this.api.off("orderFilled", this._onOrderFilled);
    this.api.off("orderCancelled", this._onOrderCancelled);

    for (const order of this.pendingExitsById.values()) {
      try {
        await this.api.cancelOrder({ symbol: this.symbol, orderId: order.orderId });
      } catch (err) {
        log(`VOL-TRADER ${this.symbol}`, `Exit cancel failed ${order.orderId}: ${err.message}`);
      }
    }
    await this.api.cancelAllOpenOrders(this.symbol);
    if (closePositions) await this._closeAllPositions("destroy", this.lastPrice || this.basePrice);

    store.removeTrader(this.id, {
      id: this.id,
      symbol: this.symbol,
      traderType: "VOLATILITY",
      realizedPnl: this.realizedPnl,
      createdAt: this.createdAt,
      closedAt: new Date().toISOString(),
      reason
    });

    log(`VOL-TRADER ${this.symbol}`, `Destroyed (${reason})`);
    if (this.onDestroy) this.onDestroy(this.symbol);
  }

  _updateStore() {
    if (!this.active) return;
    const price = this.lastPrice || this.basePrice || 0;
    const tp = this._getTakeProfitPercent();
    const sl = this._getStopLossPercent();

    store.upsertTrader({
      id: this.id,
      symbol: this.symbol,
      traderType: "VOLATILITY",
      lastPrice: price,
      sideExposure: 0,
      openPositions: this.positions.size,
      pendingOrders: 0,
      realizedPnl: this.realizedPnl,
      unrealizedPnl: this._calcUnrealizedPnl(price),
      createdAt: this.createdAt,
      gridLevels: {
        basePrice: this.basePrice,
        takeProfitPercent: tp,
        stopLossPercent: sl,
        levels: []
      },
      openPositionsDetail: Array.from(this.positions.values()).map((pos) => ({
        side: pos.direction,
        entryPrice: pos.entryPrice,
        takeProfitPrice: pos.takeProfitPrice,
        stopLossPrice: pos.stopLossPrice,
        size: pos.quantity
      })),
      pendingOrdersDetail: [],
      tradeHistory: this.tradeHistory,
      tpHitSide: this.tpHitSide,
      status: this.active ? "ACTIVE" : "STOPPED"
    });
  }
}

module.exports = VolatilityTrader;
