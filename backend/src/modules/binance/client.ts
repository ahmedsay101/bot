import crypto from 'crypto';
import fetch from 'node-fetch';
import type { Response } from 'node-fetch';
import { config } from '../../config';
import { createContextLogger } from '../logger';
import { withRetry, CircuitBreaker } from '../utils/retry';
import type { SymbolInfo, Ticker24h, OrderRequest, OrderResult, PositionInfo } from '../../types';

const log = createContextLogger('BinanceClient');

export class BinanceApiError extends Error {
  constructor(
    message: string,
    public readonly code: number,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'BinanceApiError';
  }
}

interface BinanceOrderResponse {
  orderId: number;
  clientOrderId: string;
  symbol: string;
  side: string;
  type: string;
  origQty: string;
  price: string;
  stopPrice?: string;
  status: string;
  executedQty: string;
  avgPrice?: string;
  updateTime: number;
  commissionAsset?: string;
  commission?: string;
}

interface BinanceExchangeInfo {
  symbols: Array<{
    symbol: string;
    baseAsset: string;
    quoteAsset: string;
    pricePrecision: number;
    quantityPrecision: number;
    status: string;
    contractType: string;
    filters: Array<{
      filterType: string;
      tickSize?: string;
      stepSize?: string;
      minQty?: string;
      notional?: string;
    }>;
  }>;
}

interface BinanceTicker {
  symbol: string;
  priceChangePercent: string;
  lastPrice: string;
  volume: string;
  quoteVolume: string;
  openPrice: string;
  highPrice: string;
  lowPrice: string;
  count: number;
}

export class BinanceClient {
  private readonly baseUrl: string;
  private readonly circuit = new CircuitBreaker('BinanceRestApi', 5, 60000);
  private serverTimeDrift = 0;

  constructor() {
    this.baseUrl = config.binance.futuresBaseUrl;
  }

  async initialize(): Promise<void> {
    await this.syncServerTime();
    log.info('BinanceClient initialized', { baseUrl: this.baseUrl });
  }

  private async syncServerTime(): Promise<void> {
    const serverTime = await this.publicGet<{ serverTime: number }>('/time');
    this.serverTimeDrift = serverTime.serverTime - Date.now();
    if (Math.abs(this.serverTimeDrift) > 1000) {
      log.warn(`Server time drift: ${this.serverTimeDrift}ms`);
    }
  }

  private getTimestamp(): number {
    return Date.now() + this.serverTimeDrift;
  }

  private sign(params: Record<string, string | number | boolean>): string {
    const query = new URLSearchParams(
      Object.entries(params).map(([k, v]) => [k, String(v)]) as [string, string][],
    ).toString();
    const sig = crypto.createHmac('sha256', config.binance.secretKey).update(query).digest('hex');
    return `${query}&signature=${sig}`;
  }

