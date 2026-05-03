import { CONFIG } from '../core/config.js';
import { BinanceRestClient, type Ticker24h } from '../api/binance.rest.js';
import { MarketDataService } from './marketData.service.js';
import { scoped } from '../utils/logger.js';

const log = scoped('UNIVERSE');

/**
 * Pure price-structure universe selector. NO indicators, NO scoring beyond
 * 24h quote-volume. Picks the top-N USDT perpetuals with sane spreads.
 */
export class SymbolUniverseService {
  private readonly rest = new BinanceRestClient();
  private last: { ts: number; symbols: string[]; tickers: Ticker24h[] } = {
    ts: 0,
    symbols: [],
    tickers: [],
  };

  constructor(private readonly market: MarketDataService) {}

  getLast(): { ts: number; symbols: string[]; tickers: Ticker24h[] } {
    return this.last;
  }

  async select(): Promise<string[]> {
    const cfg = CONFIG();
    const exchInfo = await this.market.refreshExchangeInfo();
    const tradable = new Set(exchInfo.map((s) => s.symbol));

    const tickers = await this.rest.tickers24h();
    const filtered = tickers.filter(
      (t) =>
        tradable.has(t.symbol) &&
        t.symbol.endsWith('USDT') &&
        Number.isFinite(t.quoteVolume) &&
        t.quoteVolume >= cfg.filters.minVolume,
    );
    const sorted = filtered.sort((a, b) => b.quoteVolume - a.quoteVolume);
    const selected = sorted.slice(0, cfg.grid.universeSize).map((t) => t.symbol);

    this.last = { ts: Date.now(), symbols: selected, tickers: sorted.slice(0, 50) };
    log.info({ selected }, 'universe selected');
    return selected;
  }
}
