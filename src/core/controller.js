const PerpetualTrader = require("./perpetualTrader");
const { log } = require("../utils/logger");
const config = require("../utils/config");
const store = require("../state/store");

class Controller {
  constructor({ api, scanner }) {
    this.api = api;
    this.scanner = scanner;
    this.traders = new Map();
    this.leverageSet = new Map(); // symbol -> leverage value
    this.failedSymbols = new Map(); // symbol -> { count, until }
    this._scanning = false;
    this._lastRotation = 0;
  }

  async start() {
    if (config.mode === "live") {
      await this.api.startUserDataStream();
      await this._cleanupStaleOrders();
    }
    await this._refreshMarketStreams();
    await this._syncAccount();
    this._startAccountSync();
    await this._launchLoop();
  }

  async _cleanupStaleOrders() {
    try {
      const openOrders = await this.api.getOpenOrders();
      const symbols = [...new Set(openOrders.map((o) => o.symbol))];
      for (const symbol of symbols) {
        log("CONTROLLER", `Cleanup: cancelling stale orders for ${symbol}`);
        await this.api.cancelAllOpenOrders(symbol);
      }
      if (symbols.length > 0) {
        log("CONTROLLER", `Startup cleanup: cancelled orders for ${symbols.length} symbol(s)`);
      }
    } catch (err) {
      log("CONTROLLER", `Startup cleanup error: ${err.message}`);
    }
  }

  _startAccountSync() {
    setInterval(async () => {
      try {
        await this._syncAccount();
      } catch (err) {
        log("CONTROLLER", `Account sync error: ${err.message}`);
        store.setMarketStatus({ api: "error" });
      }
    }, 10000);
  }

  async _launchLoop() {
    await this._scanAndLaunch();
    setInterval(async () => {
      try {
        await this._scanAndLaunch();
      } catch (err) {
        log("CONTROLLER", `Scan error: ${err.message}`);
      }
    }, config.scannerIntervalMs);

    // Separate rotation loop — only rotates out stale traders on a longer interval
    setInterval(async () => {
      try {
        await this._rotateTraders();
      } catch (err) {
        log("CONTROLLER", `Rotation error: ${err.message}`);
      }
    }, config.rotationIntervalMs);
  }

  async _scanAndLaunch() {
    if (this._scanning) return;
    this._scanning = true;
    try {
      await this._doScanAndLaunch();
    } finally {
      this._scanning = false;
    }
  }

  async _doScanAndLaunch() {
    const candidates = await this.scanner.scan();

    // ── Only fill empty slots (rotation is handled separately on a longer timer) ──

    const currentEquity = store.getStatus().equity;
    if (currentEquity <= 0) {
      log("CONTROLLER", `Equity is $${currentEquity.toFixed(2)} — skipping new launches`);
      await this._refreshMarketStreams();
      return;
    }

    for (const symbol of candidates) {
      if (this.traders.size >= config.maxTraders) break;
      if (this.traders.has(symbol)) continue;

      // Prevent duplicate: check if any existing trader already trades this symbol
      const alreadyTrading = [...this.traders.values()].some(t => t.symbol === symbol);
      if (alreadyTrading) {
        log("CONTROLLER", `Skipping ${symbol} — duplicate trader detected`);
        continue;
      }

      // Skip symbols that recently failed
      const failure = this.failedSymbols.get(symbol);
      if (failure && Date.now() < failure.until) continue;
      if (failure) this.failedSymbols.delete(symbol);

      // Get max leverage for the equity-based notional
      let leverage = Number(config.leverage) || 20;
      try {
        const equityFraction = Number(config.equityFraction) || 0.01;
        const equityForNotional = store.getStatus().equity || Number(config.startingBalanceUSDT) || 100;
        const baseNotional = equityFraction * equityForNotional;
        const notional = baseNotional * leverage;

        const maxLev = await this.api.getMaxLeverage(symbol, notional);
        leverage = maxLev;

        // Recalculate with actual leverage and verify
        const actualNotional = baseNotional * leverage;
        const verifiedLev = await this.api.getMaxLeverage(symbol, actualNotional);
        leverage = Math.min(leverage, verifiedLev);

        await this.api.setLeverage(symbol, leverage);
        this.leverageSet.set(symbol, leverage);
        log("CONTROLLER", `Leverage set to ${leverage}x for ${symbol} (equity-based notional $${actualNotional.toFixed(2)})`);
      } catch (err) {
        log("CONTROLLER", `Leverage setup failed for ${symbol}: ${err.message}`);
        continue;
      }

      store.setTraderType("PERPETUAL");

      const trader = new PerpetualTrader({
        symbol,
        api: this.api,
        onDestroy: (sym, pnl) => this._destroy(sym, pnl),
        leverage
      });

      this.traders.set(symbol, trader);
      try {
        await trader.start();
        log("CONTROLLER", `Launched PERPETUAL trader for ${symbol} at ${leverage}x`);
      } catch (err) {
        log("CONTROLLER", `Trader ${symbol} failed to start: ${err.message}`);
        this.traders.delete(symbol);

        const prev = this.failedSymbols.get(symbol) || { count: 0 };
        const count = prev.count + 1;
        const cooldown = count >= 3 ? 120 : count >= 2 ? 30 : 10;
        this.failedSymbols.set(symbol, { count, until: Date.now() + cooldown * 60 * 1000 });
        log("CONTROLLER", `${symbol} blacklisted for ${cooldown}m (fail #${count})`);

        try {
          await trader.destroy("start-failed", { closePositions: true });
        } catch (_) {}
      }
    }

    await this._refreshMarketStreams();
  }

