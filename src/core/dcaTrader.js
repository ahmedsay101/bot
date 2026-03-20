const config = require("../utils/config");
const { log } = require("../utils/logger");
const store = require("../state/store");

function fmt(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return Number(value).toFixed(digits);
}

/**
 * DCATrader — short-side dollar-cost-averaging strategy.
 *
 * On start:
 *   1. Places a market SHORT at the current price (level 0).
 *   2. Places (numOrders - 1) limit SELL orders at increasing distances above
 *      the start price: startPrice * (1 + i * distancePercent / 100).
 *
 * Each order has a fixed notional (notionalPerOrder * leverage).
 * As orders fill, the weighted average entry price is recalculated and the
 * take-profit target is set to averagePrice * (1 - takeProfitPercent / 100).
 *
 * When the mark price drops to or below the TP target, all positions are
 * closed with a market BUY and the trader self-destructs.
 */
class DCATrader {
  constructor({ symbol, api, onDestroy, changePercent }) {
    this.id = `${symbol}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    this.symbol = symbol;
    this.api = api;
    this.onDestroy = onDestroy;
    this.changePercent = Number(changePercent) || 0;

    this.active = true;
    this.createdAt = new Date().toISOString();
    this.startPrice = null;
    this.lastPrice = null;

    // Configurable parameters
    this.numOrders = Number(config.numOrders) || 5;
    this.distancePercent = Number(config.distancePercent) || 50;
    this.notionalPerOrder = Number(config.notionalPerOrder) || 50;
    this.leverage = Number(config.leverage) || 1;
    this.takeProfitPercent = Number(config.takeProfitPercent) || 10;

    // Order tracking: [{ level, targetPrice, quantity, filled, fillPrice, orderId }]
    this.orders = [];
    this.pendingOrdersById = new Map(); // orderId → order index

    this.averagePrice = 0;
    this.tpPrice = 0;
    this.filledCount = 0;
    this.totalFilledQty = 0;

    this.realizedPnl = 0;
    this.feesPaid = 0;
    this.unrealizedPnl = 0;
    this.highestNetProfit = 0;

    this.totalTrades = 0;
    this.tradeHistory = [];

    this._onMarkPrice = this._onMarkPrice.bind(this);
    this._onBookTicker = this._onBookTicker.bind(this);
    this._onOrderFilled = this._onOrderFilled.bind(this);
  }

  // ── Config helpers ──────────────────────────────────────────

  get _feeRate() { return config.feeRate != null ? Number(config.feeRate) : 0.0004; }

  // ── Lifecycle ───────────────────────────────────────────────

  async start() {
    this.startPrice = await this.api.getMarkPrice(this.symbol);
    this.lastPrice = this.startPrice;

    // Build order levels
    for (let i = 0; i < this.numOrders; i++) {
      const targetPrice = this.startPrice * (1 + i * this.distancePercent / 100);
      const quantity = Number((this.notionalPerOrder * this.leverage / targetPrice).toFixed(4));
      this.orders.push({
        level: i,
        targetPrice,
        quantity,
        filled: false,
        fillPrice: null,
        orderId: null
      });
    }

    // Level 0: market order (immediate fill)
    const first = this.orders[0];
    const marketResult = await this.api.placeMarketOrder({
      symbol: this.symbol,
      side: "SELL",
      quantity: first.quantity
    });

    first.filled = true;
    first.fillPrice = Number(marketResult.price) || this.startPrice;
    first.orderId = marketResult.orderId;
    this.filledCount = 1;
    this.totalFilledQty = first.quantity;
    this.feesPaid += first.fillPrice * first.quantity * this._feeRate;
    this._recalculateAverage();

    // Levels 1..N: limit SELL orders
    for (let i = 1; i < this.numOrders; i++) {
      await this._placeLimitOrder(i);
    }

    this.api.on("markPrice", this._onMarkPrice);
    this.api.on("bookTicker", this._onBookTicker);
    this.api.on("orderFilled", this._onOrderFilled);

    log(`DCA ${this.symbol}`,
      `Init @ ${fmt(this.startPrice, 6)} | orders=${this.numOrders} dist=${this.distancePercent}% ` +
      `notional=$${this.notionalPerOrder} lev=${this.leverage}x TP=${this.takeProfitPercent}%`);
    this._updateStore();
  }

  async _placeLimitOrder(orderIndex) {
    const order = this.orders[orderIndex];
    if (!order || order.filled) return;

    const result = await this.api.placeLimitOrder({
      symbol: this.symbol,
      side: "SELL",
      quantity: order.quantity,
      price: Number(order.targetPrice.toFixed(6))
    });

    order.orderId = result.orderId;
    this.pendingOrdersById.set(result.orderId, orderIndex);

    log(`DCA ${this.symbol}`, `Limit SELL #${orderIndex} @ ${fmt(order.targetPrice, 6)} qty=${order.quantity}`);
  }

