const config = require("../utils/config");
const { log } = require("../utils/logger");
const store = require("../state/store");

function fmt(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return Number(value).toFixed(digits);
}

/**
 * TrendTrader — trend-following flip strategy.
 *
 * Opens a SHORT market order at start.
 *
 * TP / SL are 5% price movement from entry (configurable).
 *   SHORT: TP = entry * (1 - tpPercent/100), SL = entry * (1 + slPercent/100)
 *   LONG:  TP = entry * (1 + tpPercent/100), SL = entry * (1 - slPercent/100)
 *
 * On TP → open a new position in the SAME direction.
 * On SL → open a new position in the OPPOSITE direction (flip).
 */
class TrendTrader {
  constructor({ symbol, api, onDestroy }) {
    this.id = `${symbol}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    this.symbol = symbol;
    this.api = api;
    this.onDestroy = onDestroy;

    this.active = true;
    this.createdAt = new Date().toISOString();
    this.startPrice = null;
    this.lastPrice = null;

    this._equity = 0;
    this.realizedPnl = 0;
    this.feesPaid = 0;

    // Current position state
    this.direction = null;       // "SHORT" or "LONG"
    this.entryPrice = null;
    this.quantity = 0;
    this.entryFee = 0;
    this.stopLossPrice = null;
    this.takeProfitPrice = null;
    this.unrealizedPnl = 0;

    // Counters
    this.totalTrades = 0;
    this.wins = 0;
    this.losses = 0;
    this.consecutiveWins = 0;
    this.consecutiveLosses = 0;
    this.maxConsecutiveWins = 0;
    this.maxConsecutiveLosses = 0;

    this.tradeHistory = [];

    this._processing = false;
    this._onMarkPrice = this._onMarkPrice.bind(this);
    this._onBookTicker = this._onBookTicker.bind(this);
  }

  // ── Config helpers ──────────────────────────────────────────

  get _tpPercent() { return Number(config.tpPercent) || 5; }
  get _slPercent() { return Number(config.slPercent) || 5; }
  get _feeRate() { return Number(config.feeRate) || 0.0004; }

  _calcQuantity(price) {
    const equity = this._equity || Number(config.startingBalanceUSDT) || 200;
    const leverage = Number(config.leverage) || 2;
    const notional = equity * leverage;
    if (notional <= 0 || price <= 0) return 0;
    return Number((notional / price).toFixed(4));
  }

  _calcSLTP(entryPrice, direction) {
    if (direction === "SHORT") {
      return {
        stopLossPrice: entryPrice * (1 + this._slPercent / 100),
        takeProfitPrice: entryPrice * (1 - this._tpPercent / 100)
      };
    }
    // LONG
    return {
      stopLossPrice: entryPrice * (1 - this._slPercent / 100),
      takeProfitPrice: entryPrice * (1 + this._tpPercent / 100)
    };
  }

  // ── Lifecycle ───────────────────────────────────────────────

  async start() {
    this._equity = await this.api.getBalance();
    if (config.mode === "test") {
      const perf = store.getPerformance();
      this._equity = Number(config.startingBalanceUSDT) + Number(perf.netProfit || 0);
    }

    this.startPrice = await this.api.getMarkPrice(this.symbol);
    this.lastPrice = this.startPrice;

    // Open initial SHORT position
    await this._openPosition("SHORT");

    this.api.on("markPrice", this._onMarkPrice);
    this.api.on("bookTicker", this._onBookTicker);

    log(`TREND ${this.symbol}`, `Initialized @ ${fmt(this.startPrice, 6)} | direction=SHORT | TP%=${this._tpPercent}% SL%=${this._slPercent}%`);
    this._updateStore();
  }

  async _openPosition(direction) {
    const price = this.lastPrice || this.startPrice;
    const qty = this._calcQuantity(price);
    if (qty <= 0) return;

    const side = direction === "SHORT" ? "SELL" : "BUY";
    const positionSide = direction;

    const result = await this.api.placeMarketOrder({
      symbol: this.symbol,
      side,
      quantity: qty,
      positionSide
    });

    const fillPrice = Number(result.price) || price;
    const fee = fillPrice * qty * this._feeRate;
    this.feesPaid += fee;

    this.direction = direction;
    this.entryPrice = fillPrice;
    this.quantity = qty;
    this.entryFee = fee;

    const { stopLossPrice, takeProfitPrice } = this._calcSLTP(fillPrice, direction);
    this.stopLossPrice = stopLossPrice;
    this.takeProfitPrice = takeProfitPrice;

    log(`TREND ${this.symbol}`, `Opened ${direction} @ ${fmt(fillPrice, 6)} qty=${qty} SL=${fmt(stopLossPrice, 6)} TP=${fmt(takeProfitPrice, 6)}`);
  }

  async _closePosition(reason, exitPrice) {
    const closeSide = this.direction === "SHORT" ? "BUY" : "SELL";
    const positionSide = this.direction;

    const result = await this.api.placeMarketOrder({
      symbol: this.symbol,
      side: closeSide,
      quantity: this.quantity,
      positionSide
    });

    const fillPrice = Number(result.price) || exitPrice;
    let grossPnl;
    if (this.direction === "SHORT") {
      grossPnl = (this.entryPrice - fillPrice) * this.quantity;
    } else {
      grossPnl = (fillPrice - this.entryPrice) * this.quantity;
    }
    const exitFee = fillPrice * this.quantity * this._feeRate;
    this.feesPaid += exitFee;
    const totalFees = this.entryFee + exitFee;
    const netPnl = grossPnl - totalFees;
    this.realizedPnl += netPnl;
    this.totalTrades += 1;

    const isWin = reason === "take-profit";
    if (isWin) {
      this.wins += 1;
      this.consecutiveWins += 1;
      this.consecutiveLosses = 0;
      if (this.consecutiveWins > this.maxConsecutiveWins) this.maxConsecutiveWins = this.consecutiveWins;
    } else {
      this.losses += 1;
      this.consecutiveLosses += 1;
      this.consecutiveWins = 0;
      if (this.consecutiveLosses > this.maxConsecutiveLosses) this.maxConsecutiveLosses = this.consecutiveLosses;
    }

    this.tradeHistory.push({
      direction: this.direction,
      entry: this.entryPrice,
      exit: fillPrice,
      quantity: this.quantity,
      grossPnl,
      fees: totalFees,
      netPnl,
      reason,
      closedAt: new Date().toISOString()
    });

    store.recordTrade({ pnl: grossPnl, fees: totalFees });

    log(`TREND ${this.symbol}`, `Closed ${this.direction} (${reason}) @ ${fmt(fillPrice, 6)} | PnL $${fmt(netPnl, 4)}`);

    return { grossPnl, netPnl, reason };
  }

  async destroy(reason) {
    if (!this.active) return;
    this.active = false;

    this.api.off("markPrice", this._onMarkPrice);
    this.api.off("bookTicker", this._onBookTicker);

    // Close any open position
    if (this.entryPrice && this.quantity > 0) {
      const exitPrice = this.lastPrice || this.startPrice;
      await this._closePosition("destroy", exitPrice);
    }

    await this.api.cancelAllOpenOrders(this.symbol);

    store.removeTrader(this.id, {
      id: this.id,
      symbol: this.symbol,
      realizedPnl: this.realizedPnl,
      feesPaid: this.feesPaid,
      totalTrades: this.totalTrades,
      wins: this.wins,
      losses: this.losses,
      createdAt: this.createdAt,
      closedAt: new Date().toISOString(),
      reason,
      startPrice: this.startPrice,
      endPrice: this.lastPrice
    });

    log(`TREND ${this.symbol}`, `Destroyed (${reason}) | PnL $${fmt(this.realizedPnl)} | W/L ${this.wins}/${this.losses}`);
    if (this.onDestroy) this.onDestroy(this.symbol, this.realizedPnl);
  }

  // ── Price feeds ─────────────────────────────────────────────

  async _onMarkPrice({ symbol, price }) {
    if (!this.active || symbol !== this.symbol) return;
    this.lastPrice = price;
    await this._checkExits(price);
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
    await this._checkExits(price);
    this._updateStore();
  }

  // ── Exit checks & flip ────────────────────────────────────

  async _checkExits(price) {
    if (this._processing || !this.active) return;
    if (!this.entryPrice || this.quantity <= 0) return;
    this._processing = true;

    try {
      if (this.direction === "SHORT") {
        // SHORT: SL hit when price rises to or above SL
        if (price >= this.stopLossPrice) {
          log(`TREND ${this.symbol}`, `SL hit @ ${fmt(price, 6)} (entry=${fmt(this.entryPrice, 6)} SL=${fmt(this.stopLossPrice, 6)})`);
          await this._closePosition("stop-loss", price);
          // Flip: open LONG
          await this._openPosition("LONG");
          this._updateStore();
          return;
        }
        // SHORT: TP hit when price drops to or below TP
        if (price <= this.takeProfitPrice) {
          log(`TREND ${this.symbol}`, `TP hit @ ${fmt(price, 6)} (entry=${fmt(this.entryPrice, 6)} TP=${fmt(this.takeProfitPrice, 6)})`);
          await this._closePosition("take-profit", price);
          // Same direction: open SHORT again
          await this._openPosition("SHORT");
          this._updateStore();
          return;
        }
      } else {
        // LONG: SL hit when price drops to or below SL
        if (price <= this.stopLossPrice) {
          log(`TREND ${this.symbol}`, `SL hit @ ${fmt(price, 6)} (entry=${fmt(this.entryPrice, 6)} SL=${fmt(this.stopLossPrice, 6)})`);
          await this._closePosition("stop-loss", price);
          // Flip: open SHORT
          await this._openPosition("SHORT");
          this._updateStore();
          return;
        }
        // LONG: TP hit when price rises to or above TP
        if (price >= this.takeProfitPrice) {
          log(`TREND ${this.symbol}`, `TP hit @ ${fmt(price, 6)} (entry=${fmt(this.entryPrice, 6)} TP=${fmt(this.takeProfitPrice, 6)})`);
          await this._closePosition("take-profit", price);
          // Same direction: open LONG again
          await this._openPosition("LONG");
          this._updateStore();
          return;
        }
      }
    } finally {
      this._processing = false;
    }
  }

  // ── Unrealized PnL ─────────────────────────────────────────

  _calcUnrealizedPnl(price) {
    if (!this.entryPrice || this.quantity <= 0) return 0;
    let grossPnl;
    if (this.direction === "SHORT") {
      grossPnl = (this.entryPrice - price) * this.quantity;
    } else {
      grossPnl = (price - this.entryPrice) * this.quantity;
    }
    const exitFee = price * this.quantity * this._feeRate;
    return grossPnl - this.entryFee - exitFee;
  }

  // ── Store sync ──────────────────────────────────────────────

  _updateStore() {
    if (!this.active) return;
    const price = this.lastPrice || this.startPrice || 0;
    const unrealized = this._calcUnrealizedPnl(price);
    this.unrealizedPnl = unrealized;

    // TP progress: how far price has moved from entry toward TP
    let tpProgress = 0;
    if (this.entryPrice && this.takeProfitPrice) {
      const totalDistance = Math.abs(this.takeProfitPrice - this.entryPrice);
      let currentDistance;
      if (this.direction === "SHORT") {
        currentDistance = Math.max(0, this.entryPrice - price);
      } else {
        currentDistance = Math.max(0, price - this.entryPrice);
      }
      tpProgress = totalDistance > 0 ? Math.min(100, (currentDistance / totalDistance) * 100) : 0;
    }

    store.upsertTrader({
      id: this.id,
      symbol: this.symbol,
      traderType: "TREND",
      lastPrice: price,
      startPrice: this.startPrice,
      direction: this.direction,
      entryPrice: this.entryPrice,
      quantity: this.quantity,
      stopLossPrice: this.stopLossPrice,
      takeProfitPrice: this.takeProfitPrice,
      tpPercent: this._tpPercent,
      slPercent: this._slPercent,
      tpProgress,
      leverage: Number(config.leverage) || 2,
      totalTrades: this.totalTrades,
      wins: this.wins,
      losses: this.losses,
      consecutiveWins: this.consecutiveWins,
      consecutiveLosses: this.consecutiveLosses,
      maxConsecutiveWins: this.maxConsecutiveWins,
      maxConsecutiveLosses: this.maxConsecutiveLosses,
      realizedPnl: this.realizedPnl,
      unrealizedPnl: unrealized,
      feesPaid: this.feesPaid,
      tradeHistory: this.tradeHistory,
      createdAt: this.createdAt,
      status: this.active ? "ACTIVE" : "STOPPED"
    });
  }
}

module.exports = TrendTrader;
