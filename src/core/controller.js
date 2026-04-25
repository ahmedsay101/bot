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
    this.symbolCooldown = new Map();   // symbol → cooldown-until timestamp (ms)
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

    const now = Date.now();
    for (const candidate of candidates) {
      const symbol = candidate.symbol;
      const changePercent = candidate.change;
      if (this.traders.size >= config.maxTraders) break;
      if (this.traders.has(symbol)) continue;

      const cooldownUntil = this.symbolCooldown.get(symbol);
      if (cooldownUntil && cooldownUntil > now) {
        const remainMin = Math.ceil((cooldownUntil - now) / 60000);
        log("CONTROLLER", `${symbol} on cooldown for ${remainMin}m — skipping`);
        continue;
      } else if (cooldownUntil) {
        this.symbolCooldown.delete(symbol);
      }

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
        log("CONTROLLER", `Launched trader for ${symbol} (24h +${changePercent.toFixed(1)}%)`);
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

    // Apply per-symbol cooldown after the doubling sequence is exhausted
    if (reason === "max-doubles") {
      const cooldownMs = Number(config.lossCooldownMs) || 0;
      if (cooldownMs > 0) {
        const until = Date.now() + cooldownMs;
        this.symbolCooldown.set(symbol, until);
        log("CONTROLLER", `${symbol} cooldown set for ${Math.round(cooldownMs / 60000)}m (until ${new Date(until).toISOString()})`);
      }
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
