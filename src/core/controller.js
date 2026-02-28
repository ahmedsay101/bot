const MartingaleTrader = require("./martingaleTrader");
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
    if (this.traders.size >= config.maxTraders) return;

    const candidates = await this.scanner.scan();

    for (const symbol of candidates) {
      if (this.traders.size >= config.maxTraders) break;
      if (this.traders.has(symbol)) continue;

      // Skip symbols that recently failed
      const failure = this.failedSymbols.get(symbol);
      if (failure && Date.now() < failure.until) continue;
      if (failure) this.failedSymbols.delete(symbol);

      // Get max leverage for the worst-case notional (last round doubles)
      // Notional at round N = base * leverage * 2^(N-1)
      // We need leverage that's valid for the largest round, but leverage itself
      // affects the notional. Use base notional without leverage first to find a
      // bracket, then compute the leveraged notional and re-check.
      let leverage = Number(config.leverage) || 20;
      try {
        const baseNotional = Number(config.positionNotionalUSDT) || 10;
        const maxRounds = Number(config.maxRounds) || 5;
        const worstCaseMultiplier = Math.pow(2, maxRounds - 1);

        // First pass: get max leverage for rough worst-case notional estimate
        const roughNotional = baseNotional * worstCaseMultiplier * leverage;
        const maxLev = await this.api.getMaxLeverage(symbol, roughNotional);
        leverage = maxLev;

        // Second pass: recalculate with actual leverage and verify
        const actualNotional = baseNotional * worstCaseMultiplier * leverage;
        const verifiedLev = await this.api.getMaxLeverage(symbol, actualNotional);
        leverage = Math.min(leverage, verifiedLev);

        await this.api.setLeverage(symbol, leverage);
        this.leverageSet.set(symbol, leverage);
        log("CONTROLLER", `Leverage set to ${leverage}x for ${symbol} (worst-case notional $${(baseNotional * worstCaseMultiplier * leverage).toFixed(0)})`);
      } catch (err) {
        log("CONTROLLER", `Leverage setup failed for ${symbol}: ${err.message}`);
        continue;
      }

      store.setTraderType("MARTINGALE");

      const trader = new MartingaleTrader({
        symbol,
        api: this.api,
        onDestroy: (sym, pnl) => this._destroy(sym, pnl),
        leverage
      });

      this.traders.set(symbol, trader);
      try {
        await trader.start();
        log("CONTROLLER", `Launched MARTINGALE trader for ${symbol} at ${leverage}x`);
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

    // Record round stats for the dashboard
    if (trader && trader.tradeHistory) {
      const lastTrade = trader.tradeHistory[trader.tradeHistory.length - 1];
      if (lastTrade) {
        const wonAtRound = lastTrade.reason === "take-profit" ? lastTrade.round : null;
        store.recordTraderResult({
          rounds: trader.currentRound,
          maxRounds: trader.maxRounds,
          wonAtRound,
          pnl: trader.realizedPnl
        });
      }
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
