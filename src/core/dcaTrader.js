const config = require("../utils/config");
const { log } = require("../utils/logger");
const store = require("../state/store");

function fmt(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return Number(value).toFixed(digits);
}

function round8(v) { return parseFloat(v.toFixed(8)); }

/**
 * DCATrader - ladder strategy.
 *
 * Places 10 LONG stop-limit orders above the current price and
 * 10 SHORT stop-limit orders below the current price, each spaced 1% apart.
 * Each order has 1% TP and 1% SL.
 *
 * Orders are triggered (filled) when price reaches their stop level.
 * Trader is destroyed when ALL orders on one side (long or short) are closed
 * (either by TP or SL).
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

    const levels = Number(config.ladderLevels) || 10;
    const gap = Number(config.ladderGapPercent) || 1;
    this.takeProfitPercent = Number(config.takeProfitPercent) || 1;
    this.stopLossPercent = Number(config.stopLossPercent) || 1;

    this.ladderLevels = levels;
    this.ladderGapPercent = gap;

    // Arrays of order objects: { idx, side, stopPrice, entryPrice, tpPrice, slPrice, quantity, status }
    // status: "pending" | "active" | "tp" | "sl"
    this.longs = [];
    this.shorts = [];

    // Accumulated tracking
    this.accumulatedTpCount = 0;
    this.accumulatedSlCount = 0;
    this.accumulatedTpPnl = 0;
    this.accumulatedSlPnl = 0;

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

  // -- Lifecycle -----------------------------------------------

  async start() {
    this.startPrice = await this.api.getMarkPrice(this.symbol);
    this.lastPrice = this.startPrice;

    this._buildLadder();

    this.api.on("markPrice", this._onMarkPrice);
    this.api.on("bookTicker", this._onBookTicker);

    log(`DCA ${this.symbol}`,
      `Ladder placed: ${this.ladderLevels} longs above / ${this.ladderLevels} shorts below @ ${fmt(this.startPrice, 6)}`);

    this._updateStore();
  }

  _buildLadder() {
    const price = this.startPrice;
    const perOrder = this.notional / this.ladderLevels;

    for (let i = 0; i < this.ladderLevels; i++) {
      const gapMult = (i + 1) * this.ladderGapPercent / 100;

      // LONG: stop price above current
      const longStop = round8(price * (1 + gapMult));
      const longQty = Number((perOrder / longStop).toFixed(4));
      this.longs.push({
        idx: i,
        side: "LONG",
        stopPrice: longStop,
        entryPrice: longStop,
        tpPrice: round8(longStop * (1 + this.takeProfitPercent / 100)),
        slPrice: round8(longStop * (1 - this.stopLossPercent / 100)),
        quantity: longQty,
        status: "pending"
      });

      // SHORT: stop price below current
      const shortStop = round8(price * (1 - gapMult));
      const shortQty = Number((perOrder / shortStop).toFixed(4));
      this.shorts.push({
        idx: i,
        side: "SHORT",
        stopPrice: shortStop,
        entryPrice: shortStop,
        tpPrice: round8(shortStop * (1 - this.takeProfitPercent / 100)),
        slPrice: round8(shortStop * (1 + this.stopLossPercent / 100)),
        quantity: shortQty,
        status: "pending"
      });
    }
  }

  // -- Price feeds ---------------------------------------------

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

  // -- Order trigger + TP/SL check -----------------------------

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

      // Trigger pending LONG orders (price rises to stop)
      for (const order of this.longs) {
        if (order.status === "pending" && price >= order.stopPrice) {
          await this._fillOrder(order);
        }
      }

      // Trigger pending SHORT orders (price drops to stop)
      for (const order of this.shorts) {
        if (order.status === "pending" && price <= order.stopPrice) {
          await this._fillOrder(order);
        }
      }

      // Check TP/SL on active LONG orders
      for (const order of this.longs) {
        if (order.status !== "active") continue;
        if (price >= order.tpPrice) {
          await this._closeOrder(order, order.tpPrice, "take-profit");
        } else if (price <= order.slPrice) {
          await this._closeOrder(order, order.slPrice, "stop-loss");
        }
      }

      // Check TP/SL on active SHORT orders
      for (const order of this.shorts) {
        if (order.status !== "active") continue;
        if (price <= order.tpPrice) {
          await this._closeOrder(order, order.tpPrice, "take-profit");
        } else if (price >= order.slPrice) {
          await this._closeOrder(order, order.slPrice, "stop-loss");
        }
      }

      // Check if all orders on one side are done (no pending or active)
      const longsAllDone = this.longs.every(o => o.status === "tp" || o.status === "sl");
      const shortsAllDone = this.shorts.every(o => o.status === "tp" || o.status === "sl");

      if (longsAllDone || shortsAllDone) {
        const reason = longsAllDone && shortsAllDone ? "all-closed" : "side-closed";
        await this.destroy(reason);
      }
    } finally {
      this._processing = false;
    }
  }

  async _fillOrder(order) {
    order.status = "active";

    const side = order.side === "LONG" ? "BUY" : "SELL";
    const result = await this.api.placeMarketOrder({
      symbol: this.symbol, side, quantity: order.quantity
    });

    order.entryPrice = Number(result.price) || order.stopPrice;
    order.quantity = Number(result.quantity) || order.quantity;

    // Recalculate TP/SL based on actual fill price
    if (order.side === "LONG") {
      order.tpPrice = round8(order.entryPrice * (1 + this.takeProfitPercent / 100));
      order.slPrice = round8(order.entryPrice * (1 - this.stopLossPercent / 100));
    } else {
      order.tpPrice = round8(order.entryPrice * (1 - this.takeProfitPercent / 100));
      order.slPrice = round8(order.entryPrice * (1 + this.stopLossPercent / 100));
    }

    const entryFee = order.entryPrice * order.quantity * this._feeRate;
    this.feesPaid += entryFee;

    log(`DCA ${this.symbol}`,
      `${order.side} #${order.idx + 1} filled @ ${fmt(order.entryPrice, 6)} | TP=${fmt(order.tpPrice, 6)} SL=${fmt(order.slPrice, 6)}`);
  }

  async _closeOrder(order, exitPrice, reason) {
    const closeSide = order.side === "LONG" ? "SELL" : "BUY";
    const grossPnl = order.side === "LONG"
      ? (exitPrice - order.entryPrice) * order.quantity
      : (order.entryPrice - exitPrice) * order.quantity;
    const closeFee = exitPrice * order.quantity * this._feeRate;

    await this.api.placeMarketOrder({
      symbol: this.symbol, side: closeSide, quantity: order.quantity
    });

    order.status = reason === "take-profit" ? "tp" : "sl";

    this.feesPaid += closeFee;
    this.realizedPnl += grossPnl - closeFee;
    this.totalTrades += 1;

    if (reason === "take-profit") {
      this.accumulatedTpCount += 1;
      this.accumulatedTpPnl += grossPnl - closeFee;
    } else {
      this.accumulatedSlCount += 1;
      this.accumulatedSlPnl += grossPnl - closeFee;
    }

    this.tradeHistory.push({
      direction: order.side,
      level: order.idx + 1,
      entry: order.entryPrice,
      exit: exitPrice,
      quantity: order.quantity,
      grossPnl,
      fees: closeFee,
      netPnl: grossPnl - closeFee,
      reason,
      closedAt: new Date().toISOString()
    });

    store.recordTrade({ pnl: grossPnl, fees: closeFee });

    log(`DCA ${this.symbol}`,
      `${order.side} #${order.idx + 1} ${reason} @ ${fmt(exitPrice, 6)} | PnL ${fmt(grossPnl - closeFee, 4)}`);
  }

  // -- Destroy -------------------------------------------------

  async destroy(reason) {
    if (!this.active) return;
    this.active = false;

    this.api.off("markPrice", this._onMarkPrice);
    this.api.off("bookTicker", this._onBookTicker);

    await this.api.cancelAllOpenOrders(this.symbol);

    // Close any remaining active orders at market price
    const exitPrice = this.lastPrice || this.startPrice;
    for (const order of [...this.longs, ...this.shorts]) {
      if (order.status === "active") {
        await this._closeOrder(order, exitPrice, reason);
      }
    }

    const hasAnySl = this.accumulatedSlCount > 0;
    const destroyReason = hasAnySl && reason === "side-closed" ? "max-loss" : reason;

    store.removeTrader(this.id, {
      id: this.id,
      symbol: this.symbol,
      changePercent: this.changePercent,
      realizedPnl: this.realizedPnl,
      feesPaid: this.feesPaid,
      totalTrades: this.totalTrades,
      accumulatedTpCount: this.accumulatedTpCount,
      accumulatedSlCount: this.accumulatedSlCount,
      accumulatedTpPnl: this.accumulatedTpPnl,
      accumulatedSlPnl: this.accumulatedSlPnl,
      highestNetProfit: this.highestNetProfit,
      createdAt: this.createdAt,
      closedAt: new Date().toISOString(),
      reason: destroyReason,
      startPrice: this.startPrice,
      endPrice: this.lastPrice
    });

    log(`DCA ${this.symbol}`,
      `Destroyed (${destroyReason}) | PnL $${fmt(this.realizedPnl)} | TP:${this.accumulatedTpCount} SL:${this.accumulatedSlCount}`);
    if (this.onDestroy) this.onDestroy(this.symbol, this.realizedPnl, destroyReason);
  }

  // -- PnL helpers ---------------------------------------------

  _calcUnrealizedPnl(price) {
    let pnl = 0;
    for (const order of this.longs) {
      if (order.status === "active") pnl += (price - order.entryPrice) * order.quantity;
    }
    for (const order of this.shorts) {
      if (order.status === "active") pnl += (order.entryPrice - price) * order.quantity;
    }
    return pnl;
  }

  _trackHighestProfit() {
    const price = this.lastPrice || this.startPrice || 0;
    const unrealized = this._calcUnrealizedPnl(price);
    const totalNet = this.realizedPnl + unrealized - this.feesPaid;
    if (totalNet > this.highestNetProfit) this.highestNetProfit = totalNet;
  }

  // -- Store sync ----------------------------------------------

  _updateStore() {
    if (!this.active) return;
    const price = this.lastPrice || this.startPrice || 0;
    const unrealized = this._calcUnrealizedPnl(price);
    this.unrealizedPnl = unrealized;

    store.upsertTrader({
      id: this.id,
      symbol: this.symbol,
      traderType: "LADDER",
      lastPrice: price,
      startPrice: this.startPrice,
      leverage: this.leverage,
      notional: this.notional,
      margin: this.margin,
      ladderLevels: this.ladderLevels,
      ladderGapPercent: this.ladderGapPercent,
      takeProfitPercent: this.takeProfitPercent,
      stopLossPercent: this.stopLossPercent,
      longs: this.longs.map(o => ({ idx: o.idx, stopPrice: o.stopPrice, entryPrice: o.entryPrice, tpPrice: o.tpPrice, slPrice: o.slPrice, quantity: o.quantity, status: o.status })),
      shorts: this.shorts.map(o => ({ idx: o.idx, stopPrice: o.stopPrice, entryPrice: o.entryPrice, tpPrice: o.tpPrice, slPrice: o.slPrice, quantity: o.quantity, status: o.status })),
      accumulatedTpCount: this.accumulatedTpCount,
      accumulatedSlCount: this.accumulatedSlCount,
      accumulatedTpPnl: this.accumulatedTpPnl,
      accumulatedSlPnl: this.accumulatedSlPnl,
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
