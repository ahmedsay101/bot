const config = require("../utils/config");
const { log } = require("../utils/logger");
const ShortEntryEngine = require("./shortEntryEngine");

/** Parse raw Binance kline array into { open, high, low, close, volume } */
function parseKline(k) {
  return {
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5])
  };
}

class SymbolScanner {
  constructor({ api }) {
    this.api = api;
    this.engine = new ShortEntryEngine();
    this.exchangeInfoCache = {
      symbols: new Set(),
      updatedAt: 0
    };
  }

  async _getTradableSymbols() {
    const cacheTtlMs = 10 * 60 * 1000;
    const now = Date.now();
    if (now - this.exchangeInfoCache.updatedAt < cacheTtlMs && this.exchangeInfoCache.symbols.size > 0) {
      return this.exchangeInfoCache.symbols;
    }

    const info = await this.api.getExchangeInfo();
    const symbols = Array.isArray(info.symbols) ? info.symbols : [];
    const tradable = new Set(
      symbols
        .filter((s) => s.contractType === "PERPETUAL")
        .filter((s) => s.quoteAsset === "USDT")
        .filter((s) => s.status === "TRADING")
        .map((s) => s.symbol)
    );

    this.exchangeInfoCache = { symbols: tradable, updatedAt: now };
    return tradable;
  }

  async scan() {
    const tickers = await this.api.get24hTickers();
    const tradableSymbols = await this._getTradableSymbols();
    const list = Array.isArray(tickers) ? tickers : [];

    // Step 1: get top gainers sorted by 24h change
    const topGainers = list
      .map((t) => ({
        symbol: t.symbol,
        change: Number(t.priceChangePercent),
        quoteVolume: Number(t.quoteVolume),
        highPrice: Number(t.highPrice),
        lastPrice: Number(t.lastPrice)
      }))
      .filter((t) => typeof t.symbol === "string" && t.symbol.endsWith("USDT"))
      .filter((t) => tradableSymbols.has(t.symbol))
      .filter((t) => Number.isFinite(t.change) && t.change > 0)
      .filter((t) => t.quoteVolume >= 10_000_000)
      .sort((a, b) => b.change - a.change)
      .slice(0, 10);

    // Step 2: run each through the decision engine
    const approved = [];
    for (const t of topGainers) {
      try {
        const [raw5m, raw1h] = await Promise.all([
          this.api.getKlines(t.symbol, "5m", 30),
          this.api.getKlines(t.symbol, "1h", 10)
        ]);
        const klines5m = (raw5m || []).map(parseKline);
        const klines1h = (raw1h || []).map(parseKline);

        const result = this.engine.shouldShort({
          klines5m,
          klines1h,
          currentPrice: t.lastPrice,
          high24h: t.highPrice
        });

        log("SCANNER", `${t.symbol} +${t.change.toFixed(1)}% → short=${result.shouldShort} ` +
          `[mom=${result.weakeningMomentumScore} exh=${result.exhaustionScore} ` +
          `conf=${result.confirmationScore} runner=${result.isRunner}]`);

        if (result.shouldShort) {
          approved.push({ symbol: t.symbol, change: t.change });
        }
      } catch (err) {
        log("SCANNER", `${t.symbol} engine error: ${err.message}`);
      }
    }

    // Step 3: sort approved by 24h change, take top maxTraders
    return approved
      .sort((a, b) => b.change - a.change)
      .slice(0, Number(config.maxTraders) || 1);
  }
}

module.exports = SymbolScanner;