  /**
   * Rotate out traders whose symbols are no longer in the top N gainers.
   * Runs on a separate, longer interval (rotationIntervalMs, default 1 hour)
   * to avoid constant churn from fast-moving leaderboards.
   */
  async _rotateTraders() {
    if (this._scanning) return;
    this._scanning = true;
    try {
      const candidates = await this.scanner.scan();
      const topN = new Set(candidates);

      const toDestroy = [];
      for (const [symbol] of this.traders) {
        if (!topN.has(symbol)) {
          toDestroy.push(symbol);
        }
      }

      if (toDestroy.length === 0) {
        log("CONTROLLER", `Rotation check: all ${this.traders.size} traders still in top ${config.maxTraders}`);
      }

      for (const symbol of toDestroy) {
        log("CONTROLLER", `${symbol} dropped out of top ${config.maxTraders} gainers — rotating out`);
        const trader = this.traders.get(symbol);
        if (trader) {
          try {
            await trader.destroy("rotation", { closePositions: true });
          } catch (err) {
            log("CONTROLLER", `Error destroying ${symbol} during rotation: ${err.message}`);
            this.traders.delete(symbol);
          }
        }
      }

      if (toDestroy.length > 0) {
        await this._refreshMarketStreams();
      }

      this._lastRotation = Date.now();
    } finally {
      this._scanning = false;
    }
  }

  async _syncAccount() {
    let balance = await this.api.getBalance();
    if (config.mode === "test") {
      const perf = store.getPerformance();
      balance = Number(config.startingBalanceUSDT) + Number(perf.netProfit || 0);
    }
    store.setMarketStatus({ api: "connected" });
    store.setBalance(balance);

    const traders = store.getTraders();
    const unrealized = traders.reduce((sum, t) => sum + (t.unrealizedPnl || 0), 0);
    store.setEquity(balance + unrealized);
  }

  async _refreshMarketStreams() {
    const symbols = [...this.traders.keys()];
    await this.api.updateSymbols(symbols);
  }

  async _destroy(symbol, pnl) {
    if (!this.traders.has(symbol)) return;
    const trader = this.traders.get(symbol);
    this.traders.delete(symbol);

    // Record trader result for the dashboard
    if (trader) {
      store.recordTraderResult({
        totalTrades: trader.totalTrades || 0,
        wins: trader.wins || 0,
        losses: trader.losses || 0,
        pnl: trader.realizedPnl || 0
      });
    }

    if (typeof pnl === "number") {
      const label = pnl >= 0 ? "profit" : "loss";
      log("CONTROLLER", `Trader ${symbol} closed with ${label} ($${pnl.toFixed(2)})`);
    }

    log("CONTROLLER", `Trader ${symbol} destroyed`);
    await this._refreshMarketStreams();
  }

  async destroyTrader(symbol) {
    const trader = this.traders.get(symbol);
    if (!trader) return false;
    await trader.destroy("manual", { closePositions: true });
    return true;
  }
}

module.exports = Controller;
