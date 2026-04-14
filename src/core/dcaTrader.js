const config = require("../utils/config");
const { log } = require("../utils/logger");
const store = require("../state/store");

function fmt(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return Number(value).toFixed(digits);
}

/**
 * DCATrader — simple short strategy.
 *
 * On start: places a single market SHORT at the current price.
 * Take-profit = entry * (1 - round(changePercent / 10) / 100)
 * Stop-loss   = entry * (1 + stopLossPercent / 100)
 */
class DCATrader {
  constructor({ symbol, api, onDestroy, changePercent, equity }) {
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
    this.leverage = Number(config.leverage) || 2;
    this.equityFraction = Number(config.equityFraction) || 0.9;
    const eq = Number(equity) || Number(config.startingBalanceUSDT);
    const fixedNotional = Number(config.fixedNotional) || 200;
    // Use fixed notional as margin if equity covers it, otherwise fall back to fraction of equity
    this.margin = eq >= fixedNotional ? fixedNotional : eq * this.equityFraction;
    this.notional = this.margin * this.leverage;
    // TP% = round(24h change / 10), minimum 1%
    //this.takeProfitPercent = Math.max(1, Math.round(this.changePercent / 10));
    this.takeProfitPercent = 5;
    // Fixed SL%
    this.stopLossPercent = 50;

    this.entryPrice = 0;
    this.quantity = 0;
    this.tpPrice = 0;
    this.slPrice = 0;

    this.realizedPnl = 0;
    this.feesPaid = 0;
    this.unrealizedPnl = 0;
    this.highestNetProfit = 0;

    this.totalTrades = 0;
    this.tradeHistory = [];

    this._onMarkPrice = this._onMarkPrice.bind(this);
    this._onBookTicker = this._onBookTicker.bind(this);
  }

  // ── Config helpers ──────────────────────────────────────────

  get _feeRate() { return config.feeRate != null ? Number(config.feeRate) : 0.0004; }

  // ── Lifecycle ───────────────────────────────────────────────

  async start() {
    this.startPrice = await this.api.getMarkPrice(this.symbol);
    this.lastPrice = this.startPrice;

    const rawQty = Number((this.notional / this.startPrice).toFixed(4));

    const marketResult = await this.api.placeMarketOrder({
      symbol: this.symbol,
      side: "SELL",
      quantity: rawQty
    });

    // Use actual fill price and quantity from the exchange
    this.entryPrice = Number(marketResult.price) || this.startPrice;
    this.quantity = Number(marketResult.quantity) || rawQty;
    this.feesPaid += this.entryPrice * this.quantity * this._feeRate;

    this.tpPrice = this.entryPrice * (1 - this.takeProfitPercent / 100);
    this.slPrice = this.entryPrice * (1 + this.stopLossPercent / 100);

    this.api.on("markPrice", this._onMarkPrice);
    this.api.on("bookTicker", this._onBookTicker);

    log(`DCA ${this.symbol}`,
      `SHORT @ ${fmt(this.entryPrice, 6)} | qty=${this.quantity} ` +
      `margin=$${fmt(this.margin)} notional=$${fmt(this.notional)} ` +
      `lev=${this.leverage}x TP=${fmt(this.tpPrice, 6)} SL=${fmt(this.slPrice, 6)}`);
    this._updateStore();
  }

  // ── Price feeds ─────────────────────────────────────────────

  async _onMarkPrice({ symbol, price }) {
    if (!this.active || symbol !== this.symbol) return;
    this.lastPrice = price;
    await this._checkExits(price);
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
    await this._checkExits(price);
    this._trackHighestProfit();
    this._updateStore();
  }

  // ── TP / SL check ──────────────────────────────────────────

  async _checkExits(price) {
    if (!this.active) return;

    // Lifetime expiry
    const maxLifetime = Number(config.maxLifetimeMs) || 12 * 60 * 60 * 1000;
    if (Date.now() - new Date(this.createdAt).getTime() >= maxLifetime) {
      log(`DCA ${this.symbol}`, `Max lifetime reached`);
      await this.destroy("expired");
      return;
    }

    if (price <= this.tpPrice) {
      log(`DCA ${this.symbol}`, `TP hit @ ${fmt(price, 6)} <= ${fmt(this.tpPrice, 6)}`);
      await this.destroy("take-profit");
    } else if (price >= this.slPrice) {
      log(`DCA ${this.symbol}`, `SL hit @ ${fmt(price, 6)} >= ${fmt(this.slPrice, 6)}`);
      await this.destroy("stop-loss");
    }
  }

  // ── Destroy ─────────────────────────────────────────────────

  async destroy(reason) {
    if (!this.active) return;
    this.active = false;

    this.api.off("markPrice", this._onMarkPrice);
    this.api.off("bookTicker", this._onBookTicker);

    await this.api.cancelAllOpenOrders(this.symbol);

    // Use TP/SL price as exit when triggered by those conditions,
    // not lastPrice which could have gapped past the target
    let exitPrice = this.lastPrice || this.startPrice;
    if (reason === "take-profit") exitPrice = this.tpPrice;
    else if (reason === "stop-loss") exitPrice = this.slPrice;

    const grossPnl = (this.entryPrice - exitPrice) * this.quantity;
    const closeFees = exitPrice * this.quantity * this._feeRate;

    await this.api.placeMarketOrder({
      symbol: this.symbol,
      side: "BUY",
      quantity: this.quantity
    });

    this.feesPaid += closeFees;
    this.realizedPnl = grossPnl - this.feesPaid;
    this.totalTrades = 1;

    this.tradeHistory.push({
      direction: "SHORT",
      entry: this.entryPrice,
      exit: exitPrice,
      quantity: this.quantity,
      grossPnl,
      fees: this.feesPaid,
      netPnl: grossPnl - this.feesPaid,
      reason,
      closedAt: new Date().toISOString()
    });

    store.recordTrade({ pnl: grossPnl, fees: this.feesPaid });

    store.removeTrader(this.id, {
      id: this.id,
      symbol: this.symbol,
      changePercent: this.changePercent,
      realizedPnl: this.realizedPnl,
      feesPaid: this.feesPaid,
      totalTrades: this.totalTrades,
      highestNetProfit: this.highestNetProfit,
      createdAt: this.createdAt,
      closedAt: new Date().toISOString(),
      reason,
      startPrice: this.startPrice,
      endPrice: this.lastPrice,
      entryPrice: this.entryPrice
    });

    log(`DCA ${this.symbol}`, `Destroyed (${reason}) | PnL $${fmt(this.realizedPnl)}`);
    if (this.onDestroy) this.onDestroy(this.symbol, this.realizedPnl, reason);
  }

  // ── PnL helpers ─────────────────────────────────────────────

  _calcUnrealizedPnl(price) {
    return (this.entryPrice - price) * this.quantity;
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
      entryPrice: this.entryPrice,
      leverage: this.leverage,
      notional: this.notional,
      margin: this.margin,
      takeProfitPercent: this.takeProfitPercent,
      stopLossPercent: this.stopLossPercent,
      quantity: this.quantity,
      tpPrice: this.tpPrice,
      slPrice: this.slPrice,
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
