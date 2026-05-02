import { CONFIG } from '../core/config.js';
import { Regime } from '../core/constants.js';
import { atr, rsi, sma, slope as slopeOf } from '../indicators/index.js';
import { BinanceRestClient, type Ticker24h } from '../api/binance.rest.js';
import { MarketDataService, type Candle } from './marketData.service.js';
import { ScanModel } from '../models/index.js';
import { scoped } from '../utils/logger.js';

const log = scoped('SCANNER');

export interface ScanCandidate {
  symbol: string;
  price: number;
  atr: number;
  rsi: number;
  ma: number;
  slope: number;
  volatilityScore: number;
  trendScore: number;
  score: number;
  regime: Regime;
  skipped: boolean;
  skipReason?: string;
}

export interface ScanResult {
  ts: Date;
  selected: string[];
  candidates: ScanCandidate[];
}

export class SymbolScannerService {
  private readonly rest = new BinanceRestClient();
  private last: ScanResult | null = null;

  constructor(private readonly market: MarketDataService) {}

  getLast(): ScanResult | null {
    return this.last;
  }

  async run(): Promise<ScanResult> {
    const cfg = CONFIG();
    await this.market.refreshExchangeInfo();
    const exchInfo = new Set((await this.market.refreshExchangeInfo()).map((s) => s.symbol));

    const tickers = await this.rest.tickers24h();
    const filtered = tickers.filter(
      (t) => exchInfo.has(t.symbol) && t.symbol.endsWith('USDT') && t.quoteVolume >= cfg.filters.minVolume,
    );
    log.info({ universe: filtered.length }, 'tickers passed volume filter');

    // Limit candidate set to keep API budget sane: top N by quoteVolume.
    const candidatesUniverse = filtered
      .sort((a, b) => b.quoteVolume - a.quoteVolume)
      .slice(0, cfg.filters.candidateUniverseSize);

    const candidates: ScanCandidate[] = [];
    for (const t of candidatesUniverse) {
      const c = await this.scoreSymbol(t).catch((e) => {
        log.debug({ err: (e as Error).message, symbol: t.symbol }, 'scoreSymbol failed');
        return null;
      });
      if (c) candidates.push(c);
    }

    // Step 5: skip trending
    for (const c of candidates) {
      if (c.trendScore > cfg.thresholds.trendSlope) {
        c.skipped = true;
        c.skipReason = 'trend_slope_too_high';
        c.regime = Regime.TREND;
      }
    }

    // Spread filter: require live bookTicker (only available for currently subscribed symbols).
    // For first scan many symbols won't have bookTicker yet; we skip the spread check for those.
    for (const c of candidates) {
      const bt = this.market.getBookTicker(c.symbol);
      if (!bt) continue;
      const mid = (bt.bidPrice + bt.askPrice) / 2;
      if (mid <= 0) continue;
      const spreadPct = ((bt.askPrice - bt.bidPrice) / mid) * 100;
      if (spreadPct > cfg.filters.maxSpreadPercent) {
        c.skipped = true;
        c.skipReason = 'spread_too_wide';
      }
    }

    // Sort by score desc, take maxSymbols of non-skipped
    const sorted = candidates.slice().sort((a, b) => b.score - a.score);
    const selected = sorted.filter((c) => !c.skipped).slice(0, cfg.trading.maxSymbols).map((c) => c.symbol);

    const result: ScanResult = { ts: new Date(), selected, candidates: sorted };
    this.last = result;

    try {
      await ScanModel.create({ ts: result.ts, selected, candidates: sorted });
    } catch (e) {
      log.warn({ err: (e as Error).message }, 'persist scan failed');
    }
    log.info({ selected }, 'scan complete');
    return result;
  }

  private async scoreSymbol(t: Ticker24h): Promise<ScanCandidate | null> {
    const cfg = CONFIG();
    const interval = cfg.timeframes.scanner;
    const need = Math.max(cfg.indicators.maPeriod, cfg.indicators.atrPeriod, cfg.indicators.rsiPeriod) + 5;
    const candles = await this.market.warmCandles(t.symbol, interval, Math.max(need, 100));
    if (candles.length < need) return null;

    const closes = candles.map((c) => c.close);
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);

    const atrSeries = atr(highs, lows, closes, cfg.indicators.atrPeriod);
    const rsiSeries = rsi(closes, cfg.indicators.rsiPeriod);
    const maSeries = sma(closes, cfg.indicators.maPeriod);
    const slopeSeries = slopeOf(maSeries);

    const last = candles.length - 1;
    const price = closes[last] as number;
    const atrV = atrSeries[last] as number;
    const rsiV = rsiSeries[last] as number;
    const maV = maSeries[last] as number;
    const slopeV = slopeSeries[last] as number;
    if (!isFinite(price) || !isFinite(atrV) || !isFinite(maV) || !isFinite(slopeV)) return null;

    const volatilityScore = atrV / price;
    const trendScore = Math.abs(slopeV);
    const score = volatilityScore * 0.6 - trendScore * 0.4;

    const regime: Regime = trendScore > cfg.thresholds.trendSlope ? Regime.TREND : Regime.RANGE;

    return {
      symbol: t.symbol,
      price,
      atr: atrV,
      rsi: rsiV,
      ma: maV,
      slope: slopeV,
      volatilityScore,
      trendScore,
      score,
      regime,
      skipped: false,
    };
  }
}
