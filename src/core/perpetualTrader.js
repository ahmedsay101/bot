/**
 * PerpetualTrader – perpetual position strategy.
 *
 * Behavior:
 * 1. Opens a SHORT market order on start.
 * 2. TP/SL are placed as exchange orders (limit for TP, stop-market for SL).
 * 3. On take-profit → open new position in the SAME direction.
 * 4. On stop-loss   → open new position in the OPPOSITE direction.
 * 5. Notional = (equityFraction * equity) * leverage.
 * 6. In test mode, TP/SL fills are simulated via _checkPosition().
 * 7. Destruction cancels all pending orders and closes open position.
 */

const config = require("../utils/config");
const { log } = require("../utils/logger");
const store = require("../state/store");

function formatNumber(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return Number(value).toFixed(digits);
}

class PerpetualTrader {
  constructor({ symbol, api, onDestroy, leverage }) {
    this.id = `${symbol}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    this.symbol = symbol;
    this.api = api;
    this.onDestroy = onDestroy;
    this.traderType = "PERPETUAL";

    this.leverage = leverage || Number(config.leverage) || 10;
    this.active = true;
    this.createdAt = new Date().toISOString();
    this.tradeHistory = [];
    this.realizedPnl = 0;
    this.feesPaid = 0;
    this.lastPrice = null;

    // Notional: (equityFraction * equity) * leverage
    const equityFraction = Number(config.equityFraction) || 0.01;
    const currentEquity =
      store.getStatus().equity || Number(config.startingBalanceUSDT) || 100;
    this.equityAtCreation = currentEquity;
    this.equityFraction = equityFraction;
    this.baseNotional = equityFraction * currentEquity;
    this.notional = this.baseNotional * this.leverage;

    // Current position (only one at a time)
    this.position = null;
    this.startDirection = "SHORT";

    // Statistics
    this.totalTrades = 0;
    this.wins = 0;
    this.losses = 0;
    this.currentStreak = 0;
    this.longestWinStreak = 0;
    this.longestLossStreak = 0;

    // Guard flags
    this._processing = false;
    this._lastTradeTime = 0;
    this._minTradeIntervalMs = 2000;
    this._tradeSeq = 0;

    this._onMarkPrice = this._onMarkPrice.bind(this);
    this._onBookTicker = this._onBookTicker.bind(this);
    this._onOrderFilled = this._onOrderFilled.bind(this);
    this._onOrderCancelled = this._onOrderCancelled.bind(this);

    // Pending TP/SL exchange orders: orderId → { orderId, reason, price }
    this.pendingExitsById = new Map();
  }

  // ── Config helpers ──────────────────────────────────────────────

  _getTakeProfitPercent() {
    return Number(config.takeProfitPercent) || 1;
  }

  _getStopLossPercent() {
    return Number(config.stopLossPercent) || 1;
  }

  _getFeeRate() {
    return Number(config.feeRate) || 0.0004;
  }

  _calcQuantity(price) {
    if (this.notional <= 0 || price <= 0) return 0;
    return Number((this.notional / price).toFixed(4));
  }

  _calcTpSlPrices(entryPrice, direction) {
    const tpPct = this._getTakeProfitPercent();
    const slPct = this._getStopLossPercent();
    if (direction === "LONG") {
      return {
        tpPrice: entryPrice * (1 + tpPct / 100),
        slPrice: entryPrice * (1 - slPct / 100)
      };
    }
    return {
      tpPrice: entryPrice * (1 - tpPct / 100),
      slPrice: entryPrice * (1 + slPct / 100)
    };
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  async start() {
    this.lastPrice = await this.api.getMarkPrice(this.symbol);
    this.api.on("markPrice", this._onMarkPrice);
    this.api.on("bookTicker", this._onBookTicker);
    this.api.on("orderFilled", this._onOrderFilled);
    this.api.on("orderCancelled", this._onOrderCancelled);
    await this._openPosition(this.startDirection, "initial");
    log(
      `TRADER ${this.symbol}`,
      `Started PERPETUAL – leverage=${this.leverage}x notional=$${formatNumber(this.notional)}`
    );
    this._updateStore();
  }

  async destroy(reason) {
    if (!this.active) return;
    this.active = false;

    this.api.off("markPrice", this._onMarkPrice);
    this.api.off("bookTicker", this._onBookTicker);
    this.api.off("orderFilled", this._onOrderFilled);
    this.api.off("orderCancelled", this._onOrderCancelled);

    // Cancel all pending TP/SL orders
    for (const order of this.pendingExitsById.values()) {
      try {
        await this.api.cancelOrder({ symbol: this.symbol, orderId: order.orderId });
      } catch (_) {}
    }
    this.pendingExitsById.clear();
    await this.api.cancelAllOpenOrders(this.symbol);

    // Close open position
    if (this.position) {
      await this._closePosition("destroy");
    }

    store.removeTrader(this.id, {
      id: this.id,
      symbol: this.symbol,
      realizedPnl: this.realizedPnl,
      feesPaid: this.feesPaid,
      createdAt: this.createdAt,
      closedAt: new Date().toISOString(),
      reason,
      totalTrades: this.totalTrades,
      wins: this.wins,
      losses: this.losses,
      tradeHistory: this.tradeHistory
    });

    log(
      `TRADER ${this.symbol}`,
      `Destroyed (${reason}) ${this.totalTrades} trades, PnL $${formatNumber(this.realizedPnl)}`
    );
    if (this.onDestroy) this.onDestroy(this.symbol, this.realizedPnl);
  }

  // ── Position open / close ───────────────────────────────────────

  async _openPosition(direction, openReason) {
    const side = direction === "LONG" ? "BUY" : "SELL";
    const price = this.lastPrice;
    const qty = this._calcQuantity(price);

    const result = await this.api.placeMarketOrder({
      symbol: this.symbol,
      side,
      quantity: qty,
      positionSide: direction
    });

    const fillPrice = Number(result.price) || price;
    const { tpPrice, slPrice } = this._calcTpSlPrices(fillPrice, direction);

    const entryFee = fillPrice * qty * this._getFeeRate();
    this.feesPaid += entryFee;

    this._tradeSeq++;
    this.position = {
      direction,
      openReason,
      entryPrice: fillPrice,
      quantity: qty,
      notional: this.notional,
      tpPrice,
      slPrice,
      tradeNumber: this._tradeSeq,
      entryFee,
      tpOrderId: null,
      slOrderId: null
    };

    log(
      `TRADER ${this.symbol}`,
      `#${this.position.tradeNumber} OPEN ${direction} [${openReason}] qty=${qty} ` +
        `entry=${formatNumber(fillPrice, 6)} TP=${formatNumber(tpPrice, 6)} SL=${formatNumber(slPrice, 6)}`
    );

