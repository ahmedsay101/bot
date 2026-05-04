const config = require("../utils/config");
const { log } = require("../utils/logger");
const store = require("../state/store");

function fmt(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return Number(value).toFixed(digits);
}

/**
 * DCATrader — short-with-hedge strategy.
 *
 *   1. On start: open a market SHORT. TP = entry × (1 - takeProfitPercent / 100).
 *   2. While the SHORT is losing >= hedgeTriggerPercent and there is no hedge,
 *      open a market LONG hedge of the same quantity. The hedge has no TP
 *      and a stop-loss at entry × (1 - hedgeStopLossPercent / 100).
 *   3. If the hedge SL is hit, close the hedge only. The trader continues to
 *      run; another hedge will be re-opened on the next tick if the short is
 *      still losing >= hedgeTriggerPercent.
 *   4. The trader is destroyed only when the SHORT hits TP, or via manual
 *      destroy through the API.
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

    // Sizing — split equity across traders, then split each trader's slice
    // across the two sides (main short + hedge), then apply leverage:
    //   perTrader  = equity / maxTraders          (e.g. 300 / 3 = 100)
    //   perSide    = perTrader / 2                (e.g. 100 / 2 = 50  → margin)
    //   notional   = perSide * leverage           (e.g. 50  * 4 = 200)
    // Same notional is used for the LONG hedge so both sides have equal exposure.
    this.leverage = Number(config.leverage) || 2;
    const maxTraders = Math.max(1, Number(config.maxTraders) || 1);
    const balance = Number(equity) || Number(config.startingBalanceUSDT);
    this.perTraderEquity = balance / maxTraders;
    this.margin = this.perTraderEquity / 2;
    this.notional = this.margin * this.leverage;

    // Strategy parameters (configurable)
    this.takeProfitPercent = Number(config.takeProfitPercent) || 10;
    this.hedgeTriggerPercent = Number(config.hedgeTriggerPercent) || 5;
    this.hedgeStopLossPercent = Number(config.hedgeStopLossPercent) || 5;
    this.maxHedgesPerTrader = Number(config.maxHedgesPerTrader) || 0; // 0 = unlimited

    // Serialize tick handling so concurrent markPrice + bookTicker events
    // can't double-open or double-close a hedge while we await order calls.
    this._tickBusy = false;

    // Main short state
    this.entryPrice = 0;
    this.quantity = 0;
    this.tpPrice = 0;

    // Hedge state (null when no hedge is open)
    this.hedge = null; // { entryPrice, quantity, slPrice, openedAt }
    this.hedgeCount = 0;
    this.hedgeRealizedPnl = 0;

    // PnL & accounting
    this.realizedPnl = 0;
    this.feesPaid = 0;
    this.unrealizedPnl = 0;
    this.highestNetProfit = 0;
    this.totalTrades = 0;
    this.tradeHistory = [];

    this._onMarkPrice = this._onMarkPrice.bind(this);
    this._onBookTicker = this._onBookTicker.bind(this);
  }

  get _feeRate() { return config.feeRate != null ? Number(config.feeRate) : 0.0004; }

  // ── Lifecycle ───────────────────────────────────────────────

  async start() {
    this.startPrice = await this.api.getMarkPrice(this.symbol);
    this.lastPrice = this.startPrice;

    const rawQty = Number((this.notional / this.startPrice).toFixed(4));

    const result = await this.api.placeMarketOrder({
      symbol: this.symbol,
      side: "SELL",
      quantity: rawQty,
      positionSide: "SHORT"
    });

    this.entryPrice = Number(result.price) || this.startPrice;
    this.quantity = Number(result.quantity) || rawQty;
    this.feesPaid += this.entryPrice * this.quantity * this._feeRate;

    this.tpPrice = this.entryPrice * (1 - this.takeProfitPercent / 100);

    this.api.on("markPrice", this._onMarkPrice);
    this.api.on("bookTicker", this._onBookTicker);

    log(
      `DCA ${this.symbol}`,
      `SHORT @ ${fmt(this.entryPrice, 6)} qty=${this.quantity} ` +
      `notional=$${fmt(this.notional)} TP=${fmt(this.tpPrice, 6)} ` +
      `(hedge trigger -${this.hedgeTriggerPercent}%, hedge SL -${this.hedgeStopLossPercent}%)`
    );
    this._updateStore();
  }

  // ── Price feeds ─────────────────────────────────────────────

  async _onMarkPrice({ symbol, price }) {
    if (!this.active || symbol !== this.symbol) return;
    this.lastPrice = price;
    await this._tick(price);
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
    await this._tick(price);
  }

  // ── Tick / strategy ─────────────────────────────────────────

  async _tick(price) {
    if (!this.active || this._tickBusy) return;
    this._tickBusy = true;
    try {
      // 1) Main TP — destroys the trader.
      if (price <= this.tpPrice) {
        log(`DCA ${this.symbol}`, `TP hit @ ${fmt(price, 6)} <= ${fmt(this.tpPrice, 6)}`);
        await this.destroy("take-profit");
        return;
      }

      // 2) Hedge SL — close hedge only.
      if (this.hedge && price <= this.hedge.slPrice) {
        log(
          `DCA ${this.symbol}`,
          `Hedge SL hit @ ${fmt(price, 6)} <= ${fmt(this.hedge.slPrice, 6)}`
        );
        await this._closeHedge(price, "stop-loss");
      }

      // 3) Hedge cap — if we've blown through the configured cycle budget,
      //    force-close the trader instead of opening yet another hedge.
      if (
        this.maxHedgesPerTrader > 0 &&
        this.hedgeCount >= this.maxHedgesPerTrader &&
        !this.hedge
      ) {
        log(
          `DCA ${this.symbol}`,
          `Max hedges (${this.maxHedgesPerTrader}) reached — force closing`
        );
        await this.destroy("max-hedges");
        return;
      }

      // 4) Open hedge if short is losing enough and no hedge is open.
      if (!this.hedge && this.entryPrice > 0) {
        const lossPct = ((price - this.entryPrice) / this.entryPrice) * 100;
        if (lossPct >= this.hedgeTriggerPercent) {
          await this._openHedge(price);
        }
      }

      this._trackHighestProfit();
      this._updateStore();
    } finally {
      this._tickBusy = false;
    }
  }

  // ── Hedge ───────────────────────────────────────────────────

  async _openHedge(price) {
    // Defensive double-check — _tick is locked, but be explicit so any
    // future caller can't accidentally open a second hedge.
    if (this.hedge) return;
    try {
      const result = await this.api.placeMarketOrder({
        symbol: this.symbol,
        side: "BUY",
        quantity: this.quantity,
        positionSide: "LONG"
      });

      const entryPrice = Number(result.price) || price;
      const qty = Number(result.quantity) || this.quantity;
      const slPrice = entryPrice * (1 - this.hedgeStopLossPercent / 100);
      const fee = entryPrice * qty * this._feeRate;
      this.feesPaid += fee;

      this.hedge = {
        entryPrice,
        quantity: qty,
        slPrice,
        openedAt: new Date().toISOString()
      };
      this.hedgeCount += 1;

      log(
        `DCA ${this.symbol}`,
        `HEDGE LONG @ ${fmt(entryPrice, 6)} qty=${qty} SL=${fmt(slPrice, 6)}`
      );
    } catch (err) {
      log(`DCA ${this.symbol}`, `Hedge open failed: ${err.message}`);
    }
  }

  async _closeHedge(price, reason) {
    if (!this.hedge) return 0;
    const hedge = this.hedge;
    this.hedge = null;

    const exitPrice = reason === "stop-loss" ? hedge.slPrice : price;
    const closeFee = exitPrice * hedge.quantity * this._feeRate;
    this.feesPaid += closeFee;

    // LONG hedge PnL = (exit - entry) * qty
    const grossPnl = (exitPrice - hedge.entryPrice) * hedge.quantity;
    this.hedgeRealizedPnl += grossPnl;

    try {
      await this.api.placeMarketOrder({
        symbol: this.symbol,
        side: "SELL",
        quantity: hedge.quantity,
        positionSide: "LONG"
      });
    } catch (err) {
      log(`DCA ${this.symbol}`, `Hedge close error: ${err.message}`);
    }

    this.tradeHistory.push({
      direction: "HEDGE_LONG",
      entry: hedge.entryPrice,
      exit: exitPrice,
      quantity: hedge.quantity,
      grossPnl,
      fees: closeFee,
      netPnl: grossPnl - closeFee,
      reason,
      closedAt: new Date().toISOString()
    });

    log(
      `DCA ${this.symbol}`,
      `Hedge closed (${reason}) @ ${fmt(exitPrice, 6)} PnL=${fmt(grossPnl, 4)}`
    );
    return grossPnl;
  }

  // ── Destroy ─────────────────────────────────────────────────

  async destroy(reason) {
    if (!this.active) return;
    this.active = false;

    this.api.off("markPrice", this._onMarkPrice);
    this.api.off("bookTicker", this._onBookTicker);

    const exitPriceSource = this.lastPrice || this.startPrice;
    let exitPrice = exitPriceSource;
    if (reason === "take-profit") exitPrice = this.tpPrice;

    // Close any open hedge first (use current market price for closing).
    let hedgePnl = 0;
    if (this.hedge) {
      hedgePnl = await this._closeHedge(exitPriceSource, "trader-closed");
    }

    // Close the main short.
    try {
      await this.api.cancelAllOpenOrders(this.symbol);
    } catch (_) { /* best-effort */ }

    try {
      await this.api.placeMarketOrder({
        symbol: this.symbol,
        side: "BUY",
        quantity: this.quantity,
        positionSide: "SHORT"
      });
    } catch (err) {
      log(`DCA ${this.symbol}`, `Short close error: ${err.message}`);
    }

    const closeFee = exitPrice * this.quantity * this._feeRate;
    this.feesPaid += closeFee;
    const shortGrossPnl = (this.entryPrice - exitPrice) * this.quantity;
    const totalGrossPnl = shortGrossPnl + this.hedgeRealizedPnl;
    this.realizedPnl = totalGrossPnl - this.feesPaid;
    this.totalTrades = 1 + this.hedgeCount;

    // Reconciliation: after the trader closes, both position buckets on the
    // exchange/simulator should be flat. Any residual qty means our internal
    // hedgeCount/hedgeRealizedPnl drifted from reality (race, missed fill,
    // exchange rejection, etc.) — surface it loudly instead of silently
    // reporting an impossible PnL.
    try {
      const [shortPos, longPos] = await Promise.all([
        this.api.getPosition(this.symbol, "SHORT"),
        this.api.getPosition(this.symbol, "LONG")
      ]);
      const shortQty = Math.abs(Number(shortPos?.qty) || 0);
      const longQty = Math.abs(Number(longPos?.qty) || 0);
      if (shortQty > 1e-8 || longQty > 1e-8) {
        log(
          `DCA ${this.symbol}`,
          `RECONCILE WARNING: residual position after close ` +
          `SHORT=${shortQty} LONG=${longQty} — internal PnL ($${fmt(this.realizedPnl, 4)}) ` +
          `may not match exchange. Investigate hedgeCount=${this.hedgeCount}.`
        );
      }
    } catch (err) {
      log(`DCA ${this.symbol}`, `Reconcile check failed: ${err.message}`);
    }

    this.tradeHistory.push({
      direction: "SHORT",
      entry: this.entryPrice,
      exit: exitPrice,
      quantity: this.quantity,
      grossPnl: shortGrossPnl,
      fees: closeFee,
      netPnl: shortGrossPnl - closeFee,
      reason,
      closedAt: new Date().toISOString()
    });

    store.recordTrade({ pnl: totalGrossPnl, fees: this.feesPaid });
    store.removeTrader(this.id, {
      id: this.id,
      symbol: this.symbol,
      changePercent: this.changePercent,
      realizedPnl: this.realizedPnl,
      feesPaid: this.feesPaid,
      totalTrades: this.totalTrades,
      hedgeCount: this.hedgeCount,
      hedgeRealizedPnl: this.hedgeRealizedPnl,
      highestNetProfit: this.highestNetProfit,
      createdAt: this.createdAt,
      closedAt: new Date().toISOString(),
      reason,
      startPrice: this.startPrice,
      endPrice: this.lastPrice,
      entryPrice: this.entryPrice
    });

    log(
      `DCA ${this.symbol}`,
      `Destroyed (${reason}) | Net PnL $${fmt(this.realizedPnl)} | ${this.hedgeCount} hedge(s)`
    );
    if (this.onDestroy) this.onDestroy(this.symbol, this.realizedPnl, reason);
    void hedgePnl; // already accumulated into hedgeRealizedPnl
  }

  // ── PnL helpers ─────────────────────────────────────────────

  _calcUnrealizedPnl(price) {
    const shortUpnl = (this.entryPrice - price) * this.quantity;
    const hedgeUpnl = this.hedge
      ? (price - this.hedge.entryPrice) * this.hedge.quantity
      : 0;
    return shortUpnl + hedgeUpnl + this.hedgeRealizedPnl;
  }

  _trackHighestProfit() {
    const price = this.lastPrice || this.startPrice || 0;
    const totalNet = this._calcUnrealizedPnl(price) - this.feesPaid;
    if (totalNet > this.highestNetProfit) this.highestNetProfit = totalNet;
  }

  // ── Store sync ──────────────────────────────────────────────

  _updateStore() {
    if (!this.active) return;
    const price = this.lastPrice || this.startPrice || 0;
    const unrealized = this._calcUnrealizedPnl(price);
    this.unrealizedPnl = unrealized;

    const lossPct = this.entryPrice > 0
      ? ((price - this.entryPrice) / this.entryPrice) * 100
      : 0;

    store.upsertTrader({
      id: this.id,
      symbol: this.symbol,
      traderType: "SHORT_WITH_HEDGE",
      lastPrice: price,
      startPrice: this.startPrice,
      entryPrice: this.entryPrice,
      leverage: this.leverage,
      notional: this.notional,
      margin: this.margin,
      takeProfitPercent: this.takeProfitPercent,
      hedgeTriggerPercent: this.hedgeTriggerPercent,
      hedgeStopLossPercent: this.hedgeStopLossPercent,
      quantity: this.quantity,
      tpPrice: this.tpPrice,
      lossPercent: lossPct,
      hedge: this.hedge
        ? {
            entryPrice: this.hedge.entryPrice,
            quantity: this.hedge.quantity,
            slPrice: this.hedge.slPrice,
            openedAt: this.hedge.openedAt
          }
        : null,
      hedgeCount: this.hedgeCount,
      hedgeRealizedPnl: this.hedgeRealizedPnl,
      totalTrades: this.totalTrades,
      realizedPnl: this.realizedPnl,
      unrealizedPnl: unrealized,
      feesPaid: this.feesPaid,
      highestNetProfit: this.highestNetProfit,
      tradeHistory: this.tradeHistory,
      createdAt: this.createdAt,
      status: this.active ? "ACTIVE" : "STOPPED"
    });
  }
}

module.exports = DCATrader;
