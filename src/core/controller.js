const VolatilityTrader = require("./trader");
const ExpansionTrader = require("./expansionTrader");
const RegimeAnalyzer = require("./RegimeAnalyzer");
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
    this.regimeAnalyzer = new RegimeAnalyzer(config.regime || {});
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
    if (this._scanning) return;
    this._scanning = true;
    try {
      await this._doScanAndLaunch();
    } finally {
      this._scanning = false;
    }
  }

  async _doScanAndLaunch() {
    const activeCount = this.traders.size;
    if (activeCount >= config.maxTraders) return;

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

      // Determine regime for this symbol before creating a trader
      const regime = await this._determineRegime(symbol);
      if (!regime) continue; // Could not fetch market data – skip

      if (regime.regime === "TRANSITION") {
        log("CONTROLLER", `Skipping ${symbol}: TRANSITION regime (exp=${regime.expansionScore} comp=${regime.compressionScore} conf=${regime.confidence.toFixed(2)})`);
        continue;
      }

      const traderType = regime.regime; // "EXPANSION" or "VOLATILITY"
      const TraderClass = traderType === "EXPANSION" ? ExpansionTrader : VolatilityTrader;
      store.setTraderType(traderType);

      const trader = new TraderClass({
        symbol,
        api: this.api,
        onDestroy: (sym, pnl) => this._destroy(sym, pnl)
      });
      this.traders.set(symbol, trader);
      try {
        await trader.start();
        log("CONTROLLER", `Launched ${traderType} trader for ${symbol} (conf=${regime.confidence.toFixed(2)})`);
      } catch (err) {
        log("CONTROLLER", `Trader ${symbol} failed to start: ${err.message}`);
        this.traders.delete(symbol);

        // Back off: 10 min after 1st fail, 30 min after 2nd, 120 min after 3+
        const prev = this.failedSymbols.get(symbol) || { count: 0 };
        const count = prev.count + 1;
        const cooldown = count >= 3 ? 120 : count >= 2 ? 30 : 10;
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

  /**
   * Fetch market data for a symbol and run the regime analyzer.
   * Returns the regime result, or null if data could not be fetched.
   */
  async _determineRegime(symbol) {
    try {
      // Fetch klines for the symbol and BTC in parallel
      const [raw5m, raw1h, rawBtc1h, ticker] = await Promise.all([
        this.api.getKlines(symbol, "5m", 100),
        this.api.getKlines(symbol, "1h", 50),
        this.api.getKlines("BTCUSDT", "1h", 50),
        this.api.getTickerPrice(symbol)
      ]);

      // Convert Binance kline arrays to candle objects
      const toCandle = (k) => ({
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
        volume: Number(k[5])
      });

      const klines5m = raw5m.map(toCandle);
      const klines1h = raw1h.map(toCandle);
      const btcKlines1h = rawBtc1h.map(toCandle);
      const volume5m = klines5m.map((c) => c.volume);
      const currentPrice = Number(ticker);

      // Derive 24h high/low from the 1h candles (last 24 bars)
      const recent24 = klines1h.slice(-24);
      const high24h = Math.max(...recent24.map((c) => c.high));
      const low24h = Math.min(...recent24.map((c) => c.low));

      const result = this.regimeAnalyzer.analyzeRegime({
        klines5m,
        klines1h,
        btcKlines1h,
        volume5m,
        currentPrice,
        high24h,
        low24h
      });

      // Persist regime info to the store for the dashboard
      store.setRegime({
        regime: result.regime,
        confidence: result.confidence,
        expansionScore: result.expansionScore,
        compressionScore: result.compressionScore
      });

      return result;
    } catch (err) {
      log("CONTROLLER", `Regime analysis failed for ${symbol}: ${err.message}`);
      return null;
    }
  }

  async _destroy(symbol, pnl) {
    if (!this.traders.has(symbol)) return;
    this.traders.delete(symbol);

    if (typeof pnl === "number") {
      if (pnl < 0) {
        log("CONTROLLER", `Trader ${symbol} closed with loss ($${pnl.toFixed(2)})`);
      } else {
        log("CONTROLLER", `Trader ${symbol} closed with profit ($${pnl.toFixed(2)})`);
      }
    }

    log("CONTROLLER", `Trader ${symbol} destroyed`);
    await this._refreshMarketStreams();
  }
}

module.exports = Controller;
