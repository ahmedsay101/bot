const config = require("../utils/config");
const { log } = require("../utils/logger");

class SymbolScanner {
  constructor({ api }) {
    this.api = api;
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

    const candidates = list
      .map((t) => ({
        symbol: t.symbol,
        change: Number(t.priceChangePercent),
        quoteVolume: Number(t.quoteVolume)
      }))
      .filter((t) => typeof t.symbol === "string" && t.symbol.endsWith("USDT"))
      .filter((t) => tradableSymbols.has(t.symbol))
      .filter((t) => Number.isFinite(t.change) && t.change > 50 && t.change < 80)
      .filter((t) => t.quoteVolume >= 10_000_000)
      .sort((a, b) => b.change - a.change)
      .slice(0, Math.max(10, Number(config.maxTraders) || 1));

    for (const c of candidates) {
      log("SCANNER", `${c.symbol} +${c.change.toFixed(1)}% — approved`);
    }

    return candidates;
  }

  /**
   * Return the average 24h change % of the top 5 gainers.
   */
  async getTopGainersAvg() {
    const tickers = await this.api.get24hTickers();
    const tradableSymbols = await this._getTradableSymbols();
    const list = Array.isArray(tickers) ? tickers : [];

    const top5 = list
      .map((t) => ({ symbol: t.symbol, change: Number(t.priceChangePercent) }))
      .filter((t) => typeof t.symbol === "string" && t.symbol.endsWith("USDT"))
      .filter((t) => tradableSymbols.has(t.symbol))
      .filter((t) => Number.isFinite(t.change) && t.change > 0)
      .sort((a, b) => b.change - a.change)
      .slice(0, 5);

    if (top5.length === 0) return 0;
    return top5.reduce((sum, t) => sum + t.change, 0) / top5.length;
  }
}

module.exports = SymbolScanner;
