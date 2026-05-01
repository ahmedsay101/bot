const config = require("../utils/config");
const { log } = require("../utils/logger");
const store = require("../state/store");

function fmt(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return Number(value).toFixed(digits);
}

/**
 * Trader — sequential SHORT/LONG strategy.
 *
 * Lifecycle:
 *   1. Open SHORT.
 *   2. On TP hit  → accumulatedTp += tp%, open another SAME-side position.
 *   3. On SL hit  → accumulatedSl += sl%, open another OPPOSITE-side position.
 *   4. After every close, destroy when accumulatedTp - accumulatedSl >= profitTargetPercent.
 *
 * All positions use the SAME sizing: margin = liveBalance × equityFraction; notional = margin × leverage.
 */
class Trader {
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

    this.equityFraction = Number(config.equityFraction) || 0.1;
    this.leverage = Number(config.leverage) || 1;
    this.margin = 0;
    this.notional = 0;

    this.takeProfitPercent = Number(config.takeProfitPercent) || 1;
    this.stopLossPercent = Number(config.stopLossPercent) || 5;
    this.profitTargetPercent = Number(config.profitTargetPercent) || 5;

    this.direction = "SHORT";
    this.transactionCount = 0;            // total positions opened (incl. current)
    this.accumulatedTpPercent = 0;
    this.accumulatedSlPercent = 0;

    this.entryPrice = 0;
    this.quantity = 0;
    this.tpPrice = 0;
    this.slPrice = 0;
    this._positionOpen = false;

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

  get netProfitPercent() { return this.accumulatedTpPercent - this.accumulatedSlPercent; }

  // ── Lifecycle ───────────────────────────────────────────────

  async start() {
    this.startPrice = await this.api.getMarkPrice(this.symbol);
    this.lastPrice = this.startPrice;

    await this._openPosition("SHORT");

    this.api.on("markPrice", this._onMarkPrice);
    this.api.on("bookTicker", this._onBookTicker);

    this._updateStore();
  }

  async _openPosition(direction) {
    this.direction = direction;

    const perf = store.getPerformance();
    const liveBalance = Number(config.startingBalanceUSDT) + Number(perf.netProfit || 0);
    this.margin = liveBalance * this.equityFraction;
    this.notional = this.margin * this.leverage;

    const side = direction === "SHORT" ? "SELL" : "BUY";
    const price = this.lastPrice || this.startPrice;
    const rawQty = Number((this.notional / price).toFixed(4));

    const result = await this.api.placeMarketOrder({
      symbol: this.symbol,
      side,
      quantity: rawQty
    });

    this.entryPrice = Number(result.price) || price;
    this.quantity = Number(result.quantity) || rawQty;
    const entryFee = this.entryPrice * this.quantity * this._feeRate;
    this.feesPaid += entryFee;
    store.recordFee(entryFee);

    this._setExitPrices();
    this._positionOpen = true;
    this.transactionCount += 1;

    log(`TRADER ${this.symbol}`,
      `${direction} #${this.transactionCount} @ ${fmt(this.entryPrice, 6)} | qty=${this.quantity} ` +
      `lev=${this.leverage}x notional=$${fmt(this.notional)} ` +
      `TP=${fmt(this.tpPrice, 6)} SL=${fmt(this.slPrice, 6)} ` +
      `accTp=${fmt(this.accumulatedTpPercent)}% accSl=${fmt(this.accumulatedSlPercent)}%`);
  }

  _setExitPrices() {
    if (this.direction === "SHORT") {
      this.tpPrice = this.entryPrice * (1 - this.takeProfitPercent / 100);
      this.slPrice = this.entryPrice * (1 + this.stopLossPercent / 100);
    } else {
      this.tpPrice = this.entryPrice * (1 + this.takeProfitPercent / 100);
      this.slPrice = this.entryPrice * (1 - this.stopLossPercent / 100);
    }
  }

  // ── Price feeds ─────────────────────────────────────────────