  private async publicGet<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const query = Object.keys(params).length > 0 ? '?' + new URLSearchParams(params).toString() : '';
    const url = `${this.baseUrl}${path}${query}`;
    return this.circuit.execute(() =>
      withRetry(
        async () => {
          const res = await fetch(url);
          return this.parseResponse<T>(res);
        },
        { maxAttempts: 3, delayMs: 1000 },
      ),
    );
  }

  private async signedRequest<T>(method: 'GET' | 'POST' | 'DELETE', path: string, params: Record<string, string | number | boolean> = {}): Promise<T> {
    const timestamped = { ...params, timestamp: this.getTimestamp(), recvWindow: 5000 };
    const signed = this.sign(timestamped);
    const url = method === 'GET' || method === 'DELETE'
      ? `${this.baseUrl}${path}?${signed}`
      : `${this.baseUrl}${path}`;

    return this.circuit.execute(() =>
      withRetry(
        async () => {
          const res = await fetch(url, {
            method,
            headers: {
              'X-MBX-APIKEY': config.binance.apiKey,
              ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
            },
            body: method === 'POST' ? signed : undefined,
          });
          return this.parseResponse<T>(res);
        },
        { maxAttempts: config.trading.retryLimit, delayMs: 500, backoffFactor: 2, maxDelayMs: 10000 },
      ),
    );
  }

  private async parseResponse<T>(res: Response): Promise<T> {
    const body = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new BinanceApiError(`Non-JSON response: ${body}`, -1, res.status);
    }

    if (!res.ok) {
      const err = parsed as { code: number; msg: string };
      throw new BinanceApiError(err.msg ?? body, err.code ?? -1, res.status);
    }

    return parsed as T;
  }

  async getExchangeInfo(): Promise<SymbolInfo[]> {
    const info = await this.publicGet<BinanceExchangeInfo>('/exchangeInfo');
    return info.symbols
      .filter((s) => s.status === 'TRADING' && s.contractType === 'PERPETUAL')
      .map((s) => {
        const priceFilter = s.filters.find((f) => f.filterType === 'PRICE_FILTER');
        const lotFilter = s.filters.find((f) => f.filterType === 'LOT_SIZE');
        const notionalFilter = s.filters.find((f) => f.filterType === 'MIN_NOTIONAL');
        return {
          symbol: s.symbol,
          baseAsset: s.baseAsset,
          quoteAsset: s.quoteAsset,
          pricePrecision: s.pricePrecision,
          quantityPrecision: s.quantityPrecision,
          tickSize: priceFilter?.tickSize ?? '0.01',
          stepSize: lotFilter?.stepSize ?? '0.001',
          minQty: lotFilter?.minQty ?? '0.001',
          minNotional: notionalFilter?.notional ?? '5',
          maxLeverage: 125,
          contractType: s.contractType,
          status: s.status,
        };
      });
  }

  async get24hTickers(): Promise<Ticker24h[]> {
    const tickers = await this.publicGet<BinanceTicker[]>('/ticker/24hr');
    return tickers.map((t) => ({
      symbol: t.symbol,
      priceChangePercent: t.priceChangePercent,
      lastPrice: t.lastPrice,
      volume: t.volume,
      quoteVolume: t.quoteVolume,
      openPrice: t.openPrice,
      highPrice: t.highPrice,
      lowPrice: t.lowPrice,
      count: t.count,
    }));
  }

  async getMarkPrice(symbol: string): Promise<string> {
    const data = await this.publicGet<{ markPrice: string }>('/premiumIndex', { symbol });
    return data.markPrice;
  }

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    await this.signedRequest<unknown>('POST', '/leverage', { symbol, leverage });
    log.info(`Set leverage ${leverage}x for ${symbol}`);
  }

  async setMarginType(symbol: string, marginType: string): Promise<void> {
    try {
      await this.signedRequest<unknown>('POST', '/marginType', { symbol, marginType });
      log.info(`Set margin type ${marginType} for ${symbol}`);
    } catch (err) {
      // Binance returns -4046 if already set — safe to ignore
      if (err instanceof BinanceApiError && err.code === -4046) return;
      throw err;
    }
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    const params: Record<string, string | number | boolean> = {
      symbol: req.symbol,
      side: req.side,
      type: req.type,
      quantity: req.quantity,
      newClientOrderId: req.clientOrderId,
      newOrderRespType: 'RESULT',
    };

    if (req.price != null) params.price = req.price;
    if (req.stopPrice != null) params.stopPrice = req.stopPrice;
    if (req.reduceOnly === true) params.reduceOnly = true;
    if (req.type === 'STOP_LIMIT' || req.type === 'LIMIT') params.timeInForce = 'GTC';
    if (req.type === 'TAKE_PROFIT') {
      params.timeInForce = 'GTC';
      params.reduceOnly = true;
    }

    const res = await this.signedRequest<BinanceOrderResponse>('POST', '/order', params);

    return {
      clientOrderId: res.clientOrderId,
      exchangeOrderId: String(res.orderId),
      symbol: res.symbol,
      side: res.side as OrderResult['side'],
      type: res.type as OrderResult['type'],
      status: res.status as OrderResult['status'],
      quantity: res.origQty,
      price: res.price !== '0' ? (res.price ?? null) : null,
      stopPrice: res.stopPrice !== '0' ? (res.stopPrice ?? null) : null,
      filledQuantity: res.executedQty,
      avgFillPrice: res.avgPrice ?? null,
      fee: res.commission ?? '0',
      feeCurrency: res.commissionAsset ?? 'USDT',
      createdAt: new Date(),
      filledAt: res.executedQty === res.origQty ? new Date(res.updateTime) : null,
    };
  }

  async cancelOrder(symbol: string, clientOrderId: string): Promise<void> {
    await this.signedRequest<unknown>('DELETE', '/order', { symbol, origClientOrderId: clientOrderId });
    log.info(`Cancelled order ${clientOrderId} for ${symbol}`);
  }

  async cancelAllOpenOrders(symbol: string): Promise<void> {
    await this.signedRequest<unknown>('DELETE', '/allOpenOrders', { symbol });
    log.info(`Cancelled all open orders for ${symbol}`);
  }

  async getOpenOrders(symbol: string): Promise<BinanceOrderResponse[]> {
    return this.signedRequest<BinanceOrderResponse[]>('GET', '/openOrders', { symbol });
  }

  async getPositions(symbol?: string): Promise<PositionInfo[]> {
    const params: Record<string, string> = {};
    if (symbol != null) params.symbol = symbol;
    const positions = await this.signedRequest<Array<{
      symbol: string;
      positionSide: string;
      entryPrice: string;
      positionAmt: string;
      unRealizedProfit: string;
      leverage: string;
      liquidationPrice: string;
      markPrice: string;
    }>>('GET', '/positionRisk', params);

    return positions
      .filter((p) => p.positionAmt !== '0')
      .map((p) => ({
        symbol: p.symbol,
        side: (parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT') as PositionInfo['side'],
        entryPrice: p.entryPrice,
        quantity: p.positionAmt,
        unrealizedPnl: p.unRealizedProfit,
        leverage: parseInt(p.leverage, 10),
        liquidationPrice: p.liquidationPrice,
        markPrice: p.markPrice,
      }));
  }

  async closePosition(symbol: string, side: 'LONG' | 'SHORT', quantity: string): Promise<OrderResult> {
    const closeSide = side === 'LONG' ? 'SELL' : 'BUY';
    return this.placeOrder({
      traderId: '',
      clientOrderId: `close_${symbol}_${Date.now()}`,
      symbol,
      side: closeSide,
      type: 'MARKET',
      role: 'HEDGE',
      hedgeLevel: 0,
      quantity,
      reduceOnly: true,
    });
  }

  async getAccountBalance(): Promise<Array<{ asset: string; balance: string; availableBalance: string }>> {
    return this.signedRequest<Array<{ asset: string; balance: string; availableBalance: string }>>('GET', '/balance');
  }

  isHealthy(): boolean {
    return !this.circuit.isOpen();
  }
}