  // ── Average & TP calculation ────────────────────────────────

  _recalculateAverage() {
    let totalNotional = 0;
    let totalQty = 0;
    for (const order of this.orders) {
      if (!order.filled) continue;
      totalNotional += order.fillPrice * order.quantity;
      totalQty += order.quantity;
    }
    this.totalFilledQty = totalQty;
    this.averagePrice = totalQty > 0 ? totalNotional / totalQty : 0;
    this.tpPrice = this.averagePrice * (1 - this.takeProfitPercent / 100);
  }

  // ── Order fill event ────────────────────────────────────────

  _findPendingIndex(event) {
    let idx = this.pendingOrdersById.get(event.orderId);
    if (idx !== undefined) return { key: event.orderId, idx };
    if (event.numericOrderId !== undefined) {
      idx = this.pendingOrdersById.get(event.numericOrderId);
      if (idx !== undefined) return { key: event.numericOrderId, idx };
      idx = this.pendingOrdersById.get(String(event.numericOrderId));
      if (idx !== undefined) return { key: String(event.numericOrderId), idx };
    }
    if (typeof event.orderId === "number") {
      idx = this.pendingOrdersById.get(String(event.orderId));
      if (idx !== undefined) return { key: String(event.orderId), idx };
    } else if (typeof event.orderId === "string" && /^\d+$/.test(event.orderId)) {
      idx = this.pendingOrdersById.get(Number(event.orderId));
      if (idx !== undefined) return { key: Number(event.orderId), idx };
    }
    return null;
  }

  _onOrderFilled(event) {
    if (!this.active || event.symbol !== this.symbol) return;

    const match = this._findPendingIndex(event);
    if (match === null) return;

    const order = this.orders[match.idx];
    if (!order || order.filled) return;

    this.pendingOrdersById.delete(match.key);
    order.filled = true;
    order.fillPrice = Number(event.price || order.targetPrice);
    this.feesPaid += order.fillPrice * order.quantity * this._feeRate;
    this.filledCount += 1;
    this._recalculateAverage();

    log(`DCA ${this.symbol}`,
      `Filled SELL #${match.idx} @ ${fmt(order.fillPrice, 6)} | ` +
      `avg=${fmt(this.averagePrice, 6)} TP=${fmt(this.tpPrice, 6)} (${this.filledCount}/${this.numOrders})`);
    this._updateStore();
  }

  // ── Price feeds ─────────────────────────────────────────────

  async _onMarkPrice({ symbol, price }) {
    if (!this.active || symbol !== this.symbol) return;
    this.lastPrice = price;
    await this._simulateFills(price);
    await this._checkTakeProfit(price);
    this._trackHighestProfit();
    this._updateStore();
  }

  async _onBookTicker({ symbol, bid, ask }) {
    if (!this.active || symbol !== this.symbol) return;
    const bidNum = Number(bid);
    const askNum = Number(ask);
    let price = null;
    if (Number.isFinite(bidNum) && Number.isFinite(askNum)) price = (bidNum + askNum) / 2;
    else if (Number.isFinite(bidNum)) price = bidNum;
    else if (Number.isFinite(askNum)) price = askNum;
    if (!Number.isFinite(price)) return;
    this.lastPrice = price;
    await this._simulateFills(price);
    await this._checkTakeProfit(price);
    this._trackHighestProfit();
    this._updateStore();
  }

  // ── Test-mode fill simulation ───────────────────────────────

  async _simulateFills(price) {
    if (config.mode !== "test") return;
    for (let i = 0; i < this.orders.length; i++) {
      const order = this.orders[i];
      if (order.filled) continue;
      // Limit SELL fills when price >= target
      if (price >= order.targetPrice) {
        this.pendingOrdersById.delete(order.orderId);
        order.filled = true;
        order.fillPrice = order.targetPrice;
        this.feesPaid += order.fillPrice * order.quantity * this._feeRate;
        this.filledCount += 1;
        this._recalculateAverage();
        log(`DCA ${this.symbol}`,
          `[SIM] Filled SELL #${i} @ ${fmt(order.fillPrice, 6)} | ` +
          `avg=${fmt(this.averagePrice, 6)} TP=${fmt(this.tpPrice, 6)}`);
      }
    }
  }

  // ── Take-profit check ───────────────────────────────────────

