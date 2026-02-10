const config = require("../utils/config");
const { log } = require("../utils/logger");
const { pctChange } = require("../utils/math");
const store = require("../state/store");

function formatNumber(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return Number(value).toFixed(digits);
}

class Trader {
  constructor({ symbol, api, onDestroy }) {
    this.id = `${symbol}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    this.symbol = symbol;
    this.api = api;
    this.onDestroy = onDestroy;

    this.basePrice = null;
    this.active = true;
    this.createdAt = new Date().toISOString();
    this.tradeHistory = [];
    this.realizedPnl = 0;
    this.feesPaid = 0;
    this.lastPrice = null;

    this.pendingEntriesById = new Map();
    this.pendingExitsById = new Map();
    this.positions = new Map();

    this._onMarkPrice = this._onMarkPrice.bind(this);
    this._onBookTicker = this._onBookTicker.bind(this);
    this._onOrderFilled = this._onOrderFilled.bind(this);
  }

  _getSpacingPercent() {
    return Number(config.levelSpacingPercent) || 1;
  }

  _getTakeProfitPercent() {
    return Number(config.takeProfitPercent) || 1;
  }

  _getStopLossPercent() {
    return Number(config.stopLossPercent) || 1;
  }

  _calcQuantity(price) {
    const baseNotional = Number(config.positionNotionalUSDT) || 0;
    const leverage = Number(config.leverage) || 1;
    const notional = config.mode === "test" ? baseNotional * leverage : baseNotional;
    const qty = notional / price;
    return Number(qty.toFixed(4));
  }

  async start() {
    this.basePrice = await this.api.getMarkPrice(this.symbol);
    this.lastPrice = this.basePrice;

    await this._placeInitialEntries();

    this.api.on("markPrice", this._onMarkPrice);
    this.api.on("bookTicker", this._onBookTicker);
    this.api.on("orderFilled", this._onOrderFilled);

    log(`TRADER ${this.symbol}`, "Initialized");
    this._updateStore();
  }

  async destroy(reason, options = {}) {
    if (!this.active) return;
    const { closePositions = true } = options;
    this.active = false;
    this.api.off("markPrice", this._onMarkPrice);
    this.api.off("bookTicker", this._onBookTicker);
    this.api.off("orderFilled", this._onOrderFilled);

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
    if (this.onDestroy) this.onDestroy(this.symbol);
  }

  async _placeInitialEntries() {
    const spacing = this._getSpacingPercent();
    const longPrice = pctChange(this.basePrice, spacing);
    const shortPrice = pctChange(this.basePrice, -spacing);

    await this._placeEntryOrder("LONG", longPrice, 1);
    await this._placeEntryOrder("SHORT", shortPrice, -1);
  }

  async _placeEntryOrder(direction, price, levelIndex) {
    const side = direction === "LONG" ? "BUY" : "SELL";
    const qty = this._calcQuantity(price);
    const result = await this.api.placeStopLimitOrder({
      symbol: this.symbol,
      side,
      quantity: qty,
      stopPrice: Number(price.toFixed(6)),
      price: Number(price.toFixed(6)),
      reduceOnly: false
    });

    this.pendingEntriesById.set(result.orderId, {
      orderId: result.orderId,
      direction,
      price,
      quantity: qty,
      levelIndex
    });

    log(`TRADER ${this.symbol}`, `Placed ${direction} entry @ ${formatNumber(price, 6)}`);
  }

  _onOrderFilled(event) {
    if (!this.active || event.symbol !== this.symbol) return;

    const pendingEntry = this.pendingEntriesById.get(event.orderId);
    if (pendingEntry) {
      this.pendingEntriesById.delete(event.orderId);
      const entryPrice = Number(event.price || pendingEntry.price);
      const tpPercent = this._getTakeProfitPercent();
      const slPercent = this._getStopLossPercent();
      const takeProfitPrice = pendingEntry.direction === "LONG"
        ? pctChange(entryPrice, tpPercent)
        : pctChange(entryPrice, -tpPercent);
      const stopLossPrice = pendingEntry.direction === "LONG"
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

      log(`TRADER ${this.symbol}`, `Filled ${position.direction} @ ${formatNumber(entryPrice, 6)}`);
      this._updateStore();
      return;
    }

    const pendingExit = this.pendingExitsById.get(event.orderId);
    if (!pendingExit) return;
    this.pendingExitsById.delete(event.orderId);

    const position = this.positions.get(pendingExit.positionId);
    if (!position) return;
    if (position.isClosing) return;

    const exitPrice = Number(event.price || pendingExit.price);
    this._finalizeClose(position, pendingExit.reason, exitPrice, event.orderId);
  }

  async _placeExitOrders(position) {
    const tpSide = position.direction === "LONG" ? "SELL" : "BUY";
    const slSide = position.direction === "LONG" ? "SELL" : "BUY";

    const tp = await this.api.placeLimitOrder({
      symbol: this.symbol,
      side: tpSide,
      quantity: position.quantity,
      price: Number(position.takeProfitPrice.toFixed(6)),
      reduceOnly: true
    });

    const sl = await this.api.placeStopLimitOrder({
      symbol: this.symbol,
      side: slSide,
      quantity: position.quantity,
      stopPrice: Number(position.stopLossPrice.toFixed(6)),
      price: Number(position.stopLossPrice.toFixed(6)),
      reduceOnly: true
    });

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

    log(`TRADER ${this.symbol}`, `TP @ ${formatNumber(position.takeProfitPrice, 6)} / SL @ ${formatNumber(position.stopLossPrice, 6)}`);
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
      const reason = hitTp ? "take-profit" : "stop-loss";
      await this._finalizeClose(pos, reason, price, null);
      if (!this.active) return;
    }
  }

  async _closeAllPositions(reason, fallbackPrice) {
    const entries = Array.from(this.positions.values());
    for (const pos of entries) {
      await this._closePosition(pos, reason, fallbackPrice);
    }
  }

  async _closePosition(pos, reason, fallbackPrice) {
    const side = pos.direction === "LONG" ? "SELL" : "BUY";
    const result = await this.api.placeMarketOrder({
      symbol: this.symbol,
      side,
      quantity: pos.quantity
    });
    const exitPrice = result.price || fallbackPrice;
    await this._finalizeClose(pos, reason, exitPrice, result.orderId);
  }

  async _finalizeClose(pos, reason, exitPrice, exitOrderId) {
    if (pos.isClosing) return;
    pos.isClosing = true;
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
      `Closed ${pos.direction} @ ${formatNumber(exitPrice, 6)} (PnL ${formatNumber(pnl - fees)}) reason=${reason}`
    );
    this._updateStore();
    if (reason === "take-profit" || reason === "stop-loss") {
      await this.destroy(reason, { closePositions: false });
    }
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

  _updateStore() {
    if (!this.active) return;
    const price = this.lastPrice || this.basePrice || 0;
    const spacing = this._getSpacingPercent();
    const tp = this._getTakeProfitPercent();
    const sl = this._getStopLossPercent();

    const levels = [
      { index: -1, price: pctChange(this.basePrice, -spacing), direction: "SHORT" },
      { index: 0, price: this.basePrice, direction: "EMPTY" },
      { index: 1, price: pctChange(this.basePrice, spacing), direction: "LONG" }
    ];

    store.upsertTrader({
      id: this.id,
      symbol: this.symbol,
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
        levels: levels.map((level) => {
          const entry = Array.from(this.pendingEntriesById.values())
            .find((pending) => pending.levelIndex === level.index);
          const pos = Array.from(this.positions.values())
            .find((p) => p.levelIndex === level.index);
          const status = pos
            ? pos.direction
            : entry
              ? `PENDING_${entry.direction}`
              : "EMPTY";
          return {
            index: level.index,
            price: level.price,
            status,
            entryPrice: pos ? pos.entryPrice : null,
            takeProfitPrice: pos ? pos.takeProfitPrice : null
          };
        })
      },
      openPositionsDetail: Array.from(this.positions.values()).map((pos) => ({
        levelIndex: pos.levelIndex,
        side: pos.direction,
        entryPrice: pos.entryPrice,
        takeProfitPrice: pos.takeProfitPrice,
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

module.exports = Trader;
