const DCATrader = require("./dcaTrader");
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
    this._marketBlocked = false;
    this._cooldowns = new Map();
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

    // Hysteresis: block above 55%, allow at or below 50%
    const avg24h = await this.scanner.getTopGainersAvg();
    if (!this._marketBlocked && avg24h > 55) {
      this._marketBlocked = true;
      // Destroy all active traders
      for (const [sym, trader] of this.traders) {
        try {
          await trader.destroy("market-heat");
        } catch (err) {
          log("CONTROLLER", `Failed to destroy ${sym}: ${err.message}`);
        }
      }
      log("CONTROLLER", `Market too hot: top-5 avg ${avg24h.toFixed(1)}% > 55% — destroyed ${this.traders.size} trader(s), blocking`);
      return;
    }
    if (this._marketBlocked) {
      if (avg24h <= 50) {
        this._marketBlocked = false;
        log("CONTROLLER", `Market cooled: top-5 avg ${avg24h.toFixed(1)}% <= 50% — resuming`);
      } else {
        log("CONTROLLER", `Market still hot: top-5 avg ${avg24h.toFixed(1)}% > 50% — blocked`);
        return;
      }
    } else {
      log("CONTROLLER", `Top-5 avg ${avg24h.toFixed(1)}% <= 55% — proceeding`);
    }

    const candidates = await this.scanner.scan();

    for (const candidate of candidates) {
      const symbol = candidate.symbol;
      const changePercent = candidate.change;
      if (this.traders.size >= config.maxTraders) break;
      if (this.traders.has(symbol)) continue;

      const cooldownUntil = this._cooldowns.get(symbol);
      if (cooldownUntil && Date.now() < cooldownUntil) {
        const mins = Math.ceil((cooldownUntil - Date.now()) / 60000);
        log("CONTROLLER", `${symbol} on SL cooldown — ${mins}m remaining`);
        continue;
      }
      this._cooldowns.delete(symbol);

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
        changePercent,
        equity,
        onDestroy: (sym, pnl, reason) => this._onTraderDestroyed(sym, pnl, reason)
      });
      this.traders.set(symbol, trader);
      try {
        await trader.start();
        log("CONTROLLER", `Launched DCA trader for ${symbol}`);
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

  async _onTraderDestroyed(symbol, pnl, reason) {
    if (!this.traders.has(symbol)) return;
    this.traders.delete(symbol);
    if (reason === "stop-loss" && config.slCooldownMs > 0) {
      this._cooldowns.set(symbol, Date.now() + config.slCooldownMs);
      const hrs = (config.slCooldownMs / 3600000).toFixed(1);
      log("CONTROLLER", `${symbol} cooldown ${hrs}h after stop-loss`);
    }
    log("CONTROLLER", `Trader ${symbol} destroyed (${reason})`);
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
