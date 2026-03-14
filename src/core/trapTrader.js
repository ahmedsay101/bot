const config = require("../utils/config");
const { log } = require("../utils/logger");
const store = require("../state/store");

function fmt(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return Number(value).toFixed(digits);
}

/**
 * TrapTrader — breakout trap strategy.
 *
 * On start:
 *   1. Records the starting price (mid-point).
 *   2. Places a LONG stop-limit entry at startPrice * (1 + trapPercent/100).
 *   3. Places a SHORT stop-limit entry at startPrice * (1 - trapPercent/100).
 *
 * Both positions have SL = startPrice (the mid-point).
 * No take profit — positions remain open until the trader is destroyed.
 *
 * When a position hits SL (price returns to startPrice), the position is closed
 * and the same entry order is re-placed at its original price.
 *
 * The idea: price bounces between the two levels, accumulating small losses,
 * until a breakout happens and one position rides a large move.
 *
 * SL logic (test vs live) follows the expansion trader pattern.
 */
class TrapTrader {
  constructor({ symbol, api, onDestroy }) {
    this.id = `${symbol}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    this.symbol = symbol;
    this.api = api;
    this.onDestroy = onDestroy;

    this.active = true;
    this.createdAt = new Date().toISOString();
    this.startPrice = null;
    this.lastPrice = null;
    this.equity = 0;

    // Saved entry prices (never change)
    this.longEntryPrice = null;
    this.shortEntryPrice = null;

    // Pending entry orders by orderId
    this.pendingEntriesById = new Map();
    // Pending exit (SL) orders by orderId
    this.pendingExitsById = new Map();
    // Active positions by positionId
    this.positions = new Map();

    this.realizedPnl = 0;
    this.feesPaid = 0;
    this.unrealizedPnl = 0;
    this.highestNetProfit = 0;  // Track peak net profit (realized + unrealized)

    this.totalTrades = 0;
    this.slCount = 0;

    this.tradeHistory = [];

    this._onMarkPrice = this._onMarkPrice.bind(this);
    this._onBookTicker = this._onBookTicker.bind(this);
    this._onOrderFilled = this._onOrderFilled.bind(this);
    this._onOrderCancelled = this._onOrderCancelled.bind(this);
  }

  // ── Config helpers ──────────────────────────────────────────

  get _trapPercent() { return Number(config.trapPercent) || 1; }
  get _feeRate() { return config.feeRate != null ? Number(config.feeRate) : 0.0004; }

  _calcQuantity(price) {
    const equity = this.equity || Number(config.startingBalanceUSDT) || 200;
    const leverage = Number(config.leverage) || 10;
    const fraction = Number(config.equityFraction) || 0.9;
    const notional = equity * fraction * leverage;
    if (notional <= 0 || price <= 0) return 0;
    return Number((notional / price).toFixed(4));
  }

  // ── Lifecycle ───────────────────────────────────────────────

  async start() {
    this.equity = await this.api.getBalance();
    if (config.mode === "test") {
      const perf = store.getPerformance();
      this.equity = Number(config.startingBalanceUSDT) + Number(perf.netProfit || 0);
    }

    this.startPrice = await this.api.getMarkPrice(this.symbol);
    this.lastPrice = this.startPrice;

    // Calculate fixed entry prices
    this.longEntryPrice = this.startPrice * (1 + this._trapPercent / 100);
    this.shortEntryPrice = this.startPrice * (1 - this._trapPercent / 100);

    // Place initial entry orders
    await this._placeEntryOrder("LONG", this.longEntryPrice);
    await this._placeEntryOrder("SHORT", this.shortEntryPrice);

    this.api.on("markPrice", this._onMarkPrice);
    this.api.on("bookTicker", this._onBookTicker);
    this.api.on("orderFilled", this._onOrderFilled);
    this.api.on("orderCancelled", this._onOrderCancelled);

    log(`TRAP ${this.symbol}`, `Initialized @ ${fmt(this.startPrice, 6)} | LONG=${fmt(this.longEntryPrice, 6)} SHORT=${fmt(this.shortEntryPrice, 6)} SL=startPrice`);
    this._updateStore();
  }

  async _placeEntryOrder(direction, price) {
    const side = direction === "LONG" ? "BUY" : "SELL";
    const qty = this._calcQuantity(price);
    if (qty <= 0) return;
    const positionSide = direction;

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
      quantity: qty
    });

    log(`TRAP ${this.symbol}`, `Placed ${direction} entry @ ${fmt(price, 6)} qty=${qty}`);
  }

  async destroy(reason) {
    if (!this.active) return;
    this.active = false;

    this.api.off("markPrice", this._onMarkPrice);
    this.api.off("bookTicker", this._onBookTicker);
    this.api.off("orderFilled", this._onOrderFilled);
    this.api.off("orderCancelled", this._onOrderCancelled);

    // Cancel all pending entry orders
    for (const order of this.pendingEntriesById.values()) {
      try {
        await this.api.cancelOrder({ symbol: this.symbol, orderId: order.orderId });
      } catch (err) {
        log(`TRAP ${this.symbol}`, `Entry cancel failed ${order.orderId}: ${err.message}`);
      }
    }
    // Cancel all pending SL orders
    for (const order of this.pendingExitsById.values()) {
      try {
        await this.api.cancelOrder({ symbol: this.symbol, orderId: order.orderId });
      } catch (err) {
        log(`TRAP ${this.symbol}`, `SL cancel failed ${order.orderId}: ${err.message}`);
      }
    }
    await this.api.cancelAllOpenOrders(this.symbol);

    // Close all open positions
    const exitPrice = this.lastPrice || this.startPrice;
    for (const pos of Array.from(this.positions.values())) {
      await this._closePosition(pos, "destroy", exitPrice);
    }

    store.removeTrader(this.id, {
      id: this.id,
      symbol: this.symbol,
      realizedPnl: this.realizedPnl,
      feesPaid: this.feesPaid,
      totalTrades: this.totalTrades,
      slCount: this.slCount,
      highestNetProfit: this.highestNetProfit,
      createdAt: this.createdAt,
      closedAt: new Date().toISOString(),
      reason,
      startPrice: this.startPrice,
      endPrice: this.lastPrice
    });

    log(`TRAP ${this.symbol}`, `Destroyed (${reason}) | PnL $${fmt(this.realizedPnl)} | Trades=${this.totalTrades} | Peak=$${fmt(this.highestNetProfit)}`);
    if (this.onDestroy) this.onDestroy(this.symbol, this.realizedPnl);
  }

  // ── Order matching helper (from expansion trader) ──────────

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

  // ── Order events (live mode) ───────────────────────────────

  _onOrderFilled(event) {
    if (!this.active || event.symbol !== this.symbol) return;

    // Check if it's an entry fill
    const entryMatch = this._findPending(this.pendingEntriesById, event);
    if (entryMatch) {
      const entry = entryMatch.value;
      this.pendingEntriesById.delete(entryMatch.key);
      const entryPrice = Number(event.price || entry.price);
      const qty = Number(event.quantity || entry.quantity);

      const positionId = `POS-${event.orderId}`;
      const position = {
        id: positionId,
        direction: entry.direction,
        entryOrderId: event.orderId,
        entryPrice,
        quantity: qty,
        stopLossPrice: this.startPrice,  // SL is always startPrice
        slOrderId: null,
        isClosing: false
      };

      this.positions.set(positionId, position);
      this._placeStopLoss(position);

      log(`TRAP ${this.symbol}`, `Filled ${position.direction} @ ${fmt(entryPrice, 6)} qty=${qty} SL=${fmt(this.startPrice, 6)}`);
      this._updateStore();
      return;
    }

    // Check if it's an SL fill
    const exitMatch = this._findPending(this.pendingExitsById, event);
    if (!exitMatch) return;

    const pendingExit = exitMatch.value;
    this.pendingExitsById.delete(exitMatch.key);

    const position = this.positions.get(pendingExit.positionId);
    if (!position || position.isClosing) return;

    const exitPrice = Number(event.price || pendingExit.price);
    this._finalizeClose(position, "stop-loss", exitPrice, event.orderId);
  }

  _onOrderCancelled(event) {
    if (!this.active || event.symbol !== this.symbol) return;

    const entryMatch = this._findPending(this.pendingEntriesById, event);
    if (entryMatch) {
      log(`TRAP ${this.symbol}`, `Entry order ${event.status}: id=${event.orderId}`);
      this.pendingEntriesById.delete(entryMatch.key);
      this._updateStore();
      return;
    }

    const exitMatch = this._findPending(this.pendingExitsById, event);
    if (exitMatch) {
      const pendingExit = exitMatch.value;
      log(`TRAP ${this.symbol}`, `SL order ${event.status}: id=${event.orderId}`);
      this.pendingExitsById.delete(exitMatch.key);
      const position = this.positions.get(pendingExit.positionId);
      if (position && !position.isClosing) {
        log(`TRAP ${this.symbol}`, `SL REJECTED — closing at market`);
        const currentPrice = Number(this.lastPrice) || Number(position.entryPrice);
        this._closePosition(position, "sl-rejected", currentPrice);
      }
      this._updateStore();
      return;
    }
  }

  // ── SL placement (expansion trader pattern) ────────────────

  async _placeStopLoss(position) {
    const slSide = position.direction === "LONG" ? "SELL" : "BUY";
    const positionSide = position.direction;
    const currentPrice = Number(this.lastPrice) || Number(position.entryPrice);

    // Check if SL would immediately trigger
    const triggerHit = position.direction === "LONG"
      ? currentPrice <= position.stopLossPrice
      : currentPrice >= position.stopLossPrice;
    const closeToTrigger = Math.abs(currentPrice - position.stopLossPrice) <= (currentPrice * 0.0002);

    if (triggerHit || closeToTrigger) {
      log(`TRAP ${this.symbol}`, `SL trigger unsafe at ${fmt(currentPrice, 6)}; closing market now`);
      await this._closePosition(position, "stop-loss", currentPrice);
      return;
    }

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
      log(`TRAP ${this.symbol}`, `SL order placed id=${sl.orderId || ""} trigger=${fmt(position.stopLossPrice, 6)}`);
    } catch (err) {
      log(`TRAP ${this.symbol}`, `SL order failed: ${err.message}`);
      if (err.message && err.message.includes("-2021")) {
        log(`TRAP ${this.symbol}`, `SL would immediately trigger — closing at market`);
        await this._closePosition(position, "stop-loss", currentPrice);
        return;
      }
      throw err;
    }

    position.slOrderId = sl.orderId;
    this.pendingExitsById.set(sl.orderId, {
      orderId: sl.orderId,
      positionId: position.id,
      reason: "stop-loss",
      price: position.stopLossPrice
    });
  }

  // ── Position close ─────────────────────────────────────────

  async _closePosition(pos, reason, fallbackPrice) {
    const side = pos.direction === "LONG" ? "SELL" : "BUY";
    const positionSide = pos.direction;
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

    // Cancel SL order if exists
    if (pos.slOrderId) {
      try {
        await this.api.cancelOrder({ symbol: this.symbol, orderId: pos.slOrderId });
      } catch (_) {}
    }

    let pnl = this._calcPnl(pos, exitPrice);
    let fees = this._estimateFees(pos.entryPrice, exitPrice, pos.quantity);

    // In live mode, try to get actual PnL from Binance
    if (config.mode === "live") {
      try {
        const liveSummary = await this._getLiveTradeSummary(pos, exitOrderId);
        if (liveSummary) {
          pnl = liveSummary.grossPnl;
          fees = liveSummary.fees;
        }
      } catch (err) {
        log(`TRAP ${this.symbol}`, `Live PnL fetch failed: ${err.message}`);
      }
    }

    this.positions.delete(pos.id);
    const netPnl = pnl - fees;
    this.realizedPnl += netPnl;
    this.feesPaid += fees;
    this.totalTrades += 1;

    if (reason === "stop-loss" || reason === "sl-rejected") {
      this.slCount += 1;
    }

    this.tradeHistory.push({
      direction: pos.direction,
      entry: pos.entryPrice,
      exit: exitPrice,
      quantity: pos.quantity,
      grossPnl: pnl,
      fees,
      netPnl,
      reason,
      closedAt: new Date().toISOString()
    });

    store.recordTrade({ pnl, fees });

    log(`TRAP ${this.symbol}`, `Closed ${pos.direction} (${reason}) @ ${fmt(exitPrice, 6)} | PnL $${fmt(netPnl, 4)}`);

    // Update highest net profit
    this._trackHighestProfit();
    this._updateStore();

    // After SL hit, re-place the same entry order at the saved price
    if (this.active && (reason === "stop-loss" || reason === "sl-rejected")) {
      const reEntryPrice = pos.direction === "LONG" ? this.longEntryPrice : this.shortEntryPrice;
      await this._placeEntryOrder(pos.direction, reEntryPrice);
      this._updateStore();
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
    return notional * this._feeRate;
  }

  // ── Price feeds ─────────────────────────────────────────────

  async _onMarkPrice({ symbol, price }) {
    if (!this.active || symbol !== this.symbol) return;
    this.lastPrice = price;
    await this._maybeForceClose(price);
    this._trackHighestProfit();
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
    this._trackHighestProfit();
    this._updateStore();
  }

  // ── Test mode SL simulation (expansion trader pattern) ─────

  async _maybeForceClose(price) {
    if (config.mode !== "test" || this.positions.size === 0) return;
    for (const pos of Array.from(this.positions.values())) {
      if (pos.isClosing) continue;
      const hitSl = pos.direction === "LONG"
        ? price <= pos.stopLossPrice
        : price >= pos.stopLossPrice;
      if (!hitSl) continue;
      await this._finalizeClose(pos, "stop-loss", price, null);
      if (!this.active) return;
    }
  }

  // ── Unrealized PnL & peak tracking ─────────────────────────

  _calcUnrealizedPnl(price) {
    let pnl = 0;
    for (const pos of this.positions.values()) {
      const direction = pos.direction === "LONG" ? 1 : -1;
      pnl += (price - pos.entryPrice) * pos.quantity * direction;
    }
    return pnl;
  }

  _trackHighestProfit() {
    const price = this.lastPrice || this.startPrice || 0;
    const unrealized = this._calcUnrealizedPnl(price);
    const totalNet = this.realizedPnl + unrealized;
    if (totalNet > this.highestNetProfit) {
      this.highestNetProfit = totalNet;
    }
  }

  // ── Store sync ──────────────────────────────────────────────

  _updateStore() {
    if (!this.active) return;
    const price = this.lastPrice || this.startPrice || 0;
    const unrealized = this._calcUnrealizedPnl(price);
    this.unrealizedPnl = unrealized;

    // Build positions list for the frontend
    const openPositions = Array.from(this.positions.values()).map(pos => ({
      direction: pos.direction,
      entryPrice: pos.entryPrice,
      quantity: pos.quantity,
      stopLossPrice: pos.stopLossPrice,
      unrealizedPnl: (pos.direction === "LONG" ? 1 : -1) * (price - pos.entryPrice) * pos.quantity
    }));

    // Pending entries list
    const pendingEntries = Array.from(this.pendingEntriesById.values()).map(e => ({
      direction: e.direction,
      price: e.price,
      quantity: e.quantity
    }));

    store.upsertTrader({
      id: this.id,
      symbol: this.symbol,
      traderType: "TRAP",
      lastPrice: price,
      startPrice: this.startPrice,
      longEntryPrice: this.longEntryPrice,
      shortEntryPrice: this.shortEntryPrice,
      trapPercent: this._trapPercent,
      leverage: Number(config.leverage) || 10,
      openPositions,
      pendingEntries,
      totalTrades: this.totalTrades,
      slCount: this.slCount,
      realizedPnl: this.realizedPnl,
      unrealizedPnl: unrealized,
      feesPaid: this.feesPaid,
      highestNetProfit: this.highestNetProfit,
      tradeHistory: this.tradeHistory,
      createdAt: this.createdAt,
      status: this.active ? "ACTIVE" : "STOPPED"
    });
  }
}

module.exports = TrapTrader;
