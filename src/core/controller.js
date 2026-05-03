const DCATrader = require("./dcaTrader");
const { log } = require("../utils/logger");
const config = require("../utils/config");
const store = require("../state/store");

/**
 * Controller — picks top gainers (>{minChange24hPercent}%), spawns up to
 * {maxTraders} short traders. A trader is destroyed only when its main
 * short hits TP, or via manual destroy through the API.
 */
class Controller {
  constructor({ api, scanner }) {
    this.api = api;
    this.scanner = scanner;
    this.traders = new Map();
    this.leverageSet = new Set();
    this._scanning = false;
    this._accountSyncTimer = null;
    this._scanTimer = null;
    this._stopped = false;
  }

  async start() {
    if (config.mode === "live") {
      // Hedge mode (dual-side positions) MUST be enabled on the account so
      // that SHORT and LONG buckets stay independent. The simulator already
      // models this; on live we enforce it on the exchange.
      try {
        await this.api.ensureDualSidePositionMode();
      } catch (err) {
        log("CONTROLLER", `Could not enable hedge position mode: ${err.message}`);
        throw err;
      }
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
    } catch (err) {
      log("CONTROLLER", `Startup cleanup error: ${err.message}`);
    }
  }

  _startAccountSync() {
    this._accountSyncTimer = setInterval(async () => {
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
    this._scanTimer = setInterval(async () => {
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
      if (this.traders.size >= config.maxTraders) return;

      const candidates = await this.scanner.scan();

      for (const candidate of candidates) {
        const symbol = candidate.symbol;
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

        const equity = store.getStatus().equity || Number(config.startingBalanceUSDT);
        const trader = new DCATrader({
          symbol,
          api: this.api,
          changePercent: candidate.change,
          equity,
          onDestroy: (sym, pnl, reason) => this._onTraderDestroyed(sym, pnl, reason)
        });
        this.traders.set(symbol, trader);
        try {
          await trader.start();
          log("CONTROLLER", `Launched trader for ${symbol} (+${candidate.change.toFixed(1)}%)`);
        } catch (err) {
          log("CONTROLLER", `Trader ${symbol} failed to start: ${err.message}`);
          this.traders.delete(symbol);
          try { await trader.destroy("start-failed"); } catch (_) {}
        }
      }

      await this._refreshMarketStreams();
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
    const unrealized = traders.reduce((sum, trader) => sum + (trader.unrealizedPnl || 0), 0);
    store.setEquity(balance + unrealized);
  }

  async _refreshMarketStreams() {
    const symbols = [...this.traders.keys()];
    await this.api.updateSymbols(symbols);
  }

  async _onTraderDestroyed(symbol, _pnl, reason) {
    if (!this.traders.has(symbol)) return;
    this.traders.delete(symbol);
    log("CONTROLLER", `Trader ${symbol} destroyed (${reason})`);
    await this._refreshMarketStreams();
  }

  async destroyTrader(symbol) {
    const trader = this.traders.get(symbol);
    if (!trader) return false;
    await trader.destroy("manual");
    return true;
  }

  /**
   * Graceful shutdown: stop scan/sync timers and close every active trader.
   * Live mode will market-close any open positions through trader.destroy().
   */
  async stop() {
    if (this._stopped) return;
    this._stopped = true;
    if (this._accountSyncTimer) clearInterval(this._accountSyncTimer);
    if (this._scanTimer) clearInterval(this._scanTimer);
    this._accountSyncTimer = null;
    this._scanTimer = null;
    const symbols = [...this.traders.keys()];
    for (const symbol of symbols) {
      const trader = this.traders.get(symbol);
      try {
        if (trader) await trader.destroy("shutdown");
      } catch (err) {
        log("CONTROLLER", `Shutdown destroy ${symbol} failed: ${err.message}`);
      }
    }
  }
}

module.exports = Controller;
