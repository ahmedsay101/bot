import { EventEmitter } from 'node:events';
import { BinanceRestClient, type RawKline, type ExchangeSymbolInfo } from '../api/binance.rest.js';
import { BinanceWsClient, type KlineEvent, type BookTickerEvent } from '../api/binance.ws.js';
import { Channels } from '../core/constants.js';
import { CONFIG } from '../core/config.js';
import { intervalMs } from '../utils/time.js';
import { scoped } from '../utils/logger.js';
import { publish } from './redis.service.js';
import { KlineCacheModel } from '../models/index.js';

const log = scoped('MARKET');

export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

export interface MarketDataEvents {
  candleClose: (symbol: string, interval: string, candle: Candle) => void;
  bookTicker: (e: BookTickerEvent) => void;
  ready: () => void;
}

interface SymbolBuffers {
  [interval: string]: Candle[];
}

const MAX_BUFFER = 600;

export class MarketDataService extends EventEmitter {
  private readonly rest = new BinanceRestClient();
  private readonly ws = new BinanceWsClient();
  private readonly buffers = new Map<string, SymbolBuffers>();
  private readonly bookTickers = new Map<string, BookTickerEvent>();
  private exchangeInfo: ExchangeSymbolInfo[] = [];
  private exchangeInfoFetchedAt = 0;
  private subscribed = new Map<string, Set<string>>(); // symbol -> intervals

  override on<K extends keyof MarketDataEvents>(event: K, listener: MarketDataEvents[K]): this {
    return super.on(event, listener);
  }
  override emit<K extends keyof MarketDataEvents>(event: K, ...args: Parameters<MarketDataEvents[K]>): boolean {
    return super.emit(event, ...args);
  }

  async start(): Promise<void> {
    await this.refreshExchangeInfo();
    this.ws.on('kline', (e) => this.handleKline(e));
    this.ws.on('bookTicker', (e) => this.handleBookTicker(e));
    this.ws.start();
    this.emit('ready');
  }

  async stop(): Promise<void> {
    await this.ws.stop();
  }

  // -------------------------------------------------------------------------

  async refreshExchangeInfo(force = false): Promise<ExchangeSymbolInfo[]> {
    const tenMin = 10 * 60 * 1000;
    if (!force && this.exchangeInfo.length && Date.now() - this.exchangeInfoFetchedAt < tenMin) {
      return this.exchangeInfo;
    }
    this.exchangeInfo = await this.rest.exchangeInfo();
    this.exchangeInfoFetchedAt = Date.now();
    log.info({ count: this.exchangeInfo.length }, 'exchangeInfo refreshed');
    return this.exchangeInfo;
  }

  getSymbolInfo(symbol: string): ExchangeSymbolInfo | undefined {
    return this.exchangeInfo.find((s) => s.symbol === symbol);
  }

  /**
   * Replace subscriptions atomically. `subs` is a list of (symbol, interval)
   * pairs. Always also subscribes bookTicker for each unique symbol.
   */
  setSubscriptions(subs: Array<{ symbol: string; interval: string }>): void {
    const next = new Map<string, Set<string>>();
    for (const s of subs) {
      if (!next.has(s.symbol)) next.set(s.symbol, new Set());
      next.get(s.symbol)!.add(s.interval);
    }
    this.subscribed = next;
    const streams: string[] = [];
    for (const [symbol, intervals] of next) {
      const lc = symbol.toLowerCase();
      streams.push(`${lc}@bookTicker`);
      for (const i of intervals) streams.push(`${lc}@kline_${i}`);
    }
    this.ws.setStreams(streams);
  }

