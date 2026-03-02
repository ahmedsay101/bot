const config = require("../utils/config");
const { log } = require("../utils/logger");
const store = require("../state/store");

function formatNumber(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return Number(value).toFixed(digits);
}

/**
 * PerpetualTrader – independent dual-position strategy.
 *
 * Rules:
 * 1. Max one LONG and one SHORT position at a time.
 * 2. Take profit → close position, open new same direction (win).
 * 3. When a position loses by createNewPositionAt% and the counter-slot
 *    is empty → open counter-position (hedge). The losing position stays
 *    open until SL.
 * 4. Stop loss → close position (loss). Nothing else opens from SL alone.
 * 5. Destruction (manual or rotation) cancels all pending TP/SL
 *    orders and closes all open positions at market.
 *
 * TP/SL are placed as exchange orders (limit + stop-market).
 * Hedge triggers remain code-managed (checked per tick).
 */
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

    // Notional based on equity fraction
    const equityFraction = Number(config.equityFraction) || 0.01;
    const currentEquity =
      store.getStatus().equity || Number(config.startingBalanceUSDT) || 100;
    this.equityAtCreation = currentEquity;
    this.equityFraction = equityFraction;
    this.baseNotional = equityFraction * currentEquity;
    this.notional = this.baseNotional * this.leverage;

    log(
      `TRADER ${this.symbol}`,
      `Equity: fraction=${equityFraction}, equity=${currentEquity}, ` +
        `base=$${formatNumber(this.baseNotional)}, notional=$${formatNumber(this.notional)}`
    );

    // Direction-based position slots (max 1 each)
    this.longPosition = null;
    this.shortPosition = null;
    this.startDirection = "SHORT";

    // Statistics
    this.totalTrades = 0;
    this.wins = 0;
    this.losses = 0;
    this.currentStreak = 0;
    this.longestWinStreak = 0;
    this.longestLossStreak = 0;
    this.consecutiveSameDir = 0;
    this._lastTpDirection = null;

    // Guard flags
    this._processing = false;
    this._lastTradeTime = 0;
    this._minTradeIntervalMs = 2000;
    this._tradeSeq = 0;

    this._onMarkPrice = this._onMarkPrice.bind(this);
    this._onBookTicker = this._onBookTicker.bind(this);
    this._onOrderFilled = this._onOrderFilled.bind(this);
    this._onOrderCancelled = this._onOrderCancelled.bind(this);

    // Pending TP/SL exchange orders: orderId → { orderId, direction, reason, price }
    this.pendingExitsById = new Map();
  }

  // ── Config helpers ──────────────────────────────────────────────

  _getTakeProfitPercent() {
    return Number(config.takeProfitPercent) || 1;
  }

  _getStopLossPercent() {
    return Number(config.stopLossPercent) || 1;
  }

  _getCreateNewPositionAt() {
    return Number(config.createNewPositionAt) || this._getTakeProfitPercent();
  }

  _getFeeRate() {
    return Number(config.feeRate) || 0.0004;
  }

  _calcQuantity(price, notional) {
    if (notional <= 0 || price <= 0) return 0;
    return Number((notional / price).toFixed(4));
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
      `Started – leverage=${this.leverage}x notional=$${formatNumber(this.notional)}`
    );
    this._updateStore();
  }

  async destroy(reason, options = {}) {
    if (!this.active) return;
    const { closePositions = true } = options;
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

    if (closePositions) {
      if (this.longPosition) await this._closePosition("LONG", "destroy");
      if (this.shortPosition) await this._closePosition("SHORT", "destroy");
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
    const qty = this._calcQuantity(price, this.notional);

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
    const pos = {
      direction,
      openReason,
      entryPrice: fillPrice,
      quantity: qty,
      notional: this.notional,
      tpPrice,
      slPrice,
      tradeNumber: this._tradeSeq,
      entryFee
    };

    if (direction === "LONG") this.longPosition = pos;
    else this.shortPosition = pos;

    log(
      `TRADER ${this.symbol}`,
      `#${pos.tradeNumber} OPEN ${direction} [${openReason}] qty=${qty} ` +
        `entry=${formatNumber(fillPrice, 6)} TP=${formatNumber(tpPrice, 6)} SL=${formatNumber(slPrice, 6)}`
    );

    this._updateStore();
    await this._placeExitOrders(pos);
  }

  async _closePosition(direction, reason, targetPrice = null) {
    const pos = direction === "LONG" ? this.longPosition : this.shortPosition;
    if (!pos) return;

    const side = direction === "LONG" ? "SELL" : "BUY";
    const result = await this.api.placeMarketOrder({
      symbol: this.symbol,
      side,
      quantity: pos.quantity,
      positionSide: direction
    });

    const exitPrice = targetPrice || Number(result.price) || this.lastPrice;
    const dir = direction === "LONG" ? 1 : -1;
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
      `#${pos.tradeNumber} CLOSE ${direction} [${reason}] @ ${formatNumber(exitPrice, 6)} ` +
        `gross=${formatNumber(grossPnl)} net=${formatNumber(netPnl)}`
    );

    if (direction === "LONG") this.longPosition = null;
    else this.shortPosition = null;
  }

  // ── Exit orders (TP limit + SL stop-market) ─────────────────────

  async _placeExitOrders(pos) {
    const closeSide = pos.direction === "LONG" ? "SELL" : "BUY";

    // TP: limit order (reduceOnly)
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
      direction: pos.direction,
      reason: "take-profit",
      price: pos.tpPrice
    });

    // SL: stop-market order (reduceOnly)
    const currentPrice = this.lastPrice;
    const triggerHit = pos.direction === "LONG"
      ? currentPrice <= pos.slPrice
      : currentPrice >= pos.slPrice;

    if (triggerHit) {
      log(`TRADER ${this.symbol}`, `SL trigger already hit — closing at market`);
      this.pendingExitsById.delete(tp.orderId);
      try { await this.api.cancelOrder({ symbol: this.symbol, orderId: tp.orderId }); } catch (_) {}
      await this._handleExitFill(pos.direction, "stop-loss", currentPrice);
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
        direction: pos.direction,
        reason: "stop-loss",
        price: pos.slPrice
      });
    } catch (err) {
      if (err.message && err.message.includes("-2021")) {
        log(`TRADER ${this.symbol}`, `SL would trigger immediately — closing at market`);
        this.pendingExitsById.delete(tp.orderId);
        try { await this.api.cancelOrder({ symbol: this.symbol, orderId: tp.orderId }); } catch (_) {}
        await this._handleExitFill(pos.direction, "stop-loss", currentPrice);
        return;
      }
      throw err;
    }

    log(
      `TRADER ${this.symbol}`,
      `Exit orders placed: TP=${formatNumber(pos.tpPrice, 6)} SL=${formatNumber(pos.slPrice, 6)}`
    );
  }

  async _handleExitFill(direction, reason, exitPrice) {
    const pos = direction === "LONG" ? this.longPosition : this.shortPosition;
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
    const dir = direction === "LONG" ? 1 : -1;
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
      `#${pos.tradeNumber} CLOSE ${direction} [${reason}] @ ${formatNumber(exitPrice, 6)} ` +
        `gross=${formatNumber(grossPnl)} net=${formatNumber(netPnl)}`
    );

    if (direction === "LONG") this.longPosition = null;
    else this.shortPosition = null;

    this.totalTrades++;
    if (reason === "take-profit") {
      this._recordWin(direction);
      await this._openPosition(direction, "take-profit");
    } else {
      this._recordLoss();
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
      `Order filled: ${pending.reason} ${pending.direction} @ ${formatNumber(exitPrice, 6)}`
    );
    await this._handleExitFill(pending.direction, pending.reason, exitPrice);
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

  // ── Core position check (one event per tick) ────────────────────
  //
  // In live mode, TP/SL are handled by exchange order fills (_onOrderFilled).
  // In test mode, _checkPosition simulates fills when price hits TP/SL.
  // Hedge triggers are always code-managed in both modes.

  async _checkPosition(price) {
    if (this._processing) return;
    if (!this.longPosition && !this.shortPosition) return;
    this.lastPrice = price;

    const now = Date.now();
    if (now - this._lastTradeTime < this._minTradeIntervalMs) return;

    const short = this.shortPosition;
    const long = this.longPosition;

    // ── 1. TP checks (test-mode simulation — exit winners first) ──

    if (config.mode === "test") {
      if (short && price <= short.tpPrice) {
        this._processing = true;
        this._lastTradeTime = now;
        await this._handleExitFill("SHORT", "take-profit", short.tpPrice);
        this._processing = false;
        return;
      }

      if (long && price >= long.tpPrice) {
        this._processing = true;
        this._lastTradeTime = now;
        await this._handleExitFill("LONG", "take-profit", long.tpPrice);
        this._processing = false;
        return;
      }
    }

    // ── 2. Hedge triggers (always code-managed) ──

    const hedgePct = this._getCreateNewPositionAt();

    if (short && !long) {
      const lossPct = ((price - short.entryPrice) / short.entryPrice) * 100;
      if (lossPct >= hedgePct) {
        this._processing = true;
        this._lastTradeTime = now;
        log(
          `TRADER ${this.symbol}`,
          `SHORT lost ${formatNumber(lossPct)}% → opening LONG hedge`
        );
        await this._openPosition("LONG", "hedge");
        this._processing = false;
        return;
      }
    }

    if (long && !short) {
      const lossPct = ((long.entryPrice - price) / long.entryPrice) * 100;
      if (lossPct >= hedgePct) {
        this._processing = true;
        this._lastTradeTime = now;
        log(
          `TRADER ${this.symbol}`,
          `LONG lost ${formatNumber(lossPct)}% → opening SHORT hedge`
        );
        await this._openPosition("SHORT", "hedge");
        this._processing = false;
        return;
      }
    }

    // ── 3. SL checks (test-mode simulation — exit losers) ──

    if (config.mode === "test") {
      if (short && price >= short.slPrice) {
        this._processing = true;
        this._lastTradeTime = now;
        await this._handleExitFill("SHORT", "stop-loss", short.slPrice);
        this._processing = false;
        return;
      }

      if (long && price <= long.slPrice) {
        this._processing = true;
        this._lastTradeTime = now;
        await this._handleExitFill("LONG", "stop-loss", long.slPrice);
        this._processing = false;
        return;
      }
    }
  }

  // ── Stats helpers ───────────────────────────────────────────────

  _recordWin(direction) {
    this.wins++;
    if (this._lastTpDirection === direction) {
      this.consecutiveSameDir++;
    } else {
      this.consecutiveSameDir = 1;
    }
    this._lastTpDirection = direction;

    if (this.currentStreak >= 0) this.currentStreak++;
    else this.currentStreak = 1;
    if (this.currentStreak > this.longestWinStreak) {
      this.longestWinStreak = this.currentStreak;
    }
  }

  _recordLoss() {
    this.losses++;
    this.consecutiveSameDir = 0;

    if (this.currentStreak <= 0) this.currentStreak--;
    else this.currentStreak = -1;
    if (Math.abs(this.currentStreak) > this.longestLossStreak) {
      this.longestLossStreak = Math.abs(this.currentStreak);
    }
  }

  // ── Unrealized PnL ─────────────────────────────────────────────

  _calcUnrealizedPnl(price) {
    let total = 0;
    for (const pos of [this.longPosition, this.shortPosition]) {
      if (!pos) continue;
      const dir = pos.direction === "LONG" ? 1 : -1;
      const grossPnl = (price - pos.entryPrice) * pos.quantity * dir;
      const exitFee = price * pos.quantity * this._getFeeRate();
      total += grossPnl - pos.entryFee - exitFee;
    }
    return total;
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
      openPositions:
        (this.longPosition ? 1 : 0) + (this.shortPosition ? 1 : 0),
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
      consecutiveSameDir: this.consecutiveSameDir,
      equityAtCreation: this.equityAtCreation,
      equityFraction: this.equityFraction,
      baseNotional: this.baseNotional,
      notional: this.notional,
      longPosition: serializePos(this.longPosition),
      shortPosition: serializePos(this.shortPosition),
      tradeHistory: this.tradeHistory,
      status: this.active ? "ACTIVE" : "STOPPED"
    });
  }
}

module.exports = PerpetualTrader;