  async _checkTakeProfit(price) {
    if (!this.active || this.filledCount === 0) return;
    if (price <= this.tpPrice) {
      log(`DCA ${this.symbol}`, `TP hit @ ${fmt(price, 6)} <= ${fmt(this.tpPrice, 6)}`);
      await this.destroy("take-profit");
    }
  }

  // ── Destroy ─────────────────────────────────────────────────

  async destroy(reason) {
    if (!this.active) return;
    this.active = false;

    this.api.off("markPrice", this._onMarkPrice);
    this.api.off("bookTicker", this._onBookTicker);
    this.api.off("orderFilled", this._onOrderFilled);

    // Cancel unfilled limit orders
    for (const order of this.orders) {
      if (order.filled || !order.orderId) continue;
      try { await this.api.cancelOrder({ symbol: this.symbol, orderId: order.orderId }); } catch (_) {}
    }
    await this.api.cancelAllOpenOrders(this.symbol);

    // Close position if any filled orders
    if (this.filledCount > 0 && this.totalFilledQty > 0) {
      const exitPrice = this.lastPrice || this.startPrice;
      let grossPnl = 0;
      let closeFees = 0;
      for (const order of this.orders) {
        if (!order.filled) continue;
        grossPnl += (order.fillPrice - exitPrice) * order.quantity;
        closeFees += exitPrice * order.quantity * this._feeRate;
      }

      await this.api.placeMarketOrder({
        symbol: this.symbol,
        side: "BUY",
        quantity: Number(this.totalFilledQty.toFixed(4))
      });

      this.feesPaid += closeFees;
      this.realizedPnl = grossPnl - this.feesPaid;
      this.totalTrades = 1;

      this.tradeHistory.push({
        direction: "SHORT",
        entry: this.averagePrice,
        exit: exitPrice,
        quantity: this.totalFilledQty,
        grossPnl,
        fees: this.feesPaid,
        netPnl: grossPnl - this.feesPaid,
        reason,
        closedAt: new Date().toISOString()
      });

      store.recordTrade({ pnl: grossPnl, fees: this.feesPaid });
    }

    store.removeTrader(this.id, {
      id: this.id,
      symbol: this.symbol,
      realizedPnl: this.realizedPnl,
      feesPaid: this.feesPaid,
      totalTrades: this.totalTrades,
      filledCount: this.filledCount,
      highestNetProfit: this.highestNetProfit,
      createdAt: this.createdAt,
      closedAt: new Date().toISOString(),
      reason,
      startPrice: this.startPrice,
      endPrice: this.lastPrice,
      averagePrice: this.averagePrice
    });

    log(`DCA ${this.symbol}`, `Destroyed (${reason}) | PnL $${fmt(this.realizedPnl)} | Filled=${this.filledCount}/${this.numOrders}`);
    if (this.onDestroy) this.onDestroy(this.symbol, this.realizedPnl, reason);
  }

  // ── PnL helpers ─────────────────────────────────────────────

  _calcUnrealizedPnl(price) {
    let pnl = 0;
    for (const order of this.orders) {
      if (!order.filled) continue;
      pnl += (order.fillPrice - price) * order.quantity;
    }
    return pnl;
  }

  _trackHighestProfit() {
    const price = this.lastPrice || this.startPrice || 0;
    const unrealized = this._calcUnrealizedPnl(price);
    const totalNet = unrealized - this.feesPaid;
    if (totalNet > this.highestNetProfit) this.highestNetProfit = totalNet;
  }

  // ── Store sync ──────────────────────────────────────────────

  _updateStore() {
    if (!this.active) return;
    const price = this.lastPrice || this.startPrice || 0;
    const unrealized = this._calcUnrealizedPnl(price);
    this.unrealizedPnl = unrealized;

    store.upsertTrader({
      id: this.id,
      symbol: this.symbol,
      traderType: "DCA",
      lastPrice: price,
      startPrice: this.startPrice,
      leverage: this.leverage,
      numOrders: this.numOrders,
      distancePercent: this.distancePercent,
      notionalPerOrder: this.notionalPerOrder,
      takeProfitPercent: this.takeProfitPercent,
      orders: this.orders.map(o => ({
        level: o.level,
        targetPrice: o.targetPrice,
        quantity: o.quantity,
        filled: o.filled,
        fillPrice: o.fillPrice
      })),
      averagePrice: this.averagePrice,
      tpPrice: this.tpPrice,
      filledCount: this.filledCount,
      totalFilledQty: this.totalFilledQty,
      totalTrades: this.totalTrades,
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

module.exports = DCATrader;