  async _onMarkPrice({ symbol, price }) {
    if (!this.active || symbol !== this.symbol) return;
    this.lastPrice = Number(price);
    await this._checkExits(this.lastPrice);
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

  // ── Exit checks ─────────────────────────────────────────────

  async _checkExits(price) {
    if (!this.active || this._processing || !this._positionOpen) return;
    this._processing = true;
    try {
      const maxLifetime = Number(config.maxLifetimeMs) || 24 * 60 * 60 * 1000;
      if (Date.now() - new Date(this.createdAt).getTime() >= maxLifetime) {
        log(`TRADER ${this.symbol}`, `Max lifetime reached`);
        await this.destroy("expired");
        return;
      }

      const tpHit = this.direction === "SHORT" ? price <= this.tpPrice : price >= this.tpPrice;
      const slHit = this.direction === "SHORT" ? price >= this.slPrice : price <= this.slPrice;

      if (tpHit) {
        await this._handleTakeProfit(price);
      } else if (slHit) {
        await this._handleStopLoss(price);
      }
    } finally {
      this._processing = false;
    }
  }

  async _closeCurrentPosition(exitPrice, reason) {
    const closeSide = this.direction === "SHORT" ? "BUY" : "SELL";
    const grossPnl = this.direction === "SHORT"
      ? (this.entryPrice - exitPrice) * this.quantity
      : (exitPrice - this.entryPrice) * this.quantity;
    const closeFee = exitPrice * this.quantity * this._feeRate;

    await this.api.placeMarketOrder({
      symbol: this.symbol,
      side: closeSide,
      quantity: this.quantity
    });

    this.feesPaid += closeFee;
    this.realizedPnl += grossPnl - closeFee;
    this.totalTrades += 1;
    this._positionOpen = false;

    this.tradeHistory.push({
      direction: this.direction,
      entry: this.entryPrice,
      exit: exitPrice,
      quantity: this.quantity,
      grossPnl,
      fees: closeFee,
      netPnl: grossPnl - closeFee,
      reason,
      closedAt: new Date().toISOString()
    });

    store.recordTrade({ pnl: grossPnl, fees: closeFee });
    return grossPnl - closeFee;
  }

  async _handleTakeProfit(price) {
    const exitPrice = Number(price) || this.tpPrice;
    log(`TRADER ${this.symbol}`,
      `TP hit @ ${fmt(exitPrice, 6)} (${this.direction}) | tp%=${this.takeProfitPercent}`);

    await this._closeCurrentPosition(exitPrice, "take-profit");
    this.accumulatedTpPercent += this.takeProfitPercent;

    log(`TRADER ${this.symbol}`,
      `accTp=${fmt(this.accumulatedTpPercent)}% accSl=${fmt(this.accumulatedSlPercent)}% ` +
      `net=${fmt(this.netProfitPercent)}% (target ${this.profitTargetPercent}%)`);

    if (this.netProfitPercent >= this.profitTargetPercent) {
      log(`TRADER ${this.symbol}`,
        `Profit target reached (${fmt(this.netProfitPercent)}% ≥ ${this.profitTargetPercent}%) — destroying`);
      await this.destroy("profit-target");
      return;
    }

    // Open another SAME-side position.
    await this._openPosition(this.direction);
    this._updateStore();
  }

  async _handleStopLoss(price) {
    const exitPrice = Number(price) || this.slPrice;
    log(`TRADER ${this.symbol}`,
      `SL hit @ ${fmt(exitPrice, 6)} (${this.direction}) | sl%=${this.stopLossPercent}`);

    await this._closeCurrentPosition(exitPrice, "stop-loss");
    this.accumulatedSlPercent += this.stopLossPercent;

    log(`TRADER ${this.symbol}`,
      `accTp=${fmt(this.accumulatedTpPercent)}% accSl=${fmt(this.accumulatedSlPercent)}% ` +
      `net=${fmt(this.netProfitPercent)}% (target ${this.profitTargetPercent}%)`);

    // Open OPPOSITE-side position.
    const nextDir = this.direction === "SHORT" ? "LONG" : "SHORT";
    await this._openPosition(nextDir);
    this._updateStore();
  }

  // ── Destroy ─────────────────────────────────────────────────

  async destroy(reason) {
    if (!this.active) return;
    this.active = false;

    this.api.off("markPrice", this._onMarkPrice);
    this.api.off("bookTicker", this._onBookTicker);

    try { await this.api.cancelAllOpenOrders(this.symbol); } catch (_) {}

    // Close any open position. _handleTakeProfit / _handleStopLoss already closed
    // and cleared _positionOpen, so this only fires for manual / expired / start-failed.
    if (this._positionOpen) {
      const exitPrice = Number(this.lastPrice) || this.entryPrice || this.startPrice;
      try { await this._closeCurrentPosition(exitPrice, reason); } catch (err) {
        log(`TRADER ${this.symbol}`, `Close on destroy failed: ${err.message}`);
      }
    }

    store.removeTrader(this.id, {
      id: this.id,
      symbol: this.symbol,
      changePercent: this.changePercent,
      direction: this.direction,
      transactionCount: this.transactionCount,
      accumulatedTpPercent: this.accumulatedTpPercent,
      accumulatedSlPercent: this.accumulatedSlPercent,
      netProfitPercent: this.netProfitPercent,
      profitTargetPercent: this.profitTargetPercent,
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

    log(`TRADER ${this.symbol}`,
      `Destroyed (${reason}) | PnL $${fmt(this.realizedPnl)} | ` +
      `tx=${this.transactionCount} accTp=${fmt(this.accumulatedTpPercent)}% accSl=${fmt(this.accumulatedSlPercent)}%`);
    if (this.onDestroy) this.onDestroy(this.symbol, this.realizedPnl, reason);
  }

  // ── PnL helpers ─────────────────────────────────────────────

  _calcUnrealizedPnl(price) {
    if (!this._positionOpen) return 0;
    if (this.direction === "SHORT") return (this.entryPrice - price) * this.quantity;
    return (price - this.entryPrice) * this.quantity;
  }

  _trackHighestProfit() {
    const price = this.lastPrice || this.startPrice || 0;
    const totalNet = this.realizedPnl + this._calcUnrealizedPnl(price);
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
      direction: this.direction,
      transactionCount: this.transactionCount,
      accumulatedTpPercent: this.accumulatedTpPercent,
      accumulatedSlPercent: this.accumulatedSlPercent,
      netProfitPercent: this.netProfitPercent,
      profitTargetPercent: this.profitTargetPercent,
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
      status: "ACTIVE"
    });
  }
}

module.exports = Trader;
