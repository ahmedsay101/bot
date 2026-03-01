const config = require("../utils/config");
const { log } = require("../utils/logger");
const store = require("../state/store");

function formatNumber(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return Number(value).toFixed(digits);
}

/**
 * PerpetualTrader – runs indefinitely, flipping direction only on stop-loss.
 *
 * Flow:
 * 1. Places a MARKET order in a starting direction (SHORT by default).
 * 2. Monitors price via mark-price / book-ticker.
 * 3. If the position hits take-profit → close at market, open a NEW position
 *    in the SAME direction with the same notional.
 * 4. If the position hits stop-loss → close at market, open a NEW position
 *    in the OPPOSITE direction with the same notional.
 * 5. Never auto-destroys. Only manual destruction stops the trader.
 *
 * All orders are market orders. TP/SL are soft (price-based), not exchange orders.
 * Fees are tracked accurately using Binance taker fee rate from config.
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
    const currentEquity = store.getStatus().equity || Number(config.startingBalanceUSDT) || 100;
    this.equityAtCreation = currentEquity;
    this.equityFraction = equityFraction;
    this.baseNotional = equityFraction * currentEquity;
    this.notional = this.baseNotional * this.leverage;

    log(`TRADER ${this.symbol}`, `Equity calculation: fraction=${equityFraction}, equity=${currentEquity}, baseNotional=${this.baseNotional}, notional=${this.notional}`);

    // Current position (at most one at a time)
    this.position = null;
    this.startDirection = "SHORT";

    // Statistics
    this.totalTrades = 0;
    this.wins = 0;         // TP hits
    this.losses = 0;       // SL hits
    this.currentStreak = 0;     // positive = win streak, negative = loss streak
    this.longestWinStreak = 0;
    this.longestLossStreak = 0;
    this.consecutiveSameDir = 0; // how many TPs in a row (same direction)

    // Guard flags
    this._processing = false;
    this._lastTradeTime = 0;
    this._minTradeIntervalMs = 2000; // Minimum 2 seconds between trades

    this._onMarkPrice = this._onMarkPrice.bind(this);
    this._onBookTicker = this._onBookTicker.bind(this);
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

  _calcQuantity(price, notional) {
    if (notional <= 0 || price <= 0) return 0;
    const qty = notional / price;
    return Number(qty.toFixed(4));
  }

  _calcTpSlPrices(entryPrice, direction) {
    const tpPct = this._getTakeProfitPercent();
    const slPct = this._getStopLossPercent();

    let tpPrice, slPrice;
    if (direction === "LONG") {
      tpPrice = entryPrice * (1 + tpPct / 100);
      slPrice = entryPrice * (1 - slPct / 100);
    } else {
      tpPrice = entryPrice * (1 - tpPct / 100);
      slPrice = entryPrice * (1 + slPct / 100);
    }
    return { tpPrice, slPrice };
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  async start() {
    this.lastPrice = await this.api.getMarkPrice(this.symbol);

    this.api.on("markPrice", this._onMarkPrice);
    this.api.on("bookTicker", this._onBookTicker);

    // Open the first position
    await this._openPosition(this.startDirection);

    log(`TRADER ${this.symbol}`, `Initialized (PERPETUAL) leverage=${this.leverage}x notional=$${formatNumber(this.notional)}`);
    this._updateStore();
  }

  async destroy(reason, options = {}) {
    if (!this.active) return;
    const { closePositions = true } = options;
    this.active = false;

    this.api.off("markPrice", this._onMarkPrice);
    this.api.off("bookTicker", this._onBookTicker);

    if (closePositions && this.position) {
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

    log(`TRADER ${this.symbol}`, `Destroyed (${reason}) after ${this.totalTrades} trades, PnL $${formatNumber(this.realizedPnl)}`);
    if (this.onDestroy) this.onDestroy(this.symbol, this.realizedPnl);
  }

  // ── Position management ─────────────────────────────────────────

  /**
   * Open a new position with the given direction.
   * @param {string} direction - "LONG" or "SHORT"
   */
  async _openPosition(direction) {
    const side = direction === "LONG" ? "BUY" : "SELL";
    const positionSide = direction === "LONG" ? "LONG" : "SHORT";
    const price = this.lastPrice;
    const qty = this._calcQuantity(price, this.notional);

    const result = await this.api.placeMarketOrder({
      symbol: this.symbol,
      side,
      quantity: qty,
      positionSide
    });

    const fillPrice = Number(result.price) || price;
    const { tpPrice, slPrice } = this._calcTpSlPrices(fillPrice, direction);

    // Entry fee
    const entryFee = fillPrice * qty * this._getFeeRate();
    this.feesPaid += entryFee;

    this.position = {
      direction,
      entryPrice: fillPrice,
      quantity: qty,
      notional: this.notional,
      tpPrice,
      slPrice,
      tradeNumber: this.totalTrades + 1,
      entryFee
    };

    log(
      `TRADER ${this.symbol}`,
      `Trade #${this.totalTrades + 1}: ${direction} qty=${qty} entry=${formatNumber(fillPrice, 6)} ` +
      `notional=$${formatNumber(this.notional)} TP=${formatNumber(tpPrice, 6)} SL=${formatNumber(slPrice, 6)}`
    );

    this._updateStore();
  }

  // ── Price monitoring ────────────────────────────────────────────

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

  // ── Position check (TP / SL) ───────────────────────────────────

  async _checkPosition(price) {
    if (!this.position || this._processing) return;

    // Rate-limit: prevent rapid cycling
    const now = Date.now();
    if (now - this._lastTradeTime < this._minTradeIntervalMs) return;

    const pos = this.position;
    const isLong = pos.direction === "LONG";

    // Check take-profit
    const tpHit = isLong ? price >= pos.tpPrice : price <= pos.tpPrice;
    if (tpHit) {
      this._processing = true;
      this._lastTradeTime = now;

      // Close at the TP price (simulates a limit TP order)
      await this._closePosition("take-profit", pos.tpPrice);

      // Update statistics
      this.wins++;
      this.totalTrades++;
      this.consecutiveSameDir++;

      // Update streak
      if (this.currentStreak >= 0) {
        this.currentStreak++;
      } else {
        this.currentStreak = 1;
      }
      if (this.currentStreak > this.longestWinStreak) {
        this.longestWinStreak = this.currentStreak;
      }

      log(`TRADER ${this.symbol}`, `Take profit hit — continuing ${pos.direction} (win #${this.wins})`);

      // TP → open same direction
      await this._openPosition(pos.direction);
      this._processing = false;
      return;
    }

    // Check stop-loss
    const slHit = isLong ? price <= pos.slPrice : price >= pos.slPrice;
    if (slHit) {
      this._processing = true;
      this._lastTradeTime = now;

      // Close at the SL price (simulates a stop-loss order)
      await this._closePosition("stop-loss", pos.slPrice);

      // Update statistics
      this.losses++;
      this.totalTrades++;
      this.consecutiveSameDir = 0;

      // Update streak
      if (this.currentStreak <= 0) {
        this.currentStreak--;
      } else {
        this.currentStreak = -1;
      }
      if (Math.abs(this.currentStreak) > this.longestLossStreak) {
        this.longestLossStreak = Math.abs(this.currentStreak);
      }

      // Check equity before opening next position
      const currentEquity = store.getStatus().equity;
      if (currentEquity <= 0) {
        log(`TRADER ${this.symbol}`, `HALTED — equity is $${formatNumber(currentEquity)}, refusing to open new trade`);
        this._processing = false;
        return;
      }

      // SL → open opposite direction
      const nextDirection = pos.direction === "LONG" ? "SHORT" : "LONG";
      log(`TRADER ${this.symbol}`, `Stop loss hit — flipping to ${nextDirection} (loss #${this.losses})`);

      await this._openPosition(nextDirection);
      this._processing = false;
    }
  }

  // ── Position closing ────────────────────────────────────────────

  /**
   * Close the current position.
   * @param {string} reason - "take-profit", "stop-loss", or "destroy"
   * @param {number|null} targetPrice - For TP/SL, the exact trigger price to use as exit
   */
  async _closePosition(reason, targetPrice = null) {
    const pos = this.position;
    if (!pos) return;

    const side = pos.direction === "LONG" ? "SELL" : "BUY";
    const positionSide = pos.direction === "LONG" ? "LONG" : "SHORT";

    const result = await this.api.placeMarketOrder({
      symbol: this.symbol,
      side,
      quantity: pos.quantity,
      positionSide
    });

    // Use the TP/SL target price for accurate simulation;
    // only fall back to market fill for manual destroy
    const exitPrice = targetPrice || Number(result.price) || this.lastPrice;

    // PnL calculation
    const direction = pos.direction === "LONG" ? 1 : -1;
    const grossPnl = (exitPrice - pos.entryPrice) * pos.quantity * direction;

    // Exit fee
    const exitFee = exitPrice * pos.quantity * this._getFeeRate();
    this.feesPaid += exitFee;

    const totalFees = pos.entryFee + exitFee;
    const netPnl = grossPnl - totalFees;

    this.realizedPnl += netPnl;

    this.tradeHistory.push({
      tradeNumber: pos.tradeNumber,
      direction: pos.direction,
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
      `Closed ${pos.direction} #${pos.tradeNumber} @ ${formatNumber(exitPrice, 6)} ` +
      `gross=${formatNumber(grossPnl)} fees=${formatNumber(totalFees)} net=${formatNumber(netPnl)} reason=${reason}`
    );

    this.position = null;
  }

  // ── Unrealized PnL ─────────────────────────────────────────────

  _calcUnrealizedPnl(price) {
    if (!this.position) return 0;
    const pos = this.position;
    const direction = pos.direction === "LONG" ? 1 : -1;
    const grossPnl = (price - pos.entryPrice) * pos.quantity * direction;
    // Deduct estimated exit fee for accurate unrealized
    const exitFee = price * pos.quantity * this._getFeeRate();
    return grossPnl - pos.entryFee - exitFee;
  }

  // ── Store sync ──────────────────────────────────────────────────

  _updateStore() {
    if (!this.active) return;
    const price = this.lastPrice || 0;

    store.upsertTrader({
      id: this.id,
      symbol: this.symbol,
      traderType: this.traderType,
      lastPrice: price,
      leverage: this.leverage,
      openPositions: this.position ? 1 : 0,
      pendingOrders: 0,
      realizedPnl: this.realizedPnl,
      unrealizedPnl: this._calcUnrealizedPnl(price),
      feesPaid: this.feesPaid,
      createdAt: this.createdAt,
      totalTrades: this.totalTrades,
      wins: this.wins,
      losses: this.losses,
      winRate: this.totalTrades > 0 ? (this.wins / this.totalTrades) * 100 : 0,
      currentStreak: this.currentStreak,
      longestWinStreak: this.longestWinStreak,
      longestLossStreak: this.longestLossStreak,
      consecutiveSameDir: this.consecutiveSameDir,
      equityAtCreation: this.equityAtCreation,
      equityFraction: this.equityFraction,
      baseNotional: this.baseNotional,
      notional: this.notional,
      position: this.position ? {
        direction: this.position.direction,
        entryPrice: this.position.entryPrice,
        quantity: this.position.quantity,
        notional: this.position.notional,
        tpPrice: this.position.tpPrice,
        slPrice: this.position.slPrice,
        tradeNumber: this.position.tradeNumber
      } : null,
      tradeHistory: this.tradeHistory,
      status: this.active ? "ACTIVE" : "STOPPED"
    });
  }
}

module.exports = PerpetualTrader;
