const GridTrader = require("./gridTrader");
const { log } = require("../utils/logger");
const config = require("../utils/config");
const store = require("../state/store");

class Controller {
  constructor({ api, scanner }) {
    this.api = api;
    this.scanner = scanner;
    this.traders = new Map();
    this.leverageSet = new Set();
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
      const symbols = [...new Set(openOrders.map(o => o.symbol))];
      for (const symbol of symbols) {
        log("CONTROLLER", `Cleanup: cancelling ${openOrders.filter(o => o.symbol === symbol).length} stale orders for ${symbol}`);
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

      if (config.mode === "live" && !this.leverageSet.has(symbol)) {
        try {
          await this.api.setLeverage(symbol, config.leverage);
          this.leverageSet.add(symbol);
          log("CONTROLLER", `Leverage set ${config.leverage}x for ${symbol}`);
        } catch (err) {
          log("CONTROLLER", `Leverage set failed for ${symbol}: ${err.message}`);
          continue;
        }
      }

      const trader = new GridTrader({
        symbol,
        api: this.api,
        onDestroy: (sym) => this._onTraderDestroyed(sym)
      });
      this.traders.set(symbol, trader);
      try {
        await trader.start();
        log("CONTROLLER", `Launched GRID trader for ${symbol}`);
      } catch (err) {
        log("CONTROLLER", `Trader ${symbol} failed to start: ${err.message}`);
        this.traders.delete(symbol);
        try { await trader.destroy("start-failed"); } catch (_) {}
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
    const unrealized = traders.reduce((sum, trader) => sum + (trader.unrealizedPnl || 0), 0);
    store.setEquity(balance + unrealized);
  }

  async _refreshMarketStreams() {
    const symbols = [...this.traders.keys()];
    await this.api.updateSymbols(symbols);
  }

  async _onTraderDestroyed(symbol) {
    if (!this.traders.has(symbol)) return;
    this.traders.delete(symbol);
    log("CONTROLLER", `Trader ${symbol} destroyed`);
    await this._refreshMarketStreams();
  }

  async destroyTrader(symbol) {
    const trader = this.traders.get(symbol);
    if (!trader) return false;
    await trader.destroy("manual");
    return true;
  }
}

module.exports = Controller;
