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
    this.equity = 0;

    this.pendingEntriesById = new Map();
    this.pendingExitsById = new Map();
    this.positions = new Map();

    this._onMarkPrice = this._onMarkPrice.bind(this);
    this._onBookTicker = this._onBookTicker.bind(this);
    this._onOrderFilled = this._onOrderFilled.bind(this);
    this._onOrderCancelled = this._onOrderCancelled.bind(this);
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

  _getPositionSide(direction) {
    return direction === "LONG" ? "LONG" : "SHORT";
  }

  _calcQuantity(price) {
    const equity = this.equity || 200;
    const fraction = Number(config.equityFraction) || 0.25;
    const leverage = Number(config.leverage) || 10;
    const maxTraders = Number(config.maxTraders) || 2;
    // Split equity across traders, then across 2 entry orders (long + short)
    const perTrader = equity * fraction * leverage / maxTraders;
    const perSide = perTrader / 2;
    if (perSide <= 0) return 0;
    const qty = perSide / price;
    return Number(qty.toFixed(4));
  }

  async start() {
    this.equity = await this.api.getAvailableBalance();
    this.basePrice = await this.api.getMarkPrice(this.symbol);
    this.lastPrice = this.basePrice;

    await this._placeInitialEntries();

    this.api.on("markPrice", this._onMarkPrice);
    this.api.on("bookTicker", this._onBookTicker);
    this.api.on("orderFilled", this._onOrderFilled);
    this.api.on("orderCancelled", this._onOrderCancelled);

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
    this.api.off("orderCancelled", this._onOrderCancelled);

    for (const order of this.pendingEntriesById.values()) {
      try {
        await this.api.cancelOrder({ symbol: this.symbol, orderId: order.orderId });
      } catch (err) {
        log(`TRADER ${this.symbol}`, `Entry cancel failed ${order.orderId}: ${err.message}`);
      }
    }
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

  async _placeInitialEntries() {
    const spacing = this._getSpacingPercent();
    const longPrice = pctChange(this.basePrice, -spacing);
    const shortPrice = pctChange(this.basePrice, spacing);

    await this._placeEntryOrder("LONG", longPrice, -1);
    await this._placeEntryOrder("SHORT", shortPrice, 1);
  }

  async _placeEntryOrder(direction, price, levelIndex) {
    const side = direction === "LONG" ? "BUY" : "SELL";
    const qty = this._calcQuantity(price);
    const positionSide = this._getPositionSide(direction);
    const result = await this.api.placeLimitOrder({
      symbol: this.symbol,
      side,
      quantity: qty,
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

    log(`TRADER ${this.symbol}`, `Placed ${direction} entry @ ${formatNumber(price, 6)}`);
  }
  _onOrderCancelled(event) {
    if (!this.active || event.symbol !== this.symbol) return;

    const entryMatch = this._findPending(this.pendingEntriesById, event);
    if (entryMatch) {
      log(`TRADER ${this.symbol}`, `Entry order ${event.status}: id=${event.orderId} type=${event.orderType} side=${event.side}`);
      this.pendingEntriesById.delete(entryMatch.key);
      this._updateStore();
      return;
    }

    const exitMatch = this._findPending(this.pendingExitsById, event);
    if (exitMatch) {
      const pendingExit = exitMatch.value;
      log(`TRADER ${this.symbol}`, `Exit order ${event.status}: id=${event.orderId} reason=${pendingExit.reason} type=${event.orderType}`);
      this.pendingExitsById.delete(exitMatch.key);
      // If SL was rejected, the position is unprotected — close at market
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

  _findPending(map, event) {
    let match = map.get(event.orderId);
    if (match) return { key: event.orderId, value: match };
    // Try numeric orderId (standard orders store numeric key from REST)
    if (event.numericOrderId !== undefined) {
      match = map.get(event.numericOrderId);
      if (match) return { key: event.numericOrderId, value: match };
      match = map.get(String(event.numericOrderId));
      if (match) return { key: String(event.numericOrderId), value: match };
    }
    // Try clientOrderId
    if (event.clientOrderId) {
      match = map.get(event.clientOrderId);
      if (match) return { key: event.clientOrderId, value: match };
    }
    // Try string/number coercion of orderId
    if (typeof event.orderId === "number") {
      match = map.get(String(event.orderId));
      if (match) return { key: String(event.orderId), value: match };
    } else if (typeof event.orderId === "string" && /^\d+$/.test(event.orderId)) {
      match = map.get(Number(event.orderId));
      if (match) return { key: Number(event.orderId), value: match };
    }
    return null;
  }

  _onOrderFilled(event) {
    if (!this.active || event.symbol !== this.symbol) return;

    const entryMatch = this._findPending(this.pendingEntriesById, event);
    if (entryMatch) {
      const pendingEntry = entryMatch.value;
      this.pendingEntriesById.delete(entryMatch.key);
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

  async _placeExitOrders(position) {
    const tpSide = position.direction === "LONG" ? "SELL" : "BUY";
    const slSide = position.direction === "LONG" ? "SELL" : "BUY";
    const positionSide = this._getPositionSide(position.direction);
    const currentPrice = Number(this.lastPrice) || Number(position.entryPrice);
    const triggerHit = position.direction === "LONG"
      ? currentPrice <= position.stopLossPrice
      : currentPrice >= position.stopLossPrice;
    const closeToTrigger = Math.abs(currentPrice - position.stopLossPrice) <= (currentPrice * 0.0002);

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
        `TRADER ${this.symbol}`,
        `TP order placed id=${tp.orderId || ""} price=${formatNumber(position.takeProfitPrice, 6)} side=${tpSide} pos=${positionSide}`
      );
    } catch (err) {
      log(`TRADER ${this.symbol}`, `TP order failed: ${err.message}`);
      throw err;
    }

    if (triggerHit || closeToTrigger) {
      log(
        `TRADER ${this.symbol}`,
        `SL trigger unsafe at ${formatNumber(currentPrice, 6)}; closing market now`
      );
      await this._closePosition(position, "stop-loss", currentPrice);
      return;
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
        `TRADER ${this.symbol}`,
        `SL order placed id=${sl.orderId || ""} trigger=${formatNumber(position.stopLossPrice, 6)} side=${slSide} pos=${positionSide}`
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
      { index: 1, price: pctChange(this.basePrice, spacing), direction: "SHORT" },
      { index: 0, price: this.basePrice, direction: "EMPTY" },
      { index: -1, price: pctChange(this.basePrice, -spacing), direction: "LONG" }
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
