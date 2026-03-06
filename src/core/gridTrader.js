const config = require("../utils/config");
const { log } = require("../utils/logger");
const store = require("../state/store");

function formatNumber(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return Number(value).toFixed(digits);
}

/**
 * GridTrader – short-only grid strategy.
 *
 * Creates levels below the current price spaced by levelSpacingPercent.
 * The closest `maxFilledLevels` levels below the current price are filled
 * with stop-limit SHORT orders.  As price moves, new levels are filled and
 * the window of active orders follows the price.
 *
 * - No take profit.  Positions stay open until the trader is destroyed.
 * - Stop loss per position = 100 / leverage  percent.
 * - Trader is destroyed when |priceChange%| >= destroyPercent (configurable).
 * - On destroy the controller creates a new trader automatically.
 */
class GridTrader {
  constructor({ symbol, api, onDestroy }) {
    this.id = `${symbol}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    this.symbol = symbol;
    this.api = api;
    this.onDestroy = onDestroy;
    this.traderType = "GRID";

    this.startPrice = null;
    this.active = true;
    this.createdAt = new Date().toISOString();
    this.tradeHistory = [];
    this.realizedPnl = 0;
    this.feesPaid = 0;
    this.lastPrice = null;
    this.highestPrice = null;
    this.lowestPrice = null;

    // levelIndex → level state
    // levelIndex 1 = first level below start, 2 = second, etc.
    // Negative indices = levels above start price (filled when price rises)
    this.levels = new Map();

    // Pending stop-limit entry orders: orderId → { orderId, levelIndex, price, quantity }
    this.pendingEntriesById = new Map();

    // Pending SL exit orders: orderId → { orderId, positionId, price }
    this.pendingExitsById = new Map();

    // Open positions: positionId → position
    this.positions = new Map();

    // Processing guard
    this._processing = false;

    this._onMarkPrice = this._onMarkPrice.bind(this);
    this._onBookTicker = this._onBookTicker.bind(this);
    this._onOrderFilled = this._onOrderFilled.bind(this);
    this._onOrderCancelled = this._onOrderCancelled.bind(this);
  }

  // ── Config helpers ──────────────────────────────────────────

  _getSpacingPercent() {
    return Number(config.levelSpacingPercent) || 1;
  }

  _getMaxFilledLevels() {
    return Number(config.maxFilledLevels) || 5;
  }

  _getDestroyPercent() {
    return Number(config.destroyPercent) || 20;
  }

  _getStopLossPercent() {
    const leverage = Number(config.leverage) || 10;
    return 100 / leverage;
  }

  _getFeeRate() {
    return Number(config.feeRate) || 0.0004;
  }

  _calcQuantity(price) {
    const equity = this._equity || Number(config.startingBalanceUSDT) || 200;
    const fraction = Number(config.equityFraction) || 0.25;
    const leverage = Number(config.leverage) || 10;
    const notional = equity * fraction * leverage;
    if (notional <= 0) return 0;
    const qty = notional / price;
    return Number(qty.toFixed(4));
  }

  _getLevelPrice(levelIndex) {
    // levelIndex > 0 → below start price, levelIndex < 0 → above start price
    return this.startPrice * (1 - (levelIndex * this._getSpacingPercent()) / 100);
  }

  _getPriceChangePercent() {
    if (!this.startPrice || !this.lastPrice) return 0;
    return ((this.lastPrice - this.startPrice) / this.startPrice) * 100;
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

    // Place initial levels below current price
    await this._syncLevels();

    this.api.on("markPrice", this._onMarkPrice);
    this.api.on("bookTicker", this._onBookTicker);
    this.api.on("orderFilled", this._onOrderFilled);
    this.api.on("orderCancelled", this._onOrderCancelled);

    log(`TRADER ${this.symbol}`, `Grid initialized @ ${formatNumber(this.startPrice, 6)} | spacing=${this._getSpacingPercent()}% | maxLevels=${this._getMaxFilledLevels()} | SL=${formatNumber(this._getStopLossPercent())}% | destroy=${this._getDestroyPercent()}%`);
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

    // Cancel all pending entry orders
    for (const order of this.pendingEntriesById.values()) {
      try {
        await this.api.cancelOrder({ symbol: this.symbol, orderId: order.orderId });
      } catch (err) {
        log(`TRADER ${this.symbol}`, `Entry cancel failed ${order.orderId}: ${err.message}`);
      }
    }

    // Cancel all pending exit (SL) orders
    for (const order of this.pendingExitsById.values()) {
      try {
        await this.api.cancelOrder({ symbol: this.symbol, orderId: order.orderId });
      } catch (err) {
        log(`TRADER ${this.symbol}`, `Exit cancel failed ${order.orderId}: ${err.message}`);
      }
    }

    await this.api.cancelAllOpenOrders(this.symbol);

    // Close all open positions at market
    if (closePositions) {
      await this._closeAllPositions("destroy");
    }

    store.removeTrader(this.id, {
      id: this.id,
      symbol: this.symbol,
      realizedPnl: this.realizedPnl,
      feesPaid: this.feesPaid,
      createdAt: this.createdAt,
      closedAt: new Date().toISOString(),
      reason,
      priceChange: this._getPriceChangePercent(),
      startPrice: this.startPrice,
      endPrice: this.lastPrice,
      totalPositions: this.tradeHistory.length + this.positions.size
    });

    log(`TRADER ${this.symbol}`, `Destroyed (${reason}) | PnL $${formatNumber(this.realizedPnl)} | change ${formatNumber(this._getPriceChangePercent())}%`);
    if (this.onDestroy) this.onDestroy(this.symbol, this.realizedPnl);
  }

  // ── Level management ────────────────────────────────────────

  /**
   * Ensures the closest `maxFilledLevels` levels below the current price
   * have pending stop-limit SHORT orders.
   *
   * Levels above current price that already have positions are kept.
   * Levels that are too far below (beyond the window) have their
   * pending orders cancelled.
   */
  async _syncLevels() {
    if (this._processing || !this.active) return;
    this._processing = true;

    try {
      const spacing = this._getSpacingPercent();
      const maxLevels = this._getMaxFilledLevels();
      const price = this.lastPrice;

      // Determine which level indices should have pending orders
      // Level index = floor of how many spacings the price is below startPrice + 1 .. +maxLevels
      // But we need levels BELOW current price, so we find the first level below price
      const pctFromStart = ((this.startPrice - price) / this.startPrice) * 100;
      const currentLevelFloat = pctFromStart / spacing;

      // First level below current price
      const firstLevelBelow = Math.ceil(currentLevelFloat + 0.0001);
      // But if price moved above start, firstLevelBelow could be 0 or negative
      // We still want levels below current price

      const targetIndices = new Set();
      for (let i = 0; i < maxLevels; i++) {
        const idx = firstLevelBelow + i;
        const levelPrice = this._getLevelPrice(idx);
        if (levelPrice <= 0) continue;
        targetIndices.add(idx);
      }

      // Check existing levels — cancel orders for levels no longer in target
      for (const [orderId, entry] of this.pendingEntriesById.entries()) {
        if (!targetIndices.has(entry.levelIndex)) {
          // Cancel this order — it's out of the window
          try {
            await this.api.cancelOrder({ symbol: this.symbol, orderId: entry.orderId });
          } catch (_) {}
          this.pendingEntriesById.delete(orderId);
          this.levels.delete(entry.levelIndex);
        }
      }

      // Place orders for levels in target that don't already have an order or position
      for (const idx of targetIndices) {
        const level = this.levels.get(idx);
        if (level && (level.status === "pending" || level.status === "filled")) continue;

        const levelPrice = this._getLevelPrice(idx);
        if (levelPrice <= 0 || levelPrice >= price) continue; // Must be below current price

        await this._placeEntryOrder(idx, levelPrice);
      }
    } finally {
      this._processing = false;
    }
  }

  async _placeEntryOrder(levelIndex, price) {
    const qty = this._calcQuantity(price);
    if (qty <= 0) return;

    try {
      const result = await this.api.placeStopLimitOrder({
        symbol: this.symbol,
        side: "SELL",
        quantity: qty,
        stopPrice: Number(price.toFixed(6)),
        price: Number(price.toFixed(6)),
        reduceOnly: false,
        positionSide: "SHORT"
      });

      this.pendingEntriesById.set(result.orderId, {
        orderId: result.orderId,
        levelIndex,
        price,
        quantity: qty
      });

      this.levels.set(levelIndex, { status: "pending", price, orderId: result.orderId });

      log(`TRADER ${this.symbol}`, `Placed SHORT entry L${levelIndex} @ ${formatNumber(price, 6)}`);
    } catch (err) {
      if (err.message && err.message.includes("-2021")) {
        log(`TRADER ${this.symbol}`, `Entry L${levelIndex} would trigger immediately — filling at market`);
        await this._fillLevelAtMarket(levelIndex, price);
      } else {
        log(`TRADER ${this.symbol}`, `Entry L${levelIndex} failed: ${err.message}`);
      }
    }
  }

  async _fillLevelAtMarket(levelIndex, levelPrice) {
    const qty = this._calcQuantity(levelPrice);
    if (qty <= 0) return;

    try {
      const result = await this.api.placeMarketOrder({
        symbol: this.symbol,
        side: "SELL",
        quantity: qty,
        positionSide: "SHORT"
      });

      const fillPrice = Number(result.price) || this.lastPrice || levelPrice;
      this._createPosition(levelIndex, fillPrice, qty, result.orderId);
    } catch (err) {
      log(`TRADER ${this.symbol}`, `Market fill L${levelIndex} failed: ${err.message}`);
    }
  }

  _createPosition(levelIndex, entryPrice, quantity, entryOrderId) {
    const slPercent = this._getStopLossPercent();
    // SHORT position: SL is above entry
    const stopLossPrice = entryPrice * (1 + slPercent / 100);

    const positionId = `POS-${entryOrderId || levelIndex}-${Date.now()}`;
    const position = {
      id: positionId,
      levelIndex,
      direction: "SHORT",
      entryOrderId,
      entryPrice,
      quantity,
      stopLossPrice,
      slOrderId: null,
      isClosing: false
    };

    this.positions.set(positionId, position);
    this.levels.set(levelIndex, { status: "filled", price: entryPrice, positionId });

    const entryFee = entryPrice * quantity * this._getFeeRate();
    this.feesPaid += entryFee;
    position.entryFee = entryFee;

    // Place SL order
    this._placeStopLoss(position);

    log(`TRADER ${this.symbol}`, `Filled SHORT L${levelIndex} @ ${formatNumber(entryPrice, 6)} | SL @ ${formatNumber(stopLossPrice, 6)}`);
    this._updateStore();
  }

  async _placeStopLoss(position) {
    // In test mode, _maybeForceClose handles SL simulation
    if (config.mode === "test") return;

    const currentPrice = Number(this.lastPrice) || Number(position.entryPrice);
    // SHORT: SL triggers when price goes UP to stopLossPrice
    const triggerHit = currentPrice >= position.stopLossPrice;
    const closeToTrigger = Math.abs(currentPrice - position.stopLossPrice) <= (currentPrice * 0.0002);

    if (triggerHit || closeToTrigger) {
      log(`TRADER ${this.symbol}`, `SL trigger unsafe for L${position.levelIndex} — closing at market`);
      await this._closePosition(position, "stop-loss", currentPrice);
      return;
    }

    try {
      const sl = await this.api.placeStopLimitOrder({
        symbol: this.symbol,
        side: "BUY",
        quantity: position.quantity,
        stopPrice: Number(position.stopLossPrice.toFixed(6)),
        price: Number(position.stopLossPrice.toFixed(6)),
        reduceOnly: true,
        positionSide: "SHORT"
      });

      position.slOrderId = sl.orderId;
      this.pendingExitsById.set(sl.orderId, {
        orderId: sl.orderId,
        positionId: position.id,
        price: position.stopLossPrice
      });

      log(`TRADER ${this.symbol}`, `SL placed L${position.levelIndex} @ ${formatNumber(position.stopLossPrice, 6)}`);
    } catch (err) {
      log(`TRADER ${this.symbol}`, `SL order failed L${position.levelIndex}: ${err.message}`);
      if (err.message && err.message.includes("-2021")) {
        log(`TRADER ${this.symbol}`, `SL would immediately trigger — closing at market`);
        await this._closePosition(position, "stop-loss", currentPrice);
      }
    }
  }

  // ── Order event handlers ────────────────────────────────────

  _findPending(map, event) {
    let match = map.get(event.orderId);
    if (match) return { key: event.orderId, value: match };
    if (event.numericOrderId !== undefined) {
      match = map.get(event.numericOrderId);
      if (match) return { key: event.numericOrderId, value: match };
      match = map.get(String(event.numericOrderId));
      if (match) return { key: String(event.numericOrderId), value: match };
    }
    if (event.clientOrderId) {
      match = map.get(event.clientOrderId);
      if (match) return { key: event.clientOrderId, value: match };
    }
    if (typeof event.orderId === "number") {
      match = map.get(String(event.orderId));
      if (match) return { key: String(event.orderId), value: match };
    } else if (typeof event.orderId === "string" && /^\d+$/.test(event.orderId)) {
      match = map.get(Number(event.orderId));
      if (match) return { key: Number(event.orderId), value: match };
    }
    return null;
  }

  _onOrderFilled(event) {
    if (!this.active || event.symbol !== this.symbol) return;

    // Check entry fills
    const entryMatch = this._findPending(this.pendingEntriesById, event);
    if (entryMatch) {
      const pendingEntry = entryMatch.value;
      this.pendingEntriesById.delete(entryMatch.key);
      const entryPrice = Number(event.price || pendingEntry.price);
      this._createPosition(pendingEntry.levelIndex, entryPrice, pendingEntry.quantity, event.orderId);
      return;
    }

    // Check SL exit fills
    const exitMatch = this._findPending(this.pendingExitsById, event);
    if (exitMatch) {
      const pendingExit = exitMatch.value;
      this.pendingExitsById.delete(exitMatch.key);

      const position = this.positions.get(pendingExit.positionId);
      if (!position || position.isClosing) return;

      const exitPrice = Number(event.price || pendingExit.price);
      this._finalizeClose(position, "stop-loss", exitPrice, event.orderId);
      return;
    }
  }

  _onOrderCancelled(event) {
    if (!this.active || event.symbol !== this.symbol) return;

    const entryMatch = this._findPending(this.pendingEntriesById, event);
    if (entryMatch) {
      log(`TRADER ${this.symbol}`, `Entry cancelled: id=${event.orderId}`);
      this.pendingEntriesById.delete(entryMatch.key);
      const lvl = this.levels.get(entryMatch.value.levelIndex);
      if (lvl && lvl.status === "pending") this.levels.delete(entryMatch.value.levelIndex);
      this._updateStore();
      return;
    }

    const exitMatch = this._findPending(this.pendingExitsById, event);
    if (exitMatch) {
      const pendingExit = exitMatch.value;
      log(`TRADER ${this.symbol}`, `SL cancelled: id=${event.orderId}`);
      this.pendingExitsById.delete(exitMatch.key);

      // SL was cancelled/rejected — close at market if position still open
      const position = this.positions.get(pendingExit.positionId);
      if (position && !position.isClosing) {
        log(`TRADER ${this.symbol}`, `SL rejected — closing position at market`);
        const currentPrice = Number(this.lastPrice) || Number(position.entryPrice);
        this._closePosition(position, "sl-rejected", currentPrice);
      }
      this._updateStore();
      return;
    }
  }

  // ── Price feeds ─────────────────────────────────────────────

  async _onMarkPrice({ symbol, price }) {
    if (!this.active || symbol !== this.symbol) return;
    this.lastPrice = price;
    if (price > this.highestPrice) this.highestPrice = price;
    if (price < this.lowestPrice) this.lowestPrice = price;

    await this._maybeForceClose(price);
    if (!this.active) return;
    await this._checkDestroy(price);
    if (!this.active) return;
    await this._syncLevels();
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

    await this._maybeForceClose(price);
    if (!this.active) return;
    await this._checkDestroy(price);
    if (!this.active) return;
    await this._syncLevels();
    this._updateStore();
  }

  // ── Test-mode SL simulation ─────────────────────────────────

  async _maybeForceClose(price) {
    if (config.mode !== "test" || this.positions.size === 0) return;
    for (const pos of Array.from(this.positions.values())) {
      if (pos.isClosing) continue;
      // SHORT: SL hit when price >= stopLossPrice
      if (price >= pos.stopLossPrice) {
        await this._finalizeClose(pos, "stop-loss", pos.stopLossPrice, null);
        if (!this.active) return;
      }
    }
  }

  // ── Destroy check ───────────────────────────────────────────

  async _checkDestroy(price) {
    const changePercent = this._getPriceChangePercent();
    const destroyPercent = this._getDestroyPercent();
    // Destroy when price drops by destroyPercent (WIN for shorts)
    if (changePercent <= -destroyPercent) {
      log(`TRADER ${this.symbol}`, `Price dropped ${formatNumber(changePercent)}% — destroying (WIN)`);
      await this.destroy("target-reached");
    }
  }

  // ── Close positions ─────────────────────────────────────────

  async _closeAllPositions(reason) {
    for (const pos of Array.from(this.positions.values())) {
      await this._closePosition(pos, reason, this.lastPrice || this.startPrice);
    }
  }

  async _closePosition(pos, reason, fallbackPrice) {
    if (pos.isClosing) return;
    const result = await this.api.placeMarketOrder({
      symbol: this.symbol,
      side: "BUY",
      quantity: pos.quantity,
      positionSide: "SHORT"
    });
    const exitPrice = result.price || fallbackPrice;
    await this._finalizeClose(pos, reason, exitPrice, result.orderId);
  }

  async _finalizeClose(pos, reason, exitPrice, exitOrderId) {
    if (pos.isClosing) return;
    pos.isClosing = true;

    // Cancel SL order if exists
    if (pos.slOrderId) {
      this.pendingExitsById.delete(pos.slOrderId);
      try {
        await this.api.cancelOrder({ symbol: this.symbol, orderId: pos.slOrderId });
      } catch (_) {}
    }

    // Calculate PnL: SHORT → profit when price goes down
    const grossPnl = (pos.entryPrice - exitPrice) * pos.quantity;
    const exitFee = exitPrice * pos.quantity * this._getFeeRate();
    this.feesPaid += exitFee;
    const totalFees = (pos.entryFee || 0) + exitFee;
    const netPnl = grossPnl - totalFees;

    this.positions.delete(pos.id);
    this.realizedPnl += netPnl;

    // Clear level status so it can be re-used
    const level = this.levels.get(pos.levelIndex);
    if (level && level.positionId === pos.id) {
      this.levels.set(pos.levelIndex, { status: "closed", price: level.price });
    }

    this.tradeHistory.push({
      levelIndex: pos.levelIndex,
      direction: "SHORT",
      entry: pos.entryPrice,
      exit: exitPrice,
      quantity: pos.quantity,
      grossPnl,
      fees: totalFees,
      netPnl,
      reason,
      closedAt: new Date().toISOString()
    });

    store.recordTrade({ pnl: grossPnl, fees: totalFees });

    log(
      `TRADER ${this.symbol}`,
      `Closed SHORT L${pos.levelIndex} @ ${formatNumber(exitPrice, 6)} (PnL ${formatNumber(netPnl)}) reason=${reason}`
    );
    this._updateStore();
  }

  // ── Unrealized PnL ─────────────────────────────────────────

  _calcUnrealizedPnl(price) {
    let pnl = 0;
    for (const pos of this.positions.values()) {
      // SHORT: profit = (entry - current) * qty
      const grossPnl = (pos.entryPrice - price) * pos.quantity;
      const exitFee = price * pos.quantity * this._getFeeRate();
      pnl += grossPnl - (pos.entryFee || 0) - exitFee;
    }
    return pnl;
  }

  // ── Store sync ──────────────────────────────────────────────

  _updateStore() {
    if (!this.active) return;
    const price = this.lastPrice || this.startPrice || 0;
    const changePercent = this._getPriceChangePercent();
    const destroyPercent = this._getDestroyPercent();

    // Build level summary for frontend
    const allLevelIndices = new Set();
    for (const [idx] of this.levels) allLevelIndices.add(idx);
    for (const entry of this.pendingEntriesById.values()) allLevelIndices.add(entry.levelIndex);
    for (const pos of this.positions.values()) allLevelIndices.add(pos.levelIndex);

    const levelsList = Array.from(allLevelIndices)
      .sort((a, b) => a - b)
      .map((idx) => {
        const lvl = this.levels.get(idx);
        const pos = Array.from(this.positions.values()).find((p) => p.levelIndex === idx);
        const pending = Array.from(this.pendingEntriesById.values()).find((e) => e.levelIndex === idx);
        const closed = lvl && lvl.status === "closed";

        let status = "empty";
        if (pos) status = "filled";
        else if (pending) status = "pending";
        else if (closed) status = "closed";

        return {
          index: idx,
          price: this._getLevelPrice(idx),
          status,
          entryPrice: pos ? pos.entryPrice : null,
          stopLossPrice: pos ? pos.stopLossPrice : null,
          quantity: pos ? pos.quantity : pending ? pending.quantity : null,
          unrealizedPnl: pos ? (pos.entryPrice - price) * pos.quantity : null
        };
      });

    store.upsertTrader({
      id: this.id,
      symbol: this.symbol,
      traderType: this.traderType,
      lastPrice: price,
      startPrice: this.startPrice,
      highestPrice: this.highestPrice,
      lowestPrice: this.lowestPrice,
      priceChangePercent: changePercent,
      destroyPercent,
      destroyProgress: Math.min(100, (Math.abs(changePercent) / destroyPercent) * 100),
      openPositions: this.positions.size,
      pendingOrders: this.pendingEntriesById.size,
      totalLevels: this.levels.size,
      realizedPnl: this.realizedPnl,
      unrealizedPnl: this._calcUnrealizedPnl(price),
      feesPaid: this.feesPaid,
      createdAt: this.createdAt,
      leverage: Number(config.leverage) || 10,
      spacingPercent: this._getSpacingPercent(),
      maxFilledLevels: this._getMaxFilledLevels(),
      stopLossPercent: this._getStopLossPercent(),
      levels: levelsList,
      tradeHistory: this.tradeHistory,
      status: this.active ? "ACTIVE" : "STOPPED"
    });
  }
}

module.exports = GridTrader;
