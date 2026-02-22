const Trader = require("./trader");
const { log } = require("../utils/logger");
const config = require("../utils/config");
const store = require("../state/store");

class Controller {
  constructor({ api, scanner }) {
    this.api = api;
    this.scanner = scanner;
    this.traders = new Map();
    this.leverageSet = new Set();
    this.failedSymbols = new Map(); // symbol -> { count, until }
    this.consecutiveLosses = 0;
    this.lossCooldownUntil = 0;
  }

  async start() {
    if (config.mode === "live") {
      await this.api.startUserDataStream();
    }
    await this._refreshMarketStreams();
    await this._syncAccount();
    this._startAccountSync();
    await this._launchLoop();
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

  _isWithinTradingHours() {
    const now = new Date();
    const hour = now.getUTCHours();
    return hour >= 3 && hour < 9;
  }

  _getTimeUntilTradingWindow() {
    const now = new Date();
    const hour = now.getUTCHours();
    const min = now.getUTCMinutes();
    const sec = now.getUTCSeconds();
    const currentMinutes = hour * 60 + min;
    const startMinutes = 3 * 60;
    let diffMinutes = startMinutes - currentMinutes;
    if (diffMinutes <= 0) diffMinutes += 24 * 60;
    const totalSeconds = diffMinutes * 60 - sec;
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    return `${h}h ${m}m`;
  }

  async _scanAndLaunch() {
    const activeCount = this.traders.size;
    if (activeCount >= config.maxTraders) return;

    // Loss cooldown: pause launching after 2 consecutive losses
    if (this.lossCooldownUntil > Date.now()) {
      const remaining = Math.ceil((this.lossCooldownUntil - Date.now()) / 60000);
      log("CONTROLLER", `Loss cooldown active (${this.consecutiveLosses} consecutive losses). Resuming in ${remaining}m`);
      return;
    }

    const candidates = await this.scanner.scan();

    if (config.enableTradingWindow && !this._isWithinTradingHours()) {
      if (candidates.length > 0) {
        log("CONTROLLER", `Trading window closed (03:00–9:00 UTC). Next window in ${this._getTimeUntilTradingWindow()}`);
      }
      return;
    }

    for (const symbol of candidates) {
      if (this.traders.size >= config.maxTraders) break;
      if (this.traders.has(symbol)) continue;

      // Skip symbols that recently failed
      const failure = this.failedSymbols.get(symbol);
      if (failure && Date.now() < failure.until) continue;
      if (failure) this.failedSymbols.delete(symbol);

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

      const trader = new Trader({
        symbol,
        api: this.api,
        onDestroy: (sym, pnl) => this._destroy(sym, pnl)
      });
      this.traders.set(symbol, trader);
      try {
        await trader.start();
      } catch (err) {
        log("CONTROLLER", `Trader ${symbol} failed to start: ${err.message}`);
        this.traders.delete(symbol);

        // Back off: 5 min after 1st fail, 15 min after 2nd, 60 min after 3+
        const prev = this.failedSymbols.get(symbol) || { count: 0 };
        const count = prev.count + 1;
        const cooldown = count >= 3 ? 60 : count >= 2 ? 15 : 5;
        this.failedSymbols.set(symbol, { count, until: Date.now() + cooldown * 60 * 1000 });
        log("CONTROLLER", `${symbol} blacklisted for ${cooldown}m (fail #${count})`);

        try { await trader.destroy("start-failed", { closePositions: true }); } catch (_) {}
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

  async _destroy(symbol, pnl) {
    if (!this.traders.has(symbol)) return;
    this.traders.delete(symbol);

    // Track consecutive losses for cooldown
    if (typeof pnl === "number") {
      if (pnl < 0) {
        this.consecutiveLosses += 1;
        log("CONTROLLER", `Trader ${symbol} closed with loss ($${pnl.toFixed(2)}). Consecutive losses: ${this.consecutiveLosses}`);
        if (this.consecutiveLosses >= 2) {
          const cooldownMin = this.consecutiveLosses >= 4 ? 60 : this.consecutiveLosses >= 3 ? 30 : 15;
          this.lossCooldownUntil = Date.now() + cooldownMin * 60 * 1000;
          log("CONTROLLER", `Loss cooldown activated: ${cooldownMin}m pause after ${this.consecutiveLosses} consecutive losses`);
        }
      } else {
        if (this.consecutiveLosses > 0) {
          log("CONTROLLER", `Trader ${symbol} closed with profit ($${pnl.toFixed(2)}). Loss streak reset.`);
        }
        this.consecutiveLosses = 0;
        this.lossCooldownUntil = 0;
      }
    }

    log("CONTROLLER", `Trader ${symbol} destroyed`);
    await this._refreshMarketStreams();
  }
}

module.exports = Controller;
