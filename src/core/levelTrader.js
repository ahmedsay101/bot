const config = require("../utils/config");
const { log } = require("../utils/logger");
const store = require("../state/store");

function fmt(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return Number(value).toFixed(digits);
}

/**
 * LevelTrader – short-only level strategy.
 *
 * Places N short levels:
 *   Level 1 = market order at start price (filled immediately)
 *   Levels 2..N = limit SELL orders, each `levelGapPercent` above the previous
 *
 * Stop loss = `levelStopLossPercent` above the highest level price → destroy.
 * Take profit = `levelTakeProfitPercent` below the average entry of filled levels → destroy.
 *
 * On SL or TP: close all positions, cancel pending orders, destroy.
 */
class LevelTrader {
  constructor({ symbol, api, onDestroy }) {
    this.id = `${symbol}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    this.symbol = symbol;
    this.api = api;
    this.onDestroy = onDestroy;

    this.active = true;
    this.createdAt = new Date().toISOString();
    this.startPrice = null;
    this.lastPrice = null;
    this.highestPrice = null;
    this.lowestPrice = null;

    this._equity = 0;
    this.realizedPnl = 0;
    this.feesPaid = 0;

    // levels[i] = { index, price, status: "pending"|"filled"|"closed", orderId, entryPrice, quantity, entryFee }
    this.levels = [];
    // Map orderId → level index for quick lookup on fill
    this._orderToLevel = new Map();

    this.stopLossPrice = null;
    this.takeProfitPrice = null;
    this.averageEntry = null;
    this.totalQuantity = 0;

    this.tradeHistory = [];

    this._processing = false;
    this._onMarkPrice = this._onMarkPrice.bind(this);
    this._onBookTicker = this._onBookTicker.bind(this);
    this._onOrderFilled = this._onOrderFilled.bind(this);
  }

  // ── Config helpers ──────────────────────────────────────────

  get _numLevels() { return Number(config.numLevels) || 5; }
  get _gapPercent() { return Number(config.levelGapPercent) || 10; }
  get _slPercent() { return Number(config.levelStopLossPercent) || 10; }
  get _tpPercent() { return Number(config.levelTakeProfitPercent) || 20; }
  get _feeRate() { return Number(config.feeRate) || 0.0004; }

  _calcQuantity(price) {
    const equity = this._equity || Number(config.startingBalanceUSDT) || 200;
    const leverage = Number(config.leverage) || 2;
    const notional = (equity * leverage) / this._numLevels;
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

    // Build level prices
    const levelPrices = [];
    for (let i = 0; i < this._numLevels; i++) {
      levelPrices.push(this.startPrice * (1 + (this._gapPercent / 100) * i));
    }

    // SL above the highest level
    const highestLevelPrice = levelPrices[levelPrices.length - 1];
    this.stopLossPrice = highestLevelPrice * (1 + this._slPercent / 100);

    // Initialize level objects
    for (let i = 0; i < levelPrices.length; i++) {
      this.levels.push({
        index: i,
        price: levelPrices[i],
        status: "pending",
        orderId: null,
        entryPrice: null,
        quantity: null,
        entryFee: 0
      });
    }

    // Level 0: market order (fills immediately at start price)
    await this._fillLevel0();

    // Levels 1..N-1: limit SELL orders above
    for (let i = 1; i < this.levels.length; i++) {
      await this._placeLimitForLevel(i);
    }

    this._recalcTakeProfit();

    this.api.on("markPrice", this._onMarkPrice);
    this.api.on("bookTicker", this._onBookTicker);
    this.api.on("orderFilled", this._onOrderFilled);

    log(`LEVEL ${this.symbol}`, `Initialized @ ${fmt(this.startPrice, 6)} | ${this._numLevels} levels | gap=${this._gapPercent}% | SL=${fmt(this.stopLossPrice, 6)} | TP%=${this._tpPercent}%`);
    this._updateStore();
  }

  async _fillLevel0() {
    const level = this.levels[0];
    const qty = this._calcQuantity(level.price);
    if (qty <= 0) return;

    const result = await this.api.placeMarketOrder({
      symbol: this.symbol,
      side: "SELL",
      quantity: qty,
      positionSide: "SHORT"
    });

    const fillPrice = Number(result.price) || level.price;
    const fee = fillPrice * qty * this._feeRate;
    this.feesPaid += fee;

    level.status = "filled";
    level.entryPrice = fillPrice;
    level.quantity = qty;
    level.entryFee = fee;

    log(`LEVEL ${this.symbol}`, `L0 filled (market) @ ${fmt(fillPrice, 6)} qty=${qty}`);
  }

  async _placeLimitForLevel(i) {
    const level = this.levels[i];
    const qty = this._calcQuantity(level.price);
    if (qty <= 0) return;

    level.quantity = qty;

    const result = await this.api.placeLimitOrder({
      symbol: this.symbol,
      side: "SELL",
      quantity: qty,
      price: level.price,
      positionSide: "SHORT"
    });

    level.orderId = result.orderId;
    this._orderToLevel.set(result.orderId, i);
  }

  async destroy(reason) {
    if (!this.active) return;
    this.active = false;

    this.api.off("markPrice", this._onMarkPrice);
    this.api.off("bookTicker", this._onBookTicker);
    this.api.off("orderFilled", this._onOrderFilled);

    // Close all filled positions
    const filledLevels = this.levels.filter(l => l.status === "filled");
    const exitPrice = this.lastPrice || this.startPrice;
    for (const level of filledLevels) {
      await this._closeLevel(level, reason, exitPrice);
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
      filledLevels: filledLevels.length,
      totalLevels: this.levels.length
    });

    log(`LEVEL ${this.symbol}`, `Destroyed (${reason}) | PnL $${fmt(this.realizedPnl)} | filled=${filledLevels.length}/${this.levels.length}`);
    if (this.onDestroy) this.onDestroy(this.symbol, this.realizedPnl);
  }

  async _closeLevel(level, reason, exitPrice) {
    const result = await this.api.placeMarketOrder({
      symbol: this.symbol,
      side: "BUY",
      quantity: level.quantity,
      positionSide: "SHORT"
    });

    const fillPrice = Number(result.price) || exitPrice;
    const grossPnl = (level.entryPrice - fillPrice) * level.quantity;
    const exitFee = fillPrice * level.quantity * this._feeRate;
    this.feesPaid += exitFee;
    const totalFees = (level.entryFee || 0) + exitFee;
    const netPnl = grossPnl - totalFees;
    this.realizedPnl += netPnl;

    level.status = "closed";

    this.tradeHistory.push({
      level: level.index,
      entry: level.entryPrice,
      exit: fillPrice,
      quantity: level.quantity,
      grossPnl,
      fees: totalFees,
      netPnl,
      reason,
      closedAt: new Date().toISOString()
    });

    store.recordTrade({ pnl: grossPnl, fees: totalFees });
  }

  // ── Order fill handling ─────────────────────────────────────

  _onOrderFilled({ symbol, orderId, price, quantity }) {
    if (!this.active || symbol !== this.symbol) return;

    const levelIdx = this._orderToLevel.get(orderId);
    if (levelIdx === undefined) return;

    const level = this.levels[levelIdx];
    if (!level || level.status !== "pending") return;

    const fillPrice = Number(price) || level.price;
    const qty = Number(quantity) || level.quantity;
    const fee = fillPrice * qty * this._feeRate;
    this.feesPaid += fee;

    level.status = "filled";
    level.entryPrice = fillPrice;
    level.quantity = qty;
    level.entryFee = fee;
    this._orderToLevel.delete(orderId);

    this._recalcTakeProfit();

    log(`LEVEL ${this.symbol}`, `L${level.index} filled @ ${fmt(fillPrice, 6)} qty=${qty}`);
    this._updateStore();
  }

  // ── Average entry & TP recalculation ────────────────────────

  _recalcTakeProfit() {
    const filled = this.levels.filter(l => l.status === "filled");
    if (filled.length === 0) {
      this.averageEntry = null;
      this.takeProfitPrice = null;
      this.totalQuantity = 0;
      return;
    }

    let totalCost = 0;
    let totalQty = 0;
    for (const l of filled) {
      totalCost += l.entryPrice * l.quantity;
      totalQty += l.quantity;
    }
    this.averageEntry = totalCost / totalQty;
    this.totalQuantity = totalQty;
    this.takeProfitPrice = this.averageEntry * (1 - this._tpPercent / 100);
  }

  async _getAverageEntry() {
    if (config.mode === "live") {
      const pos = await this.api.getPosition(this.symbol);
      if (pos && pos.entryPrice > 0) return pos.entryPrice;
    }
    return this.averageEntry;
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
    if (this._processing || !this.active) return;
    const filledCount = this.levels.filter(l => l.status === "filled").length;
    if (filledCount === 0) return;
    this._processing = true;

    try {
      // In live mode, refresh average entry from Binance
      if (config.mode === "live") {
        const liveAvg = await this._getAverageEntry();
        if (liveAvg && liveAvg > 0) {
          this.averageEntry = liveAvg;
          this.takeProfitPrice = liveAvg * (1 - this._tpPercent / 100);
        }
      }

      // SHORT: SL hit when price rises above stopLossPrice
      if (price >= this.stopLossPrice) {
        log(`LEVEL ${this.symbol}`, `Stop loss hit @ ${fmt(price, 6)}`);
        await this.destroy("stop-loss");
        return;
      }

      // SHORT: TP hit when price drops to or below takeProfitPrice
      if (this.takeProfitPrice && price <= this.takeProfitPrice) {
        log(`LEVEL ${this.symbol}`, `Take profit hit @ ${fmt(price, 6)}`);
        await this.destroy("take-profit");
        return;
      }
    } finally {
      this._processing = false;
    }
  }

  // ── Unrealized PnL ─────────────────────────────────────────

  _calcUnrealizedPnl(price) {
    let total = 0;
    for (const l of this.levels) {
      if (l.status !== "filled") continue;
      const gross = (l.entryPrice - price) * l.quantity;
      const exitFee = price * l.quantity * this._feeRate;
      total += gross - l.entryFee - exitFee;
    }
    return total;
  }

  // ── Store sync ──────────────────────────────────────────────

  _updateStore() {
    if (!this.active) return;
    const price = this.lastPrice || this.startPrice || 0;
    const priceChangePercent = this.startPrice
      ? ((price - this.startPrice) / this.startPrice) * 100
      : 0;
    const unrealized = this._calcUnrealizedPnl(price);

    const filledLevels = this.levels.filter(l => l.status === "filled").length;
    const pendingLevels = this.levels.filter(l => l.status === "pending").length;

    // TP progress: how far price has moved from average entry toward TP
    let tpProgress = 0;
    if (this.averageEntry && this.takeProfitPrice) {
      const totalDistance = this.averageEntry - this.takeProfitPrice;
      const currentDistance = this.averageEntry - price;
      tpProgress = totalDistance > 0 ? Math.min(100, Math.max(0, (currentDistance / totalDistance) * 100)) : 0;
    }

    store.upsertTrader({
      id: this.id,
      symbol: this.symbol,
      lastPrice: price,
      startPrice: this.startPrice,
      highestPrice: this.highestPrice,
      lowestPrice: this.lowestPrice,
      priceChangePercent,
      leverage: Number(config.leverage) || 2,
      numLevels: this._numLevels,
      gapPercent: this._gapPercent,
      stopLossPercent: this._slPercent,
      takeProfitPercent: this._tpPercent,
      stopLossPrice: this.stopLossPrice,
      takeProfitPrice: this.takeProfitPrice,
      averageEntry: this.averageEntry,
      totalQuantity: this.totalQuantity,
      takeProfitProgress: tpProgress,
      filledLevels,
      pendingLevels,
      openPositions: filledLevels,
      levels: this.levels.map(l => ({
        index: l.index,
        price: l.price,
        status: l.status,
        entryPrice: l.entryPrice,
        quantity: l.quantity
      })),
      realizedPnl: this.realizedPnl,
      unrealizedPnl: unrealized,
      feesPaid: this.feesPaid,
      tradeHistory: this.tradeHistory,
      createdAt: this.createdAt,
      status: this.active ? "ACTIVE" : "STOPPED"
    });
  }
}

module.exports = LevelTrader;
