const config = require("../utils/config");
const { absPctChange } = require("../utils/math");

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
      .filter((t) => Number.isFinite(t.change));

    if (!config.enableScannerFilters) {
      return candidates
        .sort((a, b) => b.change - a.change)
        .slice(0, Math.max(1, Number(config.maxTraders) || 1))
        .map((t) => t.symbol);
    }

    const filtered = [];
    for (const t of candidates) {
      const change = Math.abs(t.change);
      if (change < config.minChange || change > config.maxChange) continue;

      const klines1h = await this.api.getKlines(t.symbol, "1h", 1);
      const klines4h = await this.api.getKlines(t.symbol, "4h", 1);
      const volume1h = Number(klines1h[0][5]);
      const volume24h = t.quoteVolume;
      if (volume1h < config.volumeRatio * volume24h) continue;

      const high4h = Number(klines4h[0][2]);
      const low4h = Number(klines4h[0][3]);
      const rangePct = absPctChange(low4h, high4h);
      if (rangePct < config.minRangePercent) continue;

      const depth = await this.api.getDepth(t.symbol, 50);
      const bidDepth = depth.bids.reduce((sum, b) => sum + Number(b[0]) * Number(b[1]), 0);
      const askDepth = depth.asks.reduce((sum, a) => sum + Number(a[0]) * Number(a[1]), 0);
      if (bidDepth < config.depthMin || askDepth < config.depthMin) continue;
      if (bidDepth > config.depthMax || askDepth > config.depthMax) continue;

      const bestBid = Number(depth.bids[0][0]);
      const bestAsk = Number(depth.asks[0][0]);
      const spread = (bestAsk - bestBid) / bestBid;
      if (spread < config.spreadMin || spread > config.spreadMax) continue;

      filtered.push({ symbol: t.symbol, score: change + rangePct });
    }

    filtered.sort((a, b) => b.score - a.score);
    return filtered
      .slice(0, Math.max(1, Number(config.maxTraders) || 1))
      .map((t) => t.symbol);
  }
}

module.exports = SymbolScanner;
