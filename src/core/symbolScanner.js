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

  /** Return the top N USDT-perpetual gainers by 24h % change (no min-% filter). */
  async scan() {
    const tickers = await this.api.get24hTickers();
    const tradableSymbols = await this._getTradableSymbols();
    const list = Array.isArray(tickers) ? tickers : [];

    const limit = Math.max(1, Number(config.maxTraders) || 1);
    const candidates = list
      .map((t) => ({
        symbol: t.symbol,
        change: Number(t.priceChangePercent),
        quoteVolume: Number(t.quoteVolume)
      }))
      .filter((t) => typeof t.symbol === "string" && t.symbol.endsWith("USDT"))
      .filter((t) => tradableSymbols.has(t.symbol))
      .filter((t) => Number.isFinite(t.change))
      .sort((a, b) => b.change - a.change)
      .slice(0, limit);

    for (const c of candidates) {
      log("SCANNER", `${c.symbol} ${c.change >= 0 ? "+" : ""}${c.change.toFixed(2)}% — top gainer`);
    }

    return candidates;
  }
}

module.exports = SymbolScanner;