    this._updateStore();
    await this._placeExitOrders();
  }

  async _closePosition(reason, exitPrice) {
    const pos = this.position;
    if (!pos) return;

    const price = exitPrice || this.lastPrice;
    const side = pos.direction === "LONG" ? "SELL" : "BUY";

    await this.api.placeMarketOrder({
      symbol: this.symbol,
      side,
      quantity: pos.quantity,
      positionSide: pos.direction
    });

    const dir = pos.direction === "LONG" ? 1 : -1;
    const grossPnl = (price - pos.entryPrice) * pos.quantity * dir;

    const exitFee = price * pos.quantity * this._getFeeRate();
    this.feesPaid += exitFee;
    const totalFees = pos.entryFee + exitFee;
    const netPnl = grossPnl - totalFees;
    this.realizedPnl += netPnl;

    this.tradeHistory.push({
      tradeNumber: pos.tradeNumber,
      direction: pos.direction,
      openReason: pos.openReason,
      entry: pos.entryPrice,
      exit: price,
      quantity: pos.quantity,
      notional: pos.notional,
      grossPnl,
      fees: totalFees,
      netPnl,
      reason,
      closedAt: new Date().toISOString()
    });

    store.recordTrade({ pnl: grossPnl, fees: totalFees });

    log(
      `TRADER ${this.symbol}`,
      `#${pos.tradeNumber} CLOSE ${pos.direction} [${reason}] @ ${formatNumber(price, 6)} ` +
        `gross=${formatNumber(grossPnl)} net=${formatNumber(netPnl)}`
    );

    this.position = null;
  }

  // ── Exit orders (TP limit + SL stop-market) ─────────────────────

  async _placeExitOrders() {
    const pos = this.position;
    if (!pos) return;

    // In test mode, _checkPosition handles TP/SL simulation.
    // Placing real orders would cause the API's _simulateFills to race.
    if (config.mode === "test") return;

    const closeSide = pos.direction === "LONG" ? "SELL" : "BUY";

    // TP: limit order
    const tp = await this.api.placeLimitOrder({
      symbol: this.symbol,
      side: closeSide,
      quantity: pos.quantity,
      price: Number(pos.tpPrice.toFixed(6)),
      reduceOnly: true,
      positionSide: pos.direction
    });
    pos.tpOrderId = tp.orderId;
    this.pendingExitsById.set(tp.orderId, {
      orderId: tp.orderId,
      reason: "take-profit",
      price: pos.tpPrice
    });

    // SL: stop-market order
    const currentPrice = this.lastPrice;
    const triggerHit = pos.direction === "LONG"
      ? currentPrice <= pos.slPrice
      : currentPrice >= pos.slPrice;

    if (triggerHit) {
      log(`TRADER ${this.symbol}`, `SL trigger already hit — closing at market`);
      this.pendingExitsById.delete(tp.orderId);
      try { await this.api.cancelOrder({ symbol: this.symbol, orderId: tp.orderId }); } catch (_) {}
      await this._handleExitFill("stop-loss", pos.slPrice);
      return;
    }

    try {
      const sl = await this.api.placeStopLimitOrder({
        symbol: this.symbol,
        side: closeSide,
        quantity: pos.quantity,
        stopPrice: Number(pos.slPrice.toFixed(6)),
        price: Number(pos.slPrice.toFixed(6)),
        reduceOnly: true,
        positionSide: pos.direction
      });
      pos.slOrderId = sl.orderId;
      this.pendingExitsById.set(sl.orderId, {
        orderId: sl.orderId,
        reason: "stop-loss",
        price: pos.slPrice
      });
    } catch (err) {
      if (err.message && err.message.includes("-2021")) {
        log(`TRADER ${this.symbol}`, `SL would trigger immediately — closing at market`);
        this.pendingExitsById.delete(tp.orderId);
        try { await this.api.cancelOrder({ symbol: this.symbol, orderId: tp.orderId }); } catch (_) {}
        await this._handleExitFill("stop-loss", currentPrice);
        return;
      }
      throw err;
    }

    log(
      `TRADER ${this.symbol}`,
      `Exit orders placed: TP=${formatNumber(pos.tpPrice, 6)} SL=${formatNumber(pos.slPrice, 6)}`
    );
  }

  async _handleExitFill(reason, exitPrice) {
    const pos = this.position;
    if (!pos) return;

    // Cancel the counterpart order
    const otherOrderId = reason === "take-profit" ? pos.slOrderId : pos.tpOrderId;
    if (otherOrderId) {
      this.pendingExitsById.delete(otherOrderId);
      try {
        await this.api.cancelOrder({ symbol: this.symbol, orderId: otherOrderId });
      } catch (_) {}
    }
    // Clean up this order
    const thisOrderId = reason === "take-profit" ? pos.tpOrderId : pos.slOrderId;
    if (thisOrderId) this.pendingExitsById.delete(thisOrderId);

    // Record PnL
    const dir = pos.direction === "LONG" ? 1 : -1;
    const grossPnl = (exitPrice - pos.entryPrice) * pos.quantity * dir;
    const exitFee = exitPrice * pos.quantity * this._getFeeRate();
    this.feesPaid += exitFee;
    const totalFees = pos.entryFee + exitFee;
    const netPnl = grossPnl - totalFees;
    this.realizedPnl += netPnl;

    this.tradeHistory.push({
      tradeNumber: pos.tradeNumber,
      direction: pos.direction,
      openReason: pos.openReason,
      entry: pos.entryPrice,
      exit: exitPrice,
      quantity: pos.quantity,
      notional: pos.notional,
      grossPnl,
      fees: totalFees,
      netPnl,
      reason,
      closedAt: new Date().toISOString()
    });

    store.recordTrade({ pnl: grossPnl, fees: totalFees });

    log(
      `TRADER ${this.symbol}`,
      `#${pos.tradeNumber} CLOSE ${pos.direction} [${reason}] @ ${formatNumber(exitPrice, 6)} ` +
        `gross=${formatNumber(grossPnl)} net=${formatNumber(netPnl)}`
    );

    const closedDirection = pos.direction;
    this.position = null;
    this.totalTrades++;

    if (reason === "take-profit") {
      this._recordWin();
      // TP → reopen same direction
      await this._openPosition(closedDirection, "take-profit");
    } else {
      this._recordLoss();
      // SL → open opposite direction
      const nextDirection = closedDirection === "LONG" ? "SHORT" : "LONG";
      await this._openPosition(nextDirection, "stop-loss");
    }
    this._updateStore();
  }

  // ── Order event handlers (live mode) ────────────────────────────

  async _onOrderFilled(event) {
    if (!this.active || event.symbol !== this.symbol) return;
    const pending = this.pendingExitsById.get(event.orderId);
    if (!pending) return;
    this.pendingExitsById.delete(event.orderId);

    const exitPrice = Number(event.price || pending.price);
    log(
      `TRADER ${this.symbol}`,
      `Order filled: ${pending.reason} @ ${formatNumber(exitPrice, 6)}`
    );
    await this._handleExitFill(pending.reason, exitPrice);
  }

  _onOrderCancelled(event) {
    if (!this.active || event.symbol !== this.symbol) return;
    if (this.pendingExitsById.has(event.orderId)) {
      log(`TRADER ${this.symbol}`, `Exit order cancelled: id=${event.orderId}`);
      this.pendingExitsById.delete(event.orderId);
      this._updateStore();
    }
  }

  // ── Price feeds ─────────────────────────────────────────────────

  async _onMarkPrice({ symbol, price }) {
    if (!this.active || symbol !== this.symbol) return;
    this.lastPrice = price;
    await this._checkPosition(price);
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
    await this._checkPosition(price);
    this._updateStore();
  }

  // ── Core position check (test-mode simulation) ─────────────────
  //
  // In live mode, TP/SL are handled by exchange order fills.
  // In test mode, _checkPosition simulates fills when price hits TP/SL.

  async _checkPosition(price) {
    if (this._processing || !this.position) return;
    this.lastPrice = price;

    const now = Date.now();
    if (now - this._lastTradeTime < this._minTradeIntervalMs) return;

    if (config.mode !== "test") return;

    const pos = this.position;

    // TP check
    if (pos.direction === "SHORT" && price <= pos.tpPrice) {
      this._processing = true;
      this._lastTradeTime = now;
      await this._handleExitFill("take-profit", pos.tpPrice);
      this._processing = false;
      return;
    }
    if (pos.direction === "LONG" && price >= pos.tpPrice) {
      this._processing = true;
      this._lastTradeTime = now;
      await this._handleExitFill("take-profit", pos.tpPrice);
      this._processing = false;
      return;
    }

    // SL check
    if (pos.direction === "SHORT" && price >= pos.slPrice) {
      this._processing = true;
      this._lastTradeTime = now;
      await this._handleExitFill("stop-loss", pos.slPrice);
      this._processing = false;
      return;
    }
    if (pos.direction === "LONG" && price <= pos.slPrice) {
      this._processing = true;
      this._lastTradeTime = now;
      await this._handleExitFill("stop-loss", pos.slPrice);
      this._processing = false;
      return;
    }
  }

  // ── Stats helpers ───────────────────────────────────────────────

  _recordWin() {
    this.wins++;
    if (this.currentStreak >= 0) this.currentStreak++;
    else this.currentStreak = 1;
    if (this.currentStreak > this.longestWinStreak) {
      this.longestWinStreak = this.currentStreak;
    }
  }

  _recordLoss() {
    this.losses++;
    if (this.currentStreak <= 0) this.currentStreak--;
    else this.currentStreak = -1;
    if (Math.abs(this.currentStreak) > this.longestLossStreak) {
      this.longestLossStreak = Math.abs(this.currentStreak);
    }
  }

  // ── Unrealized PnL ─────────────────────────────────────────────

  _calcUnrealizedPnl(price) {
    if (!this.position) return 0;
    const pos = this.position;
    const dir = pos.direction === "LONG" ? 1 : -1;
    const grossPnl = (price - pos.entryPrice) * pos.quantity * dir;
    const exitFee = price * pos.quantity * this._getFeeRate();
    return grossPnl - pos.entryFee - exitFee;
  }

  // ── Store sync ──────────────────────────────────────────────────

  _updateStore() {
    if (!this.active) return;
    const price = this.lastPrice || 0;

    const serializePos = (pos) =>
      pos
        ? {
            direction: pos.direction,
            openReason: pos.openReason,
            entryPrice: pos.entryPrice,
            quantity: pos.quantity,
            notional: pos.notional,
            tpPrice: pos.tpPrice,
            slPrice: pos.slPrice,
            tradeNumber: pos.tradeNumber
          }
        : null;

    store.upsertTrader({
      id: this.id,
      symbol: this.symbol,
      traderType: this.traderType,
      lastPrice: price,
      leverage: this.leverage,
      openPositions: this.position ? 1 : 0,
      pendingOrders: this.pendingExitsById.size,
      realizedPnl: this.realizedPnl,
      unrealizedPnl: this._calcUnrealizedPnl(price),
      feesPaid: this.feesPaid,
      createdAt: this.createdAt,
      totalTrades: this.totalTrades,
      wins: this.wins,
      losses: this.losses,
      winRate:
        this.wins + this.losses > 0
          ? (this.wins / (this.wins + this.losses)) * 100
          : 0,
      currentStreak: this.currentStreak,
      longestWinStreak: this.longestWinStreak,
      longestLossStreak: this.longestLossStreak,
      equityAtCreation: this.equityAtCreation,
      equityFraction: this.equityFraction,
      baseNotional: this.baseNotional,
      notional: this.notional,
      position: serializePos(this.position),
      tradeHistory: this.tradeHistory,
      status: this.active ? "ACTIVE" : "STOPPED"
    });
  }
}

module.exports = PerpetualTrader;
