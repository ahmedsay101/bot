const config = require("../utils/config");
const { log } = require("../utils/logger");
const { pctChange } = require("../utils/math");
const store = require("../state/store");

function fmt(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return Number(value).toFixed(digits);
}

class GridTrader {
  constructor({ symbol, api, onDestroy }) {
    this.id = `${symbol}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    this.symbol = symbol;
    this.api = api;
    this.onDestroy = onDestroy;
    this.traderType = "GRID";

    this.basePrice = null;
    this.active = true;
    this.createdAt = new Date().toISOString();
    this.tradeHistory = [];
    this.realizedPnl = 0;
    this.feesPaid = 0;
    this.lastPrice = null;

    // Equity allocated to this trader = fixedNotional from config
    this.allocatedEquity = Number(config.fixedNotional) || 500;
    this.leverage = Number(config.leverage) || 2;
    this.gridLevels = Number(config.gridLevels) || 5;
    this.gapPercent = Number(config.gapPercent) || 1;
    this.takeProfitPercent = Number(config.takeProfitPercent) || 5;

    // Total orders = gridLevels * 2 (longs + shorts)
    this.totalOrders = this.gridLevels * 2;
    // Notional per order = allocatedEquity / totalOrders * leverage
    this.notionalPerOrder = (this.allocatedEquity / this.totalOrders) * this.leverage;

    // Track orders and positions per level
    // levels: Map<levelIndex, { direction, price, orderId, status, position }>
    // levelIndex: 1..N for longs (above), -1..-N for shorts (below)
    this.levels = new Map();
    this.pendingEntriesById = new Map(); // orderId -> levelIndex
    this.positions = new Map(); // levelIndex -> position object
    this.filledLongCount = 0;
    this.filledShortCount = 0;

    this._onMarkPrice = this._onMarkPrice.bind(this);
    this._onBookTicker = this._onBookTicker.bind(this);
    this._onOrderFilled = this._onOrderFilled.bind(this);
    this._onOrderCancelled = this._onOrderCancelled.bind(this);
  }

  async start() {
    this.basePrice = await this.api.getMarkPrice(this.symbol);
    this.lastPrice = this.basePrice;

    await this._placeAllEntries();

    this.api.on("markPrice", this._onMarkPrice);
    this.api.on("bookTicker", this._onBookTicker);
    this.api.on("orderFilled", this._onOrderFilled);
    this.api.on("orderCancelled", this._onOrderCancelled);

    log(`GRID ${this.symbol}`, `Started: base=${fmt(this.basePrice, 6)} levels=${this.gridLevels} gap=${this.gapPercent}% equity=$${this.allocatedEquity} leverage=${this.leverage}x`);
    this._updateStore();
  }

  async destroy(reason) {
    if (!this.active) return;
    this.active = false;
    this.api.off("markPrice", this._onMarkPrice);
    this.api.off("bookTicker", this._onBookTicker);
    this.api.off("orderFilled", this._onOrderFilled);
    this.api.off("orderCancelled", this._onOrderCancelled);

    // Cancel all pending entry orders
    for (const [orderId] of this.pendingEntriesById) {
      try {
        await this.api.cancelOrder({ symbol: this.symbol, orderId });
      } catch (err) {
        log(`GRID ${this.symbol}`, `Cancel entry failed ${orderId}: ${err.message}`);
      }
    }
    await this.api.cancelAllOpenOrders(this.symbol);

    // Close all open positions at market
    await this._closeAllPositions(this.lastPrice || this.basePrice);

    store.removeTrader(this.id, {
      id: this.id,
      symbol: this.symbol,
      realizedPnl: this.realizedPnl,
      feesPaid: this.feesPaid,
      allocatedEquity: this.allocatedEquity,
      profitPercent: this.allocatedEquity > 0 ? (this.realizedPnl / this.allocatedEquity) * 100 : 0,
      createdAt: this.createdAt,
      closedAt: new Date().toISOString(),
      reason
    });

    log(`GRID ${this.symbol}`, `Destroyed (${reason}) PnL=$${fmt(this.realizedPnl)}`);
    if (this.onDestroy) this.onDestroy(this.symbol, this.realizedPnl, reason);
  }

  /* ── Place grid entries ── */
  async _placeAllEntries() {
    const gap = this.gapPercent;
    const half = gap / 2;

    for (let i = 1; i <= this.gridLevels; i++) {
      // Long levels: above base price
      // First at +half%, then each subsequent +gap% from previous
      const longPct = half + (i - 1) * gap;
      const longPrice = pctChange(this.basePrice, longPct);
      await this._placeEntryOrder("LONG", longPrice, i);

      // Short levels: below base price
      const shortPct = -(half + (i - 1) * gap);
      const shortPrice = pctChange(this.basePrice, shortPct);
      await this._placeEntryOrder("SHORT", shortPrice, -i);
    }
  }

  async _placeEntryOrder(direction, price, levelIndex) {
    const side = direction === "LONG" ? "BUY" : "SELL";
    const qty = this.notionalPerOrder / price;
    const roundedQty = Number(qty.toFixed(4));
    const positionSide = direction === "LONG" ? "LONG" : "SHORT";

    const result = await this.api.placeStopLimitOrder({
      symbol: this.symbol,
      side,
      quantity: roundedQty,
      stopPrice: Number(price.toFixed(6)),
      price: Number(price.toFixed(6)),
      reduceOnly: false,
      positionSide
    });

    this.pendingEntriesById.set(result.orderId, levelIndex);
    this.levels.set(levelIndex, {
      index: levelIndex,
      direction,
      price,
      orderId: result.orderId,
      status: "PENDING",
      quantity: roundedQty
    });

    log(`GRID ${this.symbol}`, `Entry ${direction} L${levelIndex} @ ${fmt(price, 6)} qty=${roundedQty}`);
  }

  /* ── Event handlers ── */
  _onOrderFilled(event) {
    if (!this.active || event.symbol !== this.symbol) return;

    const levelIndex = this._findEntryLevel(event);
    if (levelIndex !== null) {
      this._handleEntryFill(event, levelIndex);
      return;
    }
  }

  _findEntryLevel(event) {
    let levelIdx = this.pendingEntriesById.get(event.orderId);
    if (levelIdx !== undefined) return levelIdx;

    // Try numeric/string variants
    if (event.numericOrderId !== undefined) {
      levelIdx = this.pendingEntriesById.get(event.numericOrderId);
      if (levelIdx !== undefined) return levelIdx;
      levelIdx = this.pendingEntriesById.get(String(event.numericOrderId));
      if (levelIdx !== undefined) return levelIdx;
    }
    if (event.clientOrderId) {
      levelIdx = this.pendingEntriesById.get(event.clientOrderId);
      if (levelIdx !== undefined) return levelIdx;
    }
    if (typeof event.orderId === "number") {
      levelIdx = this.pendingEntriesById.get(String(event.orderId));
      if (levelIdx !== undefined) return levelIdx;
    } else if (typeof event.orderId === "string" && /^\d+$/.test(event.orderId)) {
      levelIdx = this.pendingEntriesById.get(Number(event.orderId));
      if (levelIdx !== undefined) return levelIdx;
    }
    return null;
  }

  _handleEntryFill(event, levelIndex) {
    // Remove from pending
    this.pendingEntriesById.delete(event.orderId);

    const level = this.levels.get(levelIndex);
    if (!level) return;

    const entryPrice = Number(event.price || level.price);
    const quantity = level.quantity;

    // Entry fee
    const entryFee = entryPrice * quantity * (Number(config.feeRate) || 0.0004);
    this.feesPaid += entryFee;

    // Track as position
    const position = {
      levelIndex,
      direction: level.direction,
      entryPrice,
      quantity,
      entryFee
    };
    this.positions.set(levelIndex, position);

    // Update level status
    level.status = "FILLED";
    level.entryPrice = entryPrice;

    // Update fill counts
    if (level.direction === "LONG") this.filledLongCount++;
    else this.filledShortCount++;

    log(`GRID ${this.symbol}`, `Filled ${level.direction} L${levelIndex} @ ${fmt(entryPrice, 6)}`);

    this._updateStore();
    this._checkDestroyConditions();
  }

  _onOrderCancelled(event) {
    if (!this.active || event.symbol !== this.symbol) return;

    const levelIndex = this._findEntryLevel(event);
    if (levelIndex !== null) {
      this.pendingEntriesById.delete(event.orderId);
      const level = this.levels.get(levelIndex);
      if (level) level.status = "CANCELLED";
      log(`GRID ${this.symbol}`, `Entry cancelled L${levelIndex}`);
      this._updateStore();
    }
  }

  async _onMarkPrice({ symbol, price }) {
    if (!this.active || symbol !== this.symbol) return;
    this.lastPrice = price;
    if (config.mode === "test") this._simulateExitCheck(price);
    await this._checkBasePriceCross(price);
    this._updateStore();
    this._checkDestroyConditions();
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
    if (config.mode === "test") this._simulateExitCheck(price);
    await this._checkBasePriceCross(price);
    this._updateStore();
    this._checkDestroyConditions();
  }

  /* ── Exit / PnL ── */
  _simulateExitCheck(_price) {
    // In test mode, stop-limit fills are handled by the API's _simulateFills.
    // Positions are closed when price crosses back to basePrice.
  }

  /**
   * When price crosses back to basePrice, close all filled positions at market
   * and remove them from the grid (level becomes CLOSED).
   */
  async _checkBasePriceCross(price) {
    if (!this.active || this.positions.size === 0) return;

    // Check if price has crossed base: longs are above base, so price returning
    // down to base means long profits should be taken. Shorts are below base,
    // so price returning up to base means short profits should be taken.
    // Simple rule: any filled position whose direction would be profitable at
    // basePrice gets closed when price is back at (or past) basePrice.
    const tolerance = this.basePrice * 0.0005; // 0.05% tolerance band
    const atBase = Math.abs(price - this.basePrice) <= tolerance;
    // Also trigger if price crossed through base:
    // - For long positions (above base): price moved back down to or below base
    const belowBase = price <= this.basePrice + tolerance;
    // - For short positions (below base): price moved back up to or above base
    const aboveBase = price >= this.basePrice - tolerance;

    const toClose = [];
    for (const [levelIndex, pos] of this.positions) {
      if (pos.direction === "LONG" && belowBase) {
        toClose.push(levelIndex);
      } else if (pos.direction === "SHORT" && aboveBase) {
        toClose.push(levelIndex);
      }
    }

    for (const levelIndex of toClose) {
      await this._closePosition(levelIndex, price, "base-cross");
    }
  }

  /** Close a single position by level index */
  async _closePosition(levelIndex, currentPrice, reason) {
    const pos = this.positions.get(levelIndex);
    if (!pos) return;

    const side = pos.direction === "LONG" ? "SELL" : "BUY";
    const positionSide = pos.direction === "LONG" ? "LONG" : "SHORT";
    const result = await this.api.placeMarketOrder({
      symbol: this.symbol,
      side,
      quantity: pos.quantity,
      positionSide
    });

    const exitPrice = result.price || currentPrice;
    const direction = pos.direction === "LONG" ? 1 : -1;
    const grossPnl = (exitPrice - pos.entryPrice) * pos.quantity * direction;
    const exitFee = exitPrice * pos.quantity * (Number(config.feeRate) || 0.0004);

    this.feesPaid += exitFee;
    this.realizedPnl += grossPnl - exitFee - pos.entryFee;

    this.tradeHistory.push({
      levelIndex,
      direction: pos.direction,
      entry: pos.entryPrice,
      exit: exitPrice,
      quantity: pos.quantity,
      grossPnl,
      fees: pos.entryFee + exitFee,
      netPnl: grossPnl - pos.entryFee - exitFee,
      reason
    });

    store.recordTrade({ pnl: grossPnl, fees: pos.entryFee + exitFee });

    // Remove position and mark level as CLOSED
    this.positions.delete(levelIndex);
    const level = this.levels.get(levelIndex);
    if (level) level.status = "CLOSED";

    log(`GRID ${this.symbol}`, `Closed ${pos.direction} L${levelIndex} @ ${fmt(exitPrice, 6)} (${reason}) PnL=${fmt(grossPnl - pos.entryFee - exitFee, 4)}`);
  }

  _calcUnrealizedPnl(price) {
    let pnl = 0;
    for (const pos of this.positions.values()) {
      const direction = pos.direction === "LONG" ? 1 : -1;
      pnl += (price - pos.entryPrice) * pos.quantity * direction;
    }
    return pnl;
  }

  /** Estimate exit fees for all open positions at the given price */
  _estimateExitFees(price) {
    const feeRate = Number(config.feeRate) || 0.0004;
    let fees = 0;
    for (const pos of this.positions.values()) {
      fees += price * pos.quantity * feeRate;
    }
    return fees;
  }

  _calcTotalPnl(price) {
    return this.realizedPnl + this._calcUnrealizedPnl(price) - this._estimateExitFees(price);
  }

  _calcProfitPercent(price) {
    if (this.allocatedEquity <= 0) return 0;
    return (this._calcTotalPnl(price) / this.allocatedEquity) * 100;
  }

  async _closeAllPositions(fallbackPrice) {
    for (const [levelIndex, pos] of this.positions) {
      const side = pos.direction === "LONG" ? "SELL" : "BUY";
      const positionSide = pos.direction === "LONG" ? "LONG" : "SHORT";
      const result = await this.api.placeMarketOrder({
        symbol: this.symbol,
        side,
        quantity: pos.quantity,
        positionSide
      });

      const exitPrice = result.price || fallbackPrice;
      const direction = pos.direction === "LONG" ? 1 : -1;
      const grossPnl = (exitPrice - pos.entryPrice) * pos.quantity * direction;
      const exitFee = exitPrice * pos.quantity * (Number(config.feeRate) || 0.0004);

      this.feesPaid += exitFee;
      this.realizedPnl += grossPnl - exitFee - pos.entryFee;

      this.tradeHistory.push({
        levelIndex,
        direction: pos.direction,
        entry: pos.entryPrice,
        exit: exitPrice,
        quantity: pos.quantity,
        grossPnl,
        fees: pos.entryFee + exitFee,
        netPnl: grossPnl - pos.entryFee - exitFee,
        reason: "close"
      });

      store.recordTrade({ pnl: grossPnl, fees: pos.entryFee + exitFee });
    }
    this.positions.clear();
  }

  /* ── Destroy conditions ── */
  _checkDestroyConditions() {
    if (!this.active) return;

    // Condition 1: Max lifetime exceeded
    const maxLife = Number(config.maxLifetimeMs) || 0;
    if (maxLife > 0 && Date.now() - new Date(this.createdAt).getTime() >= maxLife) {
      log(`GRID ${this.symbol}`, `Max lifetime reached — destroying`);
      this.destroy("max-lifetime");
      return;
    }

    // Condition 2: Profit % target reached
    const price = this.lastPrice || this.basePrice;
    const profitPct = this._calcProfitPercent(price);
    if (profitPct >= this.takeProfitPercent) {
      log(`GRID ${this.symbol}`, `Take profit reached: ${fmt(profitPct)}% >= ${this.takeProfitPercent}% — destroying`);
      this.destroy("take-profit");
      return;
    }
  }

  /* ── Store update ── */
  _updateStore() {
    if (!this.active) return;
    const price = this.lastPrice || this.basePrice || 0;
    const unrealizedPnl = this._calcUnrealizedPnl(price);
    const estExitFees = this._estimateExitFees(price);
    const totalPnl = this.realizedPnl + unrealizedPnl - estExitFees;
    const profitPercent = this.allocatedEquity > 0 ? (totalPnl / this.allocatedEquity) * 100 : 0;

    // Build ladder: sorted from highest to lowest price
    const ladder = [];
    for (const [idx, level] of this.levels) {
      const pos = this.positions.get(idx);
      let levelUnrealizedPnl = 0;
      if (pos) {
        const dir = pos.direction === "LONG" ? 1 : -1;
        levelUnrealizedPnl = (price - pos.entryPrice) * pos.quantity * dir;
      }
      ladder.push({
        index: idx,
        direction: level.direction,
        price: level.price,
        status: level.status,
        entryPrice: pos ? pos.entryPrice : null,
        quantity: level.quantity,
        unrealizedPnl: levelUnrealizedPnl
      });
    }
    ladder.sort((a, b) => b.price - a.price);

    store.upsertTrader({
      id: this.id,
      symbol: this.symbol,
      traderType: this.traderType,
      lastPrice: price,
      basePrice: this.basePrice,
      allocatedEquity: this.allocatedEquity,
      leverage: this.leverage,
      gridLevels: this.gridLevels,
      gapPercent: this.gapPercent,
      takeProfitPercent: this.takeProfitPercent,
      notionalPerOrder: this.notionalPerOrder,
      totalOrders: this.totalOrders,
      filledLongCount: this.filledLongCount,
      filledShortCount: this.filledShortCount,
      openPositions: this.positions.size,
      pendingOrders: this.pendingEntriesById.size,
      realizedPnl: this.realizedPnl,
      unrealizedPnl,
      totalPnl,
      profitPercent,
      feesPaid: this.feesPaid,
      ladder,
      tradeHistory: this.tradeHistory,
      createdAt: this.createdAt,
      status: this.active ? "ACTIVE" : "STOPPED"
    });
  }
}

module.exports = GridTrader;
