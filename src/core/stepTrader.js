const config = require("../utils/config");
const { log } = require("../utils/logger");
const store = require("../state/store");

function formatNumber(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return Number(value).toFixed(digits);
}

/**
 * StepTrader – short-only stepping strategy.
 *
 * Places a market SHORT order immediately on start.
 * - Take profit = price drops by stepTakeProfitPercent → WIN, destroy.
 * - Stop loss = price rises by stepStopLossPercent → LOSS, re-enter with
 *   take profit increased by stepPercent (compounding TP target).
 * - SL always stays at stepStopLossPercent from the new entry.
 * - Repeats until take profit is hit.
 */
class StepTrader {
  constructor({ symbol, api, onDestroy }) {
    this.id = `${symbol}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    this.symbol = symbol;
    this.api = api;
    this.onDestroy = onDestroy;
    this.traderType = "STEP";

    this.active = true;
    this.createdAt = new Date().toISOString();
    this.startPrice = null;
    this.lastPrice = null;
    this.highestPrice = null;
    this.lowestPrice = null;

    this._equity = 0;
    this.realizedPnl = 0;
    this.feesPaid = 0;

    // Current position state
    this.position = null; // { entryPrice, quantity, stopLossPrice, takeProfitPrice }

    // How many times SL has been hit (step count)
    this.stepCount = 0;

    // Current TP % from first entry price (increases by stepPercent on each SL)
    this.currentTakeProfitPercent = Number(config.stepTakeProfitPercent) || 10;

    // Trade history (each step entry/exit)
    this.tradeHistory = [];

    this._processing = false;
    this._onMarkPrice = this._onMarkPrice.bind(this);
    this._onBookTicker = this._onBookTicker.bind(this);
  }

  // ── Config helpers ──────────────────────────────────────────

  _getStopLossPercent() {
    const base = Number(config.stepStopLossPercent) || 10;
    if (config.doubleStopLoss && this.stepCount > 0) {
      return base + this._getStepPercent() * this.stepCount;
    }
    return base;
  }

  _getStepPercent() {
    return Number(config.stepPercent) || 10;
  }

  _getFeeRate() {
    return Number(config.feeRate) || 0.0004;
  }

  _calcQuantity(price) {
    const equity = this._equity || Number(config.startingBalanceUSDT) || 200;
    const leverage = Number(config.leverage) || 2;
    const notional = equity * leverage;
    if (notional <= 0 || price <= 0) return 0;
    return Number((notional / price).toFixed(4));
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
    this.highestPrice = this.startPrice;
    this.lowestPrice = this.startPrice;

    // Place initial market SHORT
    await this._openPosition(this.startPrice);

    this.api.on("markPrice", this._onMarkPrice);
    this.api.on("bookTicker", this._onBookTicker);

    log(
      `STEP ${this.symbol}`,
      `Initialized @ ${formatNumber(this.startPrice, 6)} | SL=${this._getStopLossPercent()}% | TP=${this.currentTakeProfitPercent}% | step=${this._getStepPercent()}%`
    );
    this._updateStore();
  }

  async destroy(reason) {
    if (!this.active) return;
    this.active = false;

    this.api.off("markPrice", this._onMarkPrice);
    this.api.off("bookTicker", this._onBookTicker);

    // Close open position if any
    if (this.position) {
      await this._closePosition("destroy", this.lastPrice || this.startPrice);
    }

    await this.api.cancelAllOpenOrders(this.symbol);

    store.removeTrader(this.id, {
      id: this.id,
      symbol: this.symbol,
      realizedPnl: this.realizedPnl,
      feesPaid: this.feesPaid,
      createdAt: this.createdAt,
      closedAt: new Date().toISOString(),
      reason,
      startPrice: this.startPrice,
      endPrice: this.lastPrice,
      stepCount: this.stepCount,
      totalTrades: this.tradeHistory.length
    });

    log(
      `STEP ${this.symbol}`,
      `Destroyed (${reason}) | PnL $${formatNumber(this.realizedPnl)} | steps=${this.stepCount}`
    );
    if (this.onDestroy) this.onDestroy(this.symbol, this.realizedPnl);
  }

  // ── Position management ─────────────────────────────────────

  async _openPosition(price) {
    const qty = this._calcQuantity(price);
    if (qty <= 0) return;

    const result = await this.api.placeMarketOrder({
      symbol: this.symbol,
      side: "SELL",
      quantity: qty,
      positionSide: "SHORT"
    });

    const entryPrice = Number(result.price) || price;
    const slPercent = this._getStopLossPercent();
    // SHORT: SL is above entry, TP is below entry
    const stopLossPrice = entryPrice * (1 + slPercent / 100);
    const takeProfitPrice = entryPrice * (1 - this.currentTakeProfitPercent / 100);

    const entryFee = entryPrice * qty * this._getFeeRate();
    this.feesPaid += entryFee;

    this.position = {
      entryPrice,
      quantity: qty,
      stopLossPrice,
      takeProfitPrice,
      entryFee
    };

    log(
      `STEP ${this.symbol}`,
      `Opened SHORT @ ${formatNumber(entryPrice, 6)} | qty=${qty} | SL=${formatNumber(stopLossPrice, 6)} | TP=${formatNumber(takeProfitPrice, 6)} (${this.currentTakeProfitPercent}% from entry) | step #${this.stepCount}`
    );
    this._updateStore();
  }

  async _closePosition(reason, exitPrice) {
    if (!this.position) return;
    const pos = this.position;
    this.position = null;

    const result = await this.api.placeMarketOrder({
      symbol: this.symbol,
      side: "BUY",
      quantity: pos.quantity,
      positionSide: "SHORT"
    });

    const fillPrice = Number(result.price) || exitPrice;
    const grossPnl = (pos.entryPrice - fillPrice) * pos.quantity;
    const exitFee = fillPrice * pos.quantity * this._getFeeRate();
    this.feesPaid += exitFee;
    const totalFees = (pos.entryFee || 0) + exitFee;
    const netPnl = grossPnl - totalFees;
    this.realizedPnl += netPnl;

    this.tradeHistory.push({
      step: this.stepCount,
      direction: "SHORT",
      entry: pos.entryPrice,
      exit: fillPrice,
      quantity: pos.quantity,
      grossPnl,
      fees: totalFees,
      netPnl,
      reason,
      takeProfitPercent: this.currentTakeProfitPercent,
      closedAt: new Date().toISOString()
    });

    store.recordTrade({ pnl: grossPnl, fees: totalFees });

    log(
      `STEP ${this.symbol}`,
      `Closed SHORT @ ${formatNumber(fillPrice, 6)} (PnL $${formatNumber(netPnl)}) reason=${reason}`
    );
    this._updateStore();
  }

  // ── Price feeds ─────────────────────────────────────────────

  async _onMarkPrice({ symbol, price }) {
    if (!this.active || symbol !== this.symbol) return;
    this.lastPrice = price;
    if (price > this.highestPrice) this.highestPrice = price;
    if (price < this.lowestPrice) this.lowestPrice = price;

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
    if (price > this.highestPrice) this.highestPrice = price;
    if (price < this.lowestPrice) this.lowestPrice = price;

    await this._checkExits(price);
    this._updateStore();
  }

  // ── Exit checks ─────────────────────────────────────────────

  async _checkExits(price) {
    if (this._processing || !this.active || !this.position) return;
    this._processing = true;

    try {
      const pos = this.position;

      // SHORT: TP hit when price drops to or below takeProfitPrice
      if (price <= pos.takeProfitPrice) {
        await this._closePosition("take-profit", price);
        log(`STEP ${this.symbol}`, `Take profit hit after ${this.stepCount} step(s) — WIN`);
        await this.destroy("take-profit");
        return;
      }

      // SHORT: SL hit when price rises to or above stopLossPrice
      if (price >= pos.stopLossPrice) {
        await this._closePosition("stop-loss", price);
        if (!this.active) return;

        // Step up: increase TP target, re-enter
        this.stepCount++;
        this.currentTakeProfitPercent += this._getStepPercent();
        log(
          `STEP ${this.symbol}`,
          `SL hit — step #${this.stepCount} | new TP=${this.currentTakeProfitPercent}% from entry`
        );
        await this._openPosition(price);
      }
    } finally {
      this._processing = false;
    }
  }

  // ── Unrealized PnL ─────────────────────────────────────────

  _calcUnrealizedPnl(price) {
    if (!this.position) return 0;
    const grossPnl = (this.position.entryPrice - price) * this.position.quantity;
    const exitFee = price * this.position.quantity * this._getFeeRate();
    return grossPnl - (this.position.entryFee || 0) - exitFee;
  }

  // ── Store sync ──────────────────────────────────────────────

  _updateStore() {
    if (!this.active) return;
    const price = this.lastPrice || this.startPrice || 0;
    const priceChangePercent = this.startPrice
      ? ((price - this.startPrice) / this.startPrice) * 100
      : 0;
    const unrealized = this._calcUnrealizedPnl(price);

    // TP progress: how far price has moved from entry toward the TP target
    const entryRef = this.position ? this.position.entryPrice : this.startPrice;
    const tpPrice = this.position ? this.position.takeProfitPrice : entryRef * (1 - this.currentTakeProfitPercent / 100);
    const totalDistance = entryRef - tpPrice;
    const currentDistance = entryRef - price;
    const tpProgress = totalDistance > 0 ? Math.min(100, Math.max(0, (currentDistance / totalDistance) * 100)) : 0;

    store.upsertTrader({
      id: this.id,
      symbol: this.symbol,
      traderType: this.traderType,
      lastPrice: price,
      startPrice: this.startPrice,
      highestPrice: this.highestPrice,
      lowestPrice: this.lowestPrice,
      priceChangePercent,
      leverage: Number(config.leverage) || 2,
      // Step trader specific
      stepCount: this.stepCount,
      stopLossPercent: this._getStopLossPercent(),
      currentTakeProfitPercent: this.currentTakeProfitPercent,
      stepPercent: this._getStepPercent(),
      takeProfitPrice: this.position ? this.position.takeProfitPrice : null,
      stopLossPrice: this.position ? this.position.stopLossPrice : null,
      entryPrice: this.position ? this.position.entryPrice : null,
      quantity: this.position ? this.position.quantity : null,
      takeProfitProgress: tpProgress,
      // Common
      openPositions: this.position ? 1 : 0,
      pendingOrders: 0,
      realizedPnl: this.realizedPnl,
      unrealizedPnl: unrealized,
      feesPaid: this.feesPaid,
      tradeHistory: this.tradeHistory,
      createdAt: this.createdAt,
      status: this.active ? "ACTIVE" : "STOPPED"
    });
  }
}

module.exports = StepTrader;
