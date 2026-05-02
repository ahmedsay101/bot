import axios, { AxiosError, type AxiosInstance } from 'axios';
import crypto from 'node:crypto';
import { env } from '../core/env.js';
import { scoped } from '../utils/logger.js';

const log = scoped('BINANCE');

export interface RawKline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

export interface ExchangeSymbolFilter {
  tickSize: number;
  stepSize: number;
  minQty: number;
  minNotional: number;
}

export interface ExchangeSymbolInfo {
  symbol: string;
  status: string;
  contractType: string;
  pricePrecision: number;
  quantityPrecision: number;
  filters: ExchangeSymbolFilter;
}

export interface Ticker24h {
  symbol: string;
  lastPrice: number;
  priceChangePercent: number;
  quoteVolume: number;
}

export interface BookTicker {
  symbol: string;
  bidPrice: number;
  askPrice: number;
}

export interface PlaceOrderParams {
  symbol: string;
  side: 'BUY' | 'SELL';
  type: 'MARKET' | 'LIMIT' | 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
  quantity: number;
  price?: number;
  stopPrice?: number;
  reduceOnly?: boolean;
  newClientOrderId: string;
  timeInForce?: 'GTC' | 'IOC' | 'FOK';
  positionSide?: 'LONG' | 'SHORT' | 'BOTH';
  workingType?: 'MARK_PRICE' | 'CONTRACT_PRICE';
}

export class BinanceRestClient {
  private readonly http: AxiosInstance;
  private readonly hasAuth: boolean;

  constructor(opts?: { apiKey?: string; apiSecret?: string; baseURL?: string }) {
    const apiKey = opts?.apiKey ?? env.BINANCE_API_KEY;
    const baseURL = opts?.baseURL ?? env.BINANCE_REST_BASE;
    this.hasAuth = Boolean(apiKey && (opts?.apiSecret ?? env.BINANCE_API_SECRET));
    this.http = axios.create({
      baseURL,
      timeout: 10_000,
      headers: apiKey ? { 'X-MBX-APIKEY': apiKey } : {},
    });
  }

  // ---- Public endpoints -------------------------------------------------

  async exchangeInfo(): Promise<ExchangeSymbolInfo[]> {
    const { data } = await this.http.get('/fapi/v1/exchangeInfo');
    const symbols: ExchangeSymbolInfo[] = [];
    for (const s of data.symbols as Array<Record<string, unknown>>) {
      if (s.quoteAsset !== 'USDT') continue;
      if (s.contractType !== 'PERPETUAL') continue;
      if (s.status !== 'TRADING') continue;
      const filters = s.filters as Array<Record<string, string>>;
      const priceFilter = filters.find((f) => f.filterType === 'PRICE_FILTER');
      const lotFilter = filters.find((f) => f.filterType === 'LOT_SIZE');
      const minNotional = filters.find((f) => f.filterType === 'MIN_NOTIONAL');
      symbols.push({
        symbol: s.symbol as string,
        status: s.status as string,
        contractType: s.contractType as string,
        pricePrecision: Number(s.pricePrecision),
        quantityPrecision: Number(s.quantityPrecision),
        filters: {
          tickSize: Number(priceFilter?.tickSize ?? 0.01),
          stepSize: Number(lotFilter?.stepSize ?? 0.001),
          minQty: Number(lotFilter?.minQty ?? 0),
          minNotional: Number(minNotional?.notional ?? 5),
        },
      });
    }
    return symbols;
  }

  async tickers24h(): Promise<Ticker24h[]> {
    const { data } = await this.http.get('/fapi/v1/ticker/24hr');
    return (data as Array<Record<string, string>>).map((t) => ({
      symbol: t.symbol as string,
      lastPrice: Number(t.lastPrice),
      priceChangePercent: Number(t.priceChangePercent),
      quoteVolume: Number(t.quoteVolume),
    }));
  }

  async bookTicker(symbol: string): Promise<BookTicker> {
    const { data } = await this.http.get('/fapi/v1/ticker/bookTicker', { params: { symbol } });
    return {
      symbol: data.symbol as string,
      bidPrice: Number(data.bidPrice),
      askPrice: Number(data.askPrice),
    };
  }