  /** Eagerly load candles via REST (used on first subscription / on demand). */
  async warmCandles(symbol: string, interval: string, count = 200): Promise<Candle[]> {
    const cacheKey = `${symbol}:${interval}`;
    const buf = this.getBuffer(symbol, interval);
    if (buf.length >= count) return buf.slice(-count);

    // Try Mongo cache first
    const cached = await KlineCacheModel.find({ symbol, interval })
      .sort({ openTime: -1 })
      .limit(count)
      .lean();
    if (cached.length >= count) {
      const candles = cached.reverse().map(toCandle);
      this.buffers.set(symbol, { ...this.buffers.get(symbol), [interval]: candles });
      log.debug({ cacheKey, n: candles.length }, 'warm from cache');
      return candles;
    }

    // Fall back to REST
    const raw = await this.rest.klines(symbol, interval, { limit: count });
    const candles = raw.map(toCandle);
    this.buffers.set(symbol, { ...this.buffers.get(symbol), [interval]: candles });
    void this.persistCandles(symbol, interval, candles);
    log.debug({ cacheKey, n: candles.length }, 'warm from REST');
    return candles;
  }

  getCandles(symbol: string, interval: string): Candle[] {
    return this.getBuffer(symbol, interval).slice();
  }

  getBookTicker(symbol: string): BookTickerEvent | undefined {
    return this.bookTickers.get(symbol);
  }

  // -------------------------------------------------------------------------

  private getBuffer(symbol: string, interval: string): Candle[] {
    let m = this.buffers.get(symbol);
    if (!m) {
      m = {};
      this.buffers.set(symbol, m);
    }
    if (!m[interval]) m[interval] = [];
    return m[interval]!;
  }

  private handleKline(e: KlineEvent): void {
    const buf = this.getBuffer(e.symbol, e.interval);
    const candle: Candle = {
      openTime: e.openTime,
      open: e.open,
      high: e.high,
      low: e.low,
      close: e.close,
      volume: e.volume,
      closeTime: e.closeTime,
    };
    const last = buf[buf.length - 1];
    if (last && last.openTime === e.openTime) {
      buf[buf.length - 1] = candle;
    } else {
      buf.push(candle);
      if (buf.length > MAX_BUFFER) buf.splice(0, buf.length - MAX_BUFFER);
    }
    if (e.isClosed) {
      this.emit('candleClose', e.symbol, e.interval, candle);
      void publish(Channels.CANDLE_CLOSE, { symbol: e.symbol, interval: e.interval, candle });
      void this.persistCandles(e.symbol, e.interval, [candle]);
    }
  }

  private handleBookTicker(e: BookTickerEvent): void {
    this.bookTickers.set(e.symbol, e);
    this.emit('bookTicker', e);
    void publish(Channels.BOOK_TICKER, e);
  }

  private async persistCandles(symbol: string, interval: string, candles: Candle[]): Promise<void> {
    if (candles.length === 0) return;
    try {
      const ops = candles.map((c) => ({
        updateOne: {
          filter: { symbol, interval, openTime: c.openTime },
          update: { $set: { ...c, symbol, interval } },
          upsert: true,
        },
      }));
      await KlineCacheModel.bulkWrite(ops, { ordered: false });
    } catch (e) {
      log.debug({ err: (e as Error).message }, 'kline persist failed');
    }
  }

  // For backtest service: bulk fetch via REST + cache.
  async fetchHistoricalKlines(symbol: string, interval: string, fromTs: number, toTs: number): Promise<Candle[]> {
    const out: Candle[] = [];
    const step = intervalMs(interval);
    let cursor = fromTs;
    while (cursor < toTs) {
      const batch = await this.rest.klines(symbol, interval, { startTime: cursor, endTime: toTs, limit: 1500 });
      if (batch.length === 0) break;
      for (const k of batch) out.push(toCandle(k));
      const lastK = batch[batch.length - 1];
      if (!lastK) break;
      cursor = lastK.openTime + step;
      if (batch.length < 1500) break;
    }
    return out;
  }
}

function toCandle(k: RawKline | { openTime: number; open: number; high: number; low: number; close: number; volume: number; closeTime: number }): Candle {
  return {
    openTime: k.openTime,
    open: k.open,
    high: k.high,
    low: k.low,
    close: k.close,
    volume: k.volume,
    closeTime: k.closeTime,
  };
}

// CONFIG referenced for symmetry with service-level introspection (avoid unused import warning)
void CONFIG;
