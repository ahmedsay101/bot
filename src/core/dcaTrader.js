const config = require("../utils/config");
const { log } = require("../utils/logger");
const store = require("../state/store");

function fmt(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return Number(value).toFixed(digits);
}

/**
 * DCATrader â€” dual-position (hedge) strategy.
 *
 * On start, opens one LONG and one SHORT market position simultaneously.
 * Both have TP at 1% and SL at 10%.
 * Trader is destroyed when both hit TP, or when either hits SL.
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

    this.leverage = Number(config.leverage) || 2;
    const eq = Number(equity) || Number(config.startingBalanceUSDT);
    const fixedNotional = Number(config.fixedNotional) || 200;
    this.margin = eq >= fixedNotional ? fixedNotional : eq * (Number(config.equityFraction) || 0.9);
    this.notional = this.margin * this.leverage;

    this.takeProfitPercent = Number(config.takeProfitPercent) || 1;
    this.stopLossPercent = Number(config.stopLossPercent) || 10;

    // Dual-position state
    this.long = { active: false, entryPrice: 0, quantity: 0, tpPrice: 0, slPrice: 0 };
    this.short = { active: false, entryPrice: 0, quantity: 0, tpPrice: 0, slPrice: 0 };

    this.realizedPnl = 0;
    this.feesPaid = 0;
    this.unrealizedPnl = 0;
    this.highestNetProfit = 0;

    this.totalTrades = 0;
    this.tradeHistory = [];

    this._processing = false;
    this._onMarkPrice = this._onMarkPrice.bind(this);
    this._onBookTicker = this._onBookTicker.bind(this);
  }

  get _feeRate() { return config.feeRate != null ? Number(config.feeRate) : 0.0004; }

  // â”€â”€ Lifecycle â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  async start() {
    this.startPrice = await this.api.getMarkPrice(this.symbol);
    this.lastPrice = this.startPrice;

    await this._openBothPositions();

    this.api.on("markPrice", this._onMarkPrice);
    this.api.on("bookTicker", this._onBookTicker);

    this._updateStore();
  }

  async _openBothPositions() {
    const price = this.lastPrice || this.startPrice;
    const rawQty = Number((this.notional / price).toFixed(4));

    // Open LONG
    const longResult = await this.api.placeMarketOrder({
      symbol: this.symbol, side: "BUY", quantity: rawQty
    });
    this.long.entryPrice = Number(longResult.price) || price;
    this.long.quantity = Number(longResult.quantity) || rawQty;
    this.long.tpPrice = parseFloat((this.long.entryPrice * (1 + this.takeProfitPercent / 100)).toFixed(8));
    this.long.slPrice = parseFloat((this.long.entryPrice * (1 - this.stopLossPercent / 100)).toFixed(8));
    this.long.active = true;
    this.feesPaid += this.long.entryPrice * this.long.quantity * this._feeRate;

    // Open SHORT
    const shortResult = await this.api.placeMarketOrder({
      symbol: this.symbol, side: "SELL", quantity: rawQty
    });
    this.short.entryPrice = Number(shortResult.price) || price;
    this.short.quantity = Number(shortResult.quantity) || rawQty;
    this.short.tpPrice = parseFloat((this.short.entryPrice * (1 - this.takeProfitPercent / 100)).toFixed(8));
    this.short.slPrice = parseFloat((this.short.entryPrice * (1 + this.stopLossPercent / 100)).toFixed(8));
    this.short.active = true;
    this.feesPaid += this.short.entryPrice * this.short.quantity * this._feeRate;

    log(`DCA ${this.symbol}`,
      `LONG @ ${fmt(this.long.entryPrice, 6)} TP=${fmt(this.long.tpPrice, 6)} SL=${fmt(this.long.slPrice, 6)} | ` +
      `SHORT @ ${fmt(this.short.entryPrice, 6)} TP=${fmt(this.short.tpPrice, 6)} SL=${fmt(this.short.slPrice, 6)} | ` +
      `qty=${rawQty}`);
  }

  // â”€â”€ Price feeds â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

  // â”€â”€ TP / SL check â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  async _checkExits(price) {
    if (!this.active || this._processing) return;
    this._processing = true;
    try {
      // Lifetime expiry
      const maxLifetime = Number(config.maxLifetimeMs) || 24 * 60 * 60 * 1000;
      if (Date.now() - new Date(this.createdAt).getTime() >= maxLifetime) {
        log(`DCA ${this.symbol}`, `Max lifetime reached`);
        await this.destroy("expired");
        return;
      }

      // Check LONG SL
      if (this.long.active && price <= this.long.slPrice) {
        log(`DCA ${this.symbol}`, `LONG SL hit @ ${fmt(price, 6)}`);
        await this._closeLeg("long", this.long.slPrice, "stop-loss");
        await this.destroy("stop-loss");
        return;
      }

      // Check SHORT SL
      if (this.short.active && price >= this.short.slPrice) {
        log(`DCA ${this.symbol}`, `SHORT SL hit @ ${fmt(price, 6)}`);
        await this._closeLeg("short", this.short.slPrice, "stop-loss");
        await this.destroy("stop-loss");
        return;
      }

      // Check LONG TP
      if (this.long.active && price >= this.long.tpPrice) {
        log(`DCA ${this.symbol}`, `LONG TP hit @ ${fmt(price, 6)}`);
        await this._closeLeg("long", this.long.tpPrice, "take-profit");
      }

      // Check SHORT TP
      if (this.short.active && price <= this.short.tpPrice) {
        log(`DCA ${this.symbol}`, `SHORT TP hit @ ${fmt(price, 6)}`);
        await this._closeLeg("short", this.short.tpPrice, "take-profit");
      }

      // Both TPs hit â†’ done
      if (!this.long.active && !this.short.active) {
        await this.destroy("take-profit");
      }
    } finally {
      this._processing = false;
    }
  }

  async _closeLeg(side, exitPrice, reason) {
    const leg = side === "long" ? this.long : this.short;
    if (!leg.active) return;
    leg.active = false;

    const closeSide = side === "long" ? "SELL" : "BUY";
    const grossPnl = side === "long"
      ? (exitPrice - leg.entryPrice) * leg.quantity
      : (leg.entryPrice - exitPrice) * leg.quantity;
    const closeFee = exitPrice * leg.quantity * this._feeRate;

    await this.api.placeMarketOrder({
      symbol: this.symbol, side: closeSide, quantity: leg.quantity
    });

    this.feesPaid += closeFee;
    this.realizedPnl += grossPnl - closeFee;
    this.totalTrades += 1;

    this.tradeHistory.push({
      direction: side === "long" ? "LONG" : "SHORT",
      entry: leg.entryPrice,
      exit: exitPrice,
      quantity: leg.quantity,
      grossPnl,
      fees: closeFee,
      netPnl: grossPnl - closeFee,
      reason,
      closedAt: new Date().toISOString()
    });

    store.recordTrade({ pnl: grossPnl, fees: closeFee });
  }

  // â”€â”€ Destroy â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  async destroy(reason) {
    if (!this.active) return;
    this.active = false;

    this.api.off("markPrice", this._onMarkPrice);
    this.api.off("bookTicker", this._onBookTicker);

    await this.api.cancelAllOpenOrders(this.symbol);

    // Close any remaining open legs (e.g. on SL, the other leg is still open)
    if (this.long.active) {
      const exitPrice = this.lastPrice || this.startPrice;
      await this._closeLeg("long", exitPrice, reason);
    }
    if (this.short.active) {
      const exitPrice = this.lastPrice || this.startPrice;
      await this._closeLeg("short", exitPrice, reason);
    }

    const destroyReason = reason === "stop-loss" ? "max-loss" : reason;

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
      reason: destroyReason,
      startPrice: this.startPrice,
      endPrice: this.lastPrice
    });

    log(`DCA ${this.symbol}`,
      `Destroyed (${destroyReason}) | PnL $${fmt(this.realizedPnl)}`);
    if (this.onDestroy) this.onDestroy(this.symbol, this.realizedPnl, destroyReason);
  }

  // â”€â”€ PnL helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  _calcUnrealizedPnl(price) {
    let pnl = 0;
    if (this.long.active) pnl += (price - this.long.entryPrice) * this.long.quantity;
    if (this.short.active) pnl += (this.short.entryPrice - price) * this.short.quantity;
    return pnl;
  }

  _trackHighestProfit() {
    const price = this.lastPrice || this.startPrice || 0;
    const unrealized = this._calcUnrealizedPnl(price);
    const totalNet = this.realizedPnl + unrealized - this.feesPaid;
    if (totalNet > this.highestNetProfit) this.highestNetProfit = totalNet;
  }

  // â”€â”€ Store sync â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  _updateStore() {
    if (!this.active) return;
    const price = this.lastPrice || this.startPrice || 0;
    const unrealized = this._calcUnrealizedPnl(price);
    this.unrealizedPnl = unrealized;

    store.upsertTrader({
      id: this.id,
      symbol: this.symbol,
      traderType: "HEDGE",
      longActive: this.long.active,
      shortActive: this.short.active,
      longEntry: this.long.entryPrice,
      shortEntry: this.short.entryPrice,
      longTp: this.long.tpPrice,
      shortTp: this.short.tpPrice,
      longSl: this.long.slPrice,
      shortSl: this.short.slPrice,
      lastPrice: price,
      startPrice: this.startPrice,
      leverage: this.leverage,
      notional: this.notional,
      margin: this.margin,
      takeProfitPercent: this.takeProfitPercent,
      stopLossPercent: this.stopLossPercent,
      quantity: this.long.quantity,
      totalTrades: this.totalTrades,
      realizedPnl: this.realizedPnl,
      unrealizedPnl: unrealized,
      feesPaid: this.feesPaid,
      highestNetProfit: this.highestNetProfit,
      tradeHistory: this.tradeHistory,
      createdAt: this.createdAt,
      status: "ACTIVE"
    });
  }
}

module.exports = DCATrader;