  async klines(symbol: string, interval: string, opts: { limit?: number; startTime?: number; endTime?: number } = {}): Promise<RawKline[]> {
    const { data } = await this.http.get('/fapi/v1/klines', {
      params: { symbol, interval, limit: opts.limit ?? 500, startTime: opts.startTime, endTime: opts.endTime },
    });
    return (data as unknown[][]).map((k) => ({
      openTime: Number(k[0]),
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5]),
      closeTime: Number(k[6]),
    }));
  }

  // ---- Authenticated endpoints -----------------------------------------

  private requireAuth(): void {
    if (!this.hasAuth) throw new Error('Binance auth required (set BINANCE_API_KEY/SECRET)');
  }

  private sign(params: Record<string, string | number | boolean | undefined>): string {
    const filtered: Record<string, string> = {};
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined) continue;
      filtered[k] = String(v);
    }
    filtered.timestamp = String(Date.now());
    filtered.recvWindow = '5000';
    const qs = new URLSearchParams(filtered).toString();
    const secret = env.BINANCE_API_SECRET;
    const signature = crypto.createHmac('sha256', secret).update(qs).digest('hex');
    return `${qs}&signature=${signature}`;
  }

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    this.requireAuth();
    const body = this.sign({ symbol, leverage });
    await this.http.post(`/fapi/v1/leverage?${body}`);
  }

  async placeOrder(p: PlaceOrderParams): Promise<{ orderId: number; clientOrderId: string }> {
    this.requireAuth();
    const params: Record<string, string | number | boolean | undefined> = {
      symbol: p.symbol,
      side: p.side,
      type: p.type,
      quantity: p.quantity,
      newClientOrderId: p.newClientOrderId,
    };
    if (p.price !== undefined) params.price = p.price;
    if (p.stopPrice !== undefined) params.stopPrice = p.stopPrice;
    if (p.reduceOnly !== undefined) params.reduceOnly = p.reduceOnly;
    if (p.timeInForce) params.timeInForce = p.timeInForce;
    if (p.positionSide) params.positionSide = p.positionSide;
    if (p.workingType) params.workingType = p.workingType;
    if (p.type === 'LIMIT' && !p.timeInForce) params.timeInForce = 'GTC';
    const body = this.sign(params);
    try {
      const { data } = await this.http.post(`/fapi/v1/order?${body}`);
      return { orderId: Number(data.orderId), clientOrderId: String(data.clientOrderId) };
    } catch (e) {
      const ax = e as AxiosError<{ msg?: string; code?: number }>;
      log.error({ err: ax.response?.data ?? ax.message }, 'placeOrder failed');
      throw new Error(`Binance placeOrder failed: ${ax.response?.data?.msg ?? ax.message}`);
    }
  }

  async cancelOrder(symbol: string, clientOrderId: string): Promise<void> {
    this.requireAuth();
    const body = this.sign({ symbol, origClientOrderId: clientOrderId });
    await this.http.delete(`/fapi/v1/order?${body}`);
  }

  async getPositions(): Promise<Array<{ symbol: string; positionAmt: number; entryPrice: number; leverage: number }>> {
    this.requireAuth();
    const body = this.sign({});
    const { data } = await this.http.get(`/fapi/v2/positionRisk?${body}`);
    return (data as Array<Record<string, string>>).map((p) => ({
      symbol: p.symbol as string,
      positionAmt: Number(p.positionAmt),
      entryPrice: Number(p.entryPrice),
      leverage: Number(p.leverage),
    }));
  }

  async getBalanceUsdt(): Promise<{ balance: number; available: number }> {
    this.requireAuth();
    const body = this.sign({});
    const { data } = await this.http.get(`/fapi/v2/balance?${body}`);
    const usdt = (data as Array<Record<string, string>>).find((b) => b.asset === 'USDT');
    return {
      balance: Number(usdt?.balance ?? 0),
      available: Number(usdt?.availableBalance ?? 0),
    };
  }

  async createListenKey(): Promise<string> {
    this.requireAuth();
    const { data } = await this.http.post('/fapi/v1/listenKey');
    return String(data.listenKey);
  }

  async keepAliveListenKey(): Promise<void> {
    this.requireAuth();
    await this.http.put('/fapi/v1/listenKey');
  }

  async openOrders(symbol?: string): Promise<unknown[]> {
    this.requireAuth();
    const body = this.sign(symbol ? { symbol } : {});
    const { data } = await this.http.get(`/fapi/v1/openOrders?${body}`);
    return data as unknown[];
  }
}
