const config = require("../utils/config");
const { log } = require("../utils/logger");
const store = require("../state/store");

function formatNumber(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return Number(value).toFixed(digits);
}

/**
 * MartingaleTrader – single-position martingale with alternating directions.
 *
 * Flow:
 * 1. Places a MARKET order in a starting direction (SHORT by default).
 * 2. Monitors price via mark-price / book-ticker.
 * 3. If the position hits take-profit → close at market, destroy trader (win).
 * 4. If the position hits stop-loss → close at market, open a new position
 *    in the OPPOSITE direction with DOUBLE the notional. This is the next "round".
 * 5. If maxRounds is reached and the last round loses → destroy trader (loss).
 *
 * All orders are market orders. TP/SL are soft (price-based), not exchange orders.
 * Fees are tracked accurately using Binance taker fee rate from config.
 */
class MartingaleTrader {
  constructor({ symbol, api, onDestroy, leverage }) {
    this.id = `${symbol}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    this.symbol = symbol;
    this.api = api;
    this.onDestroy = onDestroy;
    this.traderType = "MARTINGALE";

    this.leverage = leverage || Number(config.leverage) || 10;
    this.active = true;
    this.createdAt = new Date().toISOString();
    this.tradeHistory = [];
    this.realizedPnl = 0;
    this.feesPaid = 0;
    this.lastPrice = null;

    // Round tracking
    this.currentRound = 0;
    this.maxRounds = Number(config.maxRounds) || 5;
    this.baseNotional = Number(config.positionNotionalUSDT) || 10;

    // Current position (at most one at a time)
    this.position = null;        // { direction, entryPrice, quantity, notional, tpPrice, slPrice }
    this.startDirection = "SHORT"; // first round direction

    // Guard flags
    this._processing = false;

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
    // notional is the leveraged position size
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

    // Enter round 1
    await this._enterRound(this.startDirection, this.baseNotional * this.leverage);

    log(`TRADER ${this.symbol}`, `Initialized (MARTINGALE) leverage=${this.leverage}x base=$${this.baseNotional} maxRounds=${this.maxRounds}`);
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
      rounds: this.currentRound,
      maxRounds: this.maxRounds,
      tradeHistory: this.tradeHistory
    });

    log(`TRADER ${this.symbol}`, `Destroyed (${reason}) after ${this.currentRound} rounds, PnL $${formatNumber(this.realizedPnl)}`);
    if (this.onDestroy) this.onDestroy(this.symbol, this.realizedPnl);
  }

  // ── Round management ────────────────────────────────────────────

  /**
   * Enter a new round: place a market order.
   * @param {string} direction - "LONG" or "SHORT"
   * @param {number} notional  - leveraged position size in USDT
   */
  async _enterRound(direction, notional) {
    this.currentRound++;

    const side = direction === "LONG" ? "BUY" : "SELL";
    const positionSide = direction === "LONG" ? "LONG" : "SHORT";
    const price = this.lastPrice;
    const qty = this._calcQuantity(price, notional);

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
      notional,
      tpPrice,
      slPrice,
      round: this.currentRound,
      entryFee
    };

    log(
      `TRADER ${this.symbol}`,
      `Round ${this.currentRound}/${this.maxRounds}: ${direction} qty=${qty} entry=${formatNumber(fillPrice, 6)} ` +
      `notional=$${formatNumber(notional)} TP=${formatNumber(tpPrice, 6)} SL=${formatNumber(slPrice, 6)}`
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

    const pos = this.position;
    const isLong = pos.direction === "LONG";

    // Check take-profit
    const tpHit = isLong ? price >= pos.tpPrice : price <= pos.tpPrice;
    if (tpHit) {
      this._processing = true;
      await this._closePosition("take-profit");
      log(`TRADER ${this.symbol}`, `Take profit hit at round ${this.currentRound} — destroying (win)`);
      await this.destroy("take-profit", { closePositions: false });
      return;
    }

    // Check stop-loss
    const slHit = isLong ? price <= pos.slPrice : price >= pos.slPrice;
    if (slHit) {
      this._processing = true;
      await this._closePosition("stop-loss");

      // Check if we've exhausted all rounds
      if (this.currentRound >= this.maxRounds) {
        log(`TRADER ${this.symbol}`, `Max rounds (${this.maxRounds}) reached — destroying (loss)`);
        await this.destroy("max-rounds", { closePositions: false });
        return;
      }

      // Enter next round: always SHORT, double notional
      const nextDirection = "SHORT";
      const nextNotional = pos.notional * 2;
      await this._enterRound(nextDirection, nextNotional);
      this._processing = false;
    }
  }

  // ── Position closing ────────────────────────────────────────────

  async _closePosition(reason) {
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

    const exitPrice = Number(result.price) || this.lastPrice;

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
      round: pos.round,
      direction: pos.direction,
      entry: pos.entryPrice,
      exit: exitPrice,
      quantity: pos.quantity,
      notional: pos.notional,
      grossPnl,
      fees: totalFees,
      netPnl,
      reason
    });

    store.recordTrade({ pnl: grossPnl, fees: totalFees });

    log(
      `TRADER ${this.symbol}`,
      `Closed ${pos.direction} R${pos.round} @ ${formatNumber(exitPrice, 6)} ` +
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
      currentRound: this.currentRound,
      maxRounds: this.maxRounds,
      baseNotional: this.baseNotional,
      currentNotional: this.position ? this.position.notional : null,
      position: this.position ? {
        direction: this.position.direction,
        entryPrice: this.position.entryPrice,
        quantity: this.position.quantity,
        notional: this.position.notional,
        tpPrice: this.position.tpPrice,
        slPrice: this.position.slPrice,
        round: this.position.round
      } : null,
      tradeHistory: this.tradeHistory,
      status: this.active ? "ACTIVE" : "STOPPED"
    });
  }
}

module.exports = MartingaleTrader;
