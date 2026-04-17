const config = require("../utils/config");
const { log } = require("../utils/logger");
const store = require("../state/store");

function fmt(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return Number(value).toFixed(digits);
}

/**
 * DCATrader — flip strategy.
 *
 * Starts with a SHORT position.
 * TP = accumulatedSL% + base TP% (dynamic, grows with losses).
 * SL = fixed % → flip direction, or destroy if accSL >= maxAccSL.
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

    this.baseTpPercent = Number(config.takeProfitPercent) || 3;
    this.stopLossPercent = Number(config.stopLossPercent) || 5;
    this.maxAccumulatedSlPercent = Number(config.maxAccumulatedSlPercent) || 30;

    // Flip tracking
    this.direction = "SHORT";       // current position direction
    this.accumulatedSlPercent = 0;   // total SL% accumulated across flips
    this.flipCount = 0;             // number of flips so far

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

    this._processing = false;
    this._onMarkPrice = this._onMarkPrice.bind(this);
    this._onBookTicker = this._onBookTicker.bind(this);
  }

  get _feeRate() { return config.feeRate != null ? Number(config.feeRate) : 0.0004; }

  /** Dynamic TP%: grows with accumulated losses */
  get takeProfitPercent() { return this.accumulatedSlPercent + this.baseTpPercent; }

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

    this._setExitPrices();

    log(`DCA ${this.symbol}`,
      `${direction} @ ${fmt(this.entryPrice, 6)} | qty=${this.quantity} ` +
      `flip#${this.flipCount} accSL=${this.accumulatedSlPercent}% TP%=${this.takeProfitPercent} ` +
      `TP=${fmt(this.tpPrice, 6)} SL=${fmt(this.slPrice, 6)}`);
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

      const tpHit = this.direction === "SHORT"
        ? price <= this.tpPrice
        : price >= this.tpPrice;

      const slHit = this.direction === "SHORT"
        ? price >= this.slPrice
        : price <= this.slPrice;

      if (tpHit) {
        log(`DCA ${this.symbol}`, `TP hit @ ${fmt(price, 6)} (${this.direction})`);
        await this.destroy("take-profit");
      } else if (slHit) {
        await this._handleStopLoss(price);
      }
    } finally {
      this._processing = false;
    }
  }

  async _handleStopLoss(price) {
    this.accumulatedSlPercent += this.stopLossPercent;
    log(`DCA ${this.symbol}`,
      `SL hit @ ${fmt(price, 6)} (${this.direction}) | accSL=${this.accumulatedSlPercent}%`);

    // Close current position
    const exitPrice = this.slPrice;
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

    this.tradeHistory.push({
      direction: this.direction,
      entry: this.entryPrice,
      exit: exitPrice,
      quantity: this.quantity,
      grossPnl,
      fees: closeFee,
      netPnl: grossPnl - closeFee,
      reason: "stop-loss",
      closedAt: new Date().toISOString()
    });

    store.recordTrade({ pnl: grossPnl, fees: closeFee });

    // Check if accumulated SL >= max allowed → destroy
    if (this.accumulatedSlPercent >= this.maxAccumulatedSlPercent) {
      log(`DCA ${this.symbol}`,
        `Accumulated SL ${this.accumulatedSlPercent}% >= max ${this.maxAccumulatedSlPercent}% — destroying`);
      await this.destroy("max-loss");
      return;
    }

    // Flip direction
    const nextDir = this.direction === "SHORT" ? "LONG" : "SHORT";
    this.flipCount += 1;
    log(`DCA ${this.symbol}`, `Flipping to ${nextDir} (flip #${this.flipCount})`);
    await this._openPosition(nextDir);
    this._updateStore();
  }

  // ── Destroy ─────────────────────────────────────────────────

  async destroy(reason) {
    if (!this.active) return;
    this.active = false;

    this.api.off("markPrice", this._onMarkPrice);
    this.api.off("bookTicker", this._onBookTicker);

    await this.api.cancelAllOpenOrders(this.symbol);

    // Close position if not already closed by _handleStopLoss
    if (reason !== "max-loss") {
      let exitPrice = this.lastPrice || this.startPrice;
      if (reason === "take-profit") exitPrice = this.tpPrice;

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
    }

    const isLoss = reason === "max-loss" || reason === "expired" || reason === "manual";

    store.removeTrader(this.id, {
      id: this.id,
      symbol: this.symbol,
      changePercent: this.changePercent,
      direction: this.direction,
      flipCount: this.flipCount,
      accumulatedSlPercent: this.accumulatedSlPercent,
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

    log(`DCA ${this.symbol}`,
      `Destroyed (${reason}) | PnL $${fmt(this.realizedPnl)} | flips=${this.flipCount} accSL=${this.accumulatedSlPercent}%`);
    if (this.onDestroy) this.onDestroy(this.symbol, this.realizedPnl, reason);
  }

  // ── PnL helpers ─────────────────────────────────────────────

  _calcUnrealizedPnl(price) {
    if (this.direction === "SHORT") {
      return (this.entryPrice - price) * this.quantity;
    }
    return (price - this.entryPrice) * this.quantity;
  }

  _trackHighestProfit() {
    const price = this.lastPrice || this.startPrice || 0;
    const unrealized = this._calcUnrealizedPnl(price);
    const totalNet = this.realizedPnl + unrealized - this.feesPaid;
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
      traderType: "FLIP",
      direction: this.direction,
      flipCount: this.flipCount,
      accumulatedSlPercent: this.accumulatedSlPercent,
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

module.exports = DCATrader;
