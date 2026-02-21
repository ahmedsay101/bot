const ExpansionTrader = require("./expansionTrader");
const VolatilityTrader = require("./volatilityTrader");
const { log } = require("../utils/logger");
const config = require("../utils/config");
const store = require("../state/store");

class Controller {
  constructor({ api, scanner }) {
    this.api = api;
    this.scanner = scanner;
    this.traders = new Map();
    this.leverageSet = new Set();
    this.leverageBlacklist = new Set();
  }

  _getSlotCounts() {
    const total = Number(config.maxTraders) || 2;
    const volatilitySlots = Math.floor(total / 2);
    const expansionSlots = total - volatilitySlots;
    return { expansionSlots, volatilitySlots };
  }

  _countByType() {
    let expansion = 0;
    let volatility = 0;
    for (const trader of this.traders.values()) {
      if (trader.traderType === "VOLATILITY") {
        volatility += 1;
      } else {
        expansion += 1;
      }
    }
    return { expansion, volatility };
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

    const candidates = await this.scanner.scan();

    if (config.enableTradingWindow && !this._isWithinTradingHours()) {
      if (candidates.length > 0) {
        log("CONTROLLER", `Trading window closed (03:00–9:00 UTC). Next window in ${this._getTimeUntilTradingWindow()}`);
      }
      return;
    }

    const { expansionSlots, volatilitySlots } = this._getSlotCounts();
    const counts = this._countByType();
    let volatilityFails = 0;
    let expansionFails = 0;
    const MAX_TYPE_FAILURES = 3;

    for (const symbol of candidates) {
      if (this.traders.size >= config.maxTraders) break;
      if (this.traders.has(symbol)) continue;
      if (this.leverageBlacklist.has(symbol)) continue;

      if (config.mode === "live" && !this.leverageSet.has(symbol)) {
        try {
          await this.api.setLeverage(symbol, config.leverage);
          this.leverageSet.add(symbol);
          log("CONTROLLER", `Leverage set ${config.leverage}x for ${symbol}`);
        } catch (err) {
          log("CONTROLLER", `Leverage set failed for ${symbol}: ${err.message}`);
          this.leverageBlacklist.add(symbol);
          continue;
        }
      }

      // Decide which type to launch based on available slots and recent failures
      const canVolatility = counts.volatility < volatilitySlots && volatilityFails < MAX_TYPE_FAILURES;
      const canExpansion = counts.expansion < expansionSlots && expansionFails < MAX_TYPE_FAILURES;

      let trader;
      if (canVolatility) {
        trader = new VolatilityTrader({
          symbol,
          api: this.api,
          onDestroy: (sym) => this._destroy(sym)
        });
        counts.volatility += 1;
        log("CONTROLLER", `Launching VolatilityTrader for ${symbol}`);
      } else if (canExpansion) {
        trader = new ExpansionTrader({
          symbol,
          api: this.api,
          onDestroy: (sym) => this._destroy(sym)
        });
        counts.expansion += 1;
        log("CONTROLLER", `Launching ExpansionTrader for ${symbol}`);
      } else {
        break;
      }

      this.traders.set(symbol, trader);
      try {
        await trader.start();
      } catch (err) {
        log("CONTROLLER", `Trader ${symbol} failed to start: ${err.message}`);
        this.traders.delete(symbol);
        if (trader.traderType === "VOLATILITY") {
          counts.volatility -= 1;
          volatilityFails += 1;
        } else {
          counts.expansion -= 1;
          expansionFails += 1;
        }
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

  async _destroy(symbol) {
    if (!this.traders.has(symbol)) return;
    this.traders.delete(symbol);
    log("CONTROLLER", `Trader ${symbol} destroyed`);
    await this._refreshMarketStreams();
  }
}

module.exports = Controller;
