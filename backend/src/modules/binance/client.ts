import crypto from 'crypto';
import fetch from 'node-fetch';
import type { Response } from 'node-fetch';
import Decimal from 'decimal.js';
import { config } from '../../config';
import { createContextLogger } from '../logger';
import { withRetry, CircuitBreaker } from '../utils/retry';
import type {
  SymbolInfo,
  Ticker24h,
  OrderRequest,
  OrderResult,
  PositionInfo,
  PositionSide,
  OrderType,
} from '../../types';

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
  orderId?: number;
  algoId?: number;
  clientOrderId?: string;
  clientAlgoId?: string;
  symbol: string;
  side: string;
  type?: string;
  orderType?: string;
  origQty?: string;
  quantity?: string;
  price?: string;
  stopPrice?: string;
  triggerPrice?: string;
  status?: string;
  algoStatus?: string;
  executedQty?: string;
  avgPrice?: string;
  updateTime?: number;
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

interface BinanceAccountInfo {
  totalWalletBalance: string;
  totalUnrealizedProfit: string;
  totalMarginBalance: string;
  availableBalance: string;
  totalPositionInitialMargin: string;
  totalMaintMargin: string;
  assets: Array<{
    asset: string;
    walletBalance: string;
    unrealizedProfit: string;
    marginBalance: string;
    availableBalance: string;
  }>;
}

const CONDITIONAL_TYPES = new Set(['STOP', 'STOP_MARKET', 'TAKE_PROFIT', 'TAKE_PROFIT_MARKET', 'TRAILING_STOP_MARKET']);

function toBinanceType(type: OrderType): string {
  return type === 'STOP_LIMIT' ? 'STOP' : type;
}

function fromBinanceType(type: string | undefined): OrderType {
  if (type === 'STOP') return 'STOP_LIMIT';
  return (type ?? 'MARKET') as OrderType;
}

function resolvePositionSide(req: OrderRequest, hedgeMode: boolean): PositionSide {
  if (req.positionSide != null) return req.positionSide;
  if (!hedgeMode) return 'BOTH';
  // V2: role SHORT → SHORT; LONG / legacy HEDGE → LONG
  return req.role === 'SHORT' ? 'SHORT' : 'LONG';
}

export class BinanceClient {
  private readonly baseUrl: string;
  private readonly circuit = new CircuitBreaker('BinanceRestApi', 5, 60000);
  private serverTimeDrift = 0;
  private hedgeMode = true;
  /** Tracks clientAlgoId → algoId for cancel */
  private algoIds = new Map<string, string>();

  constructor() {
    this.baseUrl = config.binance.futuresBaseUrl;
  }

  get hedgeModeEnabled(): boolean {
    return this.hedgeMode;
  }

  async initialize(): Promise<void> {
    await this.syncServerTime();
    try {
      await this.setHedgeMode(true);
    } catch (err) {
      log.warn('Could not enable hedge mode on init (may already be set)', { error: String(err) });
    }
    log.info('BinanceClient initialized', { baseUrl: this.baseUrl, hedgeMode: this.hedgeMode });
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

  private async signedRequest<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    params: Record<string, string | number | boolean> = {},
  ): Promise<T> {
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
        // Futures may use MIN_NOTIONAL or NOTIONAL
        const notionalFilter = s.filters.find(
          (f) => f.filterType === 'MIN_NOTIONAL' || f.filterType === 'NOTIONAL',
        );
        // Prefer exchange tickSize; never default to 0.01 (zeros micro-priced alts)
        const tickFromPrecision = s.pricePrecision > 0
          ? new Decimal(10).pow(-s.pricePrecision).toFixed()
          : '0.00000001';
        const tickSize = priceFilter?.tickSize && priceFilter.tickSize !== '0'
          ? priceFilter.tickSize
          : tickFromPrecision;
        const minNotional =
          notionalFilter?.notional
          ?? (notionalFilter as { minNotional?: string } | undefined)?.minNotional
          ?? '5';
        return {
          symbol: s.symbol,
          baseAsset: s.baseAsset,
          quoteAsset: s.quoteAsset,
          pricePrecision: s.pricePrecision,
          quantityPrecision: s.quantityPrecision,
          tickSize,
          stepSize: lotFilter?.stepSize ?? '0.001',
          minQty: lotFilter?.minQty ?? '0.001',
          minNotional,
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
      if (err instanceof BinanceApiError && err.code === -4046) return;
      throw err;
    }
  }

  /** dualSidePosition=true enables Hedge Mode (SHORT + LONG simultaneously). */
  async setHedgeMode(enabled: boolean): Promise<void> {
    try {
      await this.signedRequest<unknown>('POST', '/positionSide/dual', {
        dualSidePosition: enabled ? 'true' : 'false',
      });
      this.hedgeMode = enabled;
      log.info(`Hedge mode ${enabled ? 'ENABLED' : 'DISABLED'}`);
    } catch (err) {
      // -4059: no need to change position side
      if (err instanceof BinanceApiError && (err.code === -4059 || err.message.includes('No need to change'))) {
        this.hedgeMode = enabled;
        return;
      }
      throw err;
    }
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    const binanceType = toBinanceType(req.type);
    const positionSide = resolvePositionSide(req, this.hedgeMode);

    if (CONDITIONAL_TYPES.has(binanceType)) {
      return this.placeAlgoOrder(req, binanceType, positionSide);
    }
    return this.placeRegularOrder(req, binanceType, positionSide);
  }

  private async placeRegularOrder(
    req: OrderRequest,
    binanceType: string,
    positionSide: PositionSide,
  ): Promise<OrderResult> {
    const params: Record<string, string | number | boolean> = {
      symbol: req.symbol,
      side: req.side,
      type: binanceType,
      quantity: req.quantity,
      newClientOrderId: req.clientOrderId,
      newOrderRespType: 'RESULT',
      positionSide,
    };

    if (req.price != null) params.price = req.price;
    if (binanceType === 'LIMIT') params.timeInForce = 'GTC';
    // reduceOnly not allowed in Hedge Mode
    if (req.reduceOnly === true && !this.hedgeMode) params.reduceOnly = true;

    const res = await this.signedRequest<BinanceOrderResponse>('POST', '/order', params);
    return this.mapOrderResponse(res, req);
  }

  /**
   * Conditional orders MUST use Algo Order API (post Dec 2025 / -4120 migration).
   * POST /fapi/v1/algoOrder
   */
  private async placeAlgoOrder(
    req: OrderRequest,
    binanceType: string,
    positionSide: PositionSide,
  ): Promise<OrderResult> {
    const params: Record<string, string | number | boolean> = {
      algoType: 'CONDITIONAL',
      symbol: req.symbol,
      side: req.side,
      type: binanceType,
      quantity: req.quantity,
      clientAlgoId: req.clientOrderId,
      positionSide,
      workingType: 'MARK_PRICE',
      newOrderRespType: 'RESULT',
    };

    if (req.stopPrice != null) params.triggerPrice = req.stopPrice;
    if (req.price != null) params.price = req.price;
    if (binanceType === 'STOP' || binanceType === 'TAKE_PROFIT') {
      params.timeInForce = 'GTC';
    }
    if (req.reduceOnly === true && !this.hedgeMode) params.reduceOnly = true;

    try {
      const res = await this.signedRequest<BinanceOrderResponse>('POST', '/algoOrder', params);
      if (res.algoId != null) {
        this.algoIds.set(req.clientOrderId, String(res.algoId));
      }
      return this.mapAlgoResponse(res, req, binanceType);
    } catch (err) {
      // Fallback for older testnets that still accept /order for conditionals
      if (err instanceof BinanceApiError && err.code !== -4120) {
        log.warn('Algo order failed — falling back to /order', { error: err.message, code: err.code });
        return this.placeRegularOrderAsConditional(req, binanceType, positionSide);
      }
      throw err;
    }
  }

  private async placeRegularOrderAsConditional(
    req: OrderRequest,
    binanceType: string,
    positionSide: PositionSide,
  ): Promise<OrderResult> {
    const params: Record<string, string | number | boolean> = {
      symbol: req.symbol,
      side: req.side,
      type: binanceType,
      quantity: req.quantity,
      newClientOrderId: req.clientOrderId,
      newOrderRespType: 'RESULT',
      positionSide,
      workingType: 'MARK_PRICE',
    };
    if (req.stopPrice != null) params.stopPrice = req.stopPrice;
    if (req.price != null) params.price = req.price;
    if (binanceType === 'STOP' || binanceType === 'TAKE_PROFIT' || binanceType === 'LIMIT') {
      params.timeInForce = 'GTC';
    }
    if (req.reduceOnly === true && !this.hedgeMode) params.reduceOnly = true;
    const res = await this.signedRequest<BinanceOrderResponse>('POST', '/order', params);
    return this.mapOrderResponse(res, req);
  }

  private mapOrderResponse(res: BinanceOrderResponse, req: OrderRequest): OrderResult {
    return {
      clientOrderId: res.clientOrderId ?? req.clientOrderId,
      exchangeOrderId: String(res.orderId ?? ''),
      symbol: res.symbol,
      side: res.side as OrderResult['side'],
      type: fromBinanceType(res.type),
      status: (res.status ?? 'NEW') as OrderResult['status'],
      quantity: res.origQty ?? req.quantity,
      price: res.price && res.price !== '0' ? res.price : req.price ?? null,
      stopPrice: res.stopPrice && res.stopPrice !== '0' ? res.stopPrice : req.stopPrice ?? null,
      filledQuantity: res.executedQty ?? '0',
      avgFillPrice: res.avgPrice ?? null,
      fee: res.commission ?? '0',
      feeCurrency: res.commissionAsset ?? 'USDT',
      createdAt: new Date(),
      filledAt: res.executedQty != null && res.executedQty === (res.origQty ?? req.quantity)
        ? new Date(res.updateTime ?? Date.now())
        : null,
    };
  }

  private mapAlgoResponse(res: BinanceOrderResponse, req: OrderRequest, binanceType: string): OrderResult {
    const algoStatus = (res.algoStatus ?? res.status ?? 'NEW').toUpperCase();
    // Map algo statuses to our OrderStatus
    let status: OrderResult['status'] = 'PENDING';
    if (algoStatus === 'NEW' || algoStatus === 'WORKING') status = 'PENDING';
    else if (algoStatus === 'TRIGGERED') status = 'TRIGGERED';
    else if (algoStatus === 'FILLED') status = 'FILLED';
    else if (algoStatus === 'CANCELED' || algoStatus === 'CANCELLED') status = 'CANCELED';
    else if (algoStatus === 'REJECTED') status = 'REJECTED';
    else if (algoStatus === 'EXPIRED') status = 'EXPIRED';
    else status = 'PENDING';

    return {
      clientOrderId: res.clientAlgoId ?? req.clientOrderId,
      exchangeOrderId: String(res.algoId ?? res.orderId ?? ''),
      symbol: res.symbol,
      side: res.side as OrderResult['side'],
      type: fromBinanceType(res.orderType ?? res.type ?? binanceType),
      status,
      quantity: res.quantity ?? res.origQty ?? req.quantity,
      price: res.price && res.price !== '0' ? res.price : req.price ?? null,
      stopPrice: res.triggerPrice ?? res.stopPrice ?? req.stopPrice ?? null,
      filledQuantity: res.executedQty ?? '0',
      avgFillPrice: res.avgPrice ?? null,
      fee: res.commission ?? '0',
      feeCurrency: res.commissionAsset ?? 'USDT',
      createdAt: new Date(),
      filledAt: status === 'FILLED' ? new Date() : null,
    };
  }

  async cancelOrder(symbol: string, clientOrderId: string): Promise<void> {
    const algoId = this.algoIds.get(clientOrderId);
    // Try algo cancel first if we know it's an algo order
    if (algoId != null) {
      try {
        await this.signedRequest<unknown>('DELETE', '/algoOrder', { symbol, algoId });
        this.algoIds.delete(clientOrderId);
        log.info(`Cancelled algo order ${clientOrderId}`);
        return;
      } catch (err) {
        log.debug('Algo cancel by id failed, trying clientAlgoId', { error: String(err) });
      }
    }

    try {
      await this.signedRequest<unknown>('DELETE', '/algoOrder', {
        symbol,
        clientAlgoId: clientOrderId,
      });
      this.algoIds.delete(clientOrderId);
      log.info(`Cancelled algo order by clientAlgoId ${clientOrderId}`);
      return;
    } catch {
      // Fall through to regular cancel
    }

    await this.signedRequest<unknown>('DELETE', '/order', {
      symbol,
      origClientOrderId: clientOrderId,
    });
    log.info(`Cancelled order ${clientOrderId} for ${symbol}`);
  }

  async cancelAllOpenOrders(symbol: string): Promise<void> {
    await Promise.allSettled([
      this.signedRequest<unknown>('DELETE', '/allOpenOrders', { symbol }),
      this.signedRequest<unknown>('DELETE', '/algoOpenOrders', { symbol }),
    ]);
    log.info(`Cancelled all open + algo orders for ${symbol}`);
  }

  async getOpenOrders(symbol: string): Promise<BinanceOrderResponse[]> {
    return this.signedRequest<BinanceOrderResponse[]>('GET', '/openOrders', { symbol });
  }

  async getOpenAlgoOrders(symbol?: string): Promise<BinanceOrderResponse[]> {
    const params: Record<string, string> = {};
    if (symbol != null) params.symbol = symbol;
    try {
      return await this.signedRequest<BinanceOrderResponse[]>('GET', '/openAlgoOrders', params);
    } catch {
      return [];
    }
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
      .map((p) => {
        const amt = parseFloat(p.positionAmt);
        let side: PositionInfo['side'] = amt >= 0 ? 'LONG' : 'SHORT';
        if (p.positionSide === 'LONG' || p.positionSide === 'SHORT') {
          side = p.positionSide;
        }
        return {
          symbol: p.symbol,
          side,
          entryPrice: p.entryPrice,
          quantity: Math.abs(amt).toString(),
          unrealizedPnl: p.unRealizedProfit,
          leverage: parseInt(p.leverage, 10),
          liquidationPrice: p.liquidationPrice,
          markPrice: p.markPrice,
        };
      });
  }

  async closePosition(symbol: string, side: 'LONG' | 'SHORT', quantity: string): Promise<OrderResult> {
    const closeSide = side === 'LONG' ? 'SELL' : 'BUY';
    return this.placeOrder({
      traderId: '',
      clientOrderId: `close_${symbol}_${Date.now()}`,
      symbol,
      side: closeSide,
      type: 'MARKET',
      role: side === 'LONG' ? 'HEDGE' : 'SHORT',
      hedgeLevel: 0,
      quantity,
      positionSide: this.hedgeMode ? side : 'BOTH',
      reduceOnly: !this.hedgeMode,
    });
  }

  async getAccountBalance(): Promise<Array<{ asset: string; balance: string; availableBalance: string }>> {
    return this.signedRequest<Array<{ asset: string; balance: string; availableBalance: string }>>('GET', '/balance');
  }

  /** Full account snapshot for live reconciliation (uses /fapi/v2/account). */
  async getAccountInfo(): Promise<{
    walletBalance: string;
    unrealizedProfit: string;
    marginBalance: string;
    availableBalance: string;
    positionInitialMargin: string;
    maintMargin: string;
  }> {
    try {
      // baseUrl ends with /fapi/v1 — swap to v2 for account endpoint
      const v2Base = this.baseUrl.replace(/\/fapi\/v1\/?$/, '/fapi/v2');
      const timestamped = { timestamp: this.getTimestamp(), recvWindow: 5000 };
      const signed = this.sign(timestamped);
      const res = await fetch(`${v2Base}/account?${signed}`, {
        headers: { 'X-MBX-APIKEY': config.binance.apiKey },
      });
      const acc = await this.parseResponse<BinanceAccountInfo>(res);
      const usdt = acc.assets?.find((a) => a.asset === 'USDT');
      return {
        walletBalance: usdt?.walletBalance ?? acc.totalWalletBalance ?? '0',
        unrealizedProfit: usdt?.unrealizedProfit ?? acc.totalUnrealizedProfit ?? '0',
        marginBalance: usdt?.marginBalance ?? acc.totalMarginBalance ?? '0',
        availableBalance: usdt?.availableBalance ?? acc.availableBalance ?? '0',
        positionInitialMargin: acc.totalPositionInitialMargin ?? '0',
        maintMargin: acc.totalMaintMargin ?? '0',
      };
    } catch (err) {
      log.warn('v2 account fetch failed, falling back to /balance', { error: String(err) });
      const balances = await this.getAccountBalance();
      const usdt = balances.find((b) => b.asset === 'USDT');
      return {
        walletBalance: usdt?.balance ?? '0',
        unrealizedProfit: '0',
        marginBalance: usdt?.balance ?? '0',
        availableBalance: usdt?.availableBalance ?? '0',
        positionInitialMargin: '0',
        maintMargin: '0',
      };
    }
  }

  /**
   * Income history for realized PnL reconciliation (REALIZED_PNL + COMMISSION).
   */
  async getIncome(params?: {
    symbol?: string;
    incomeType?: string;
    startTime?: number;
    endTime?: number;
    limit?: number;
  }): Promise<Array<{ symbol: string; incomeType: string; income: string; time: number }>> {
    const q: Record<string, string | number | boolean> = {
      limit: params?.limit ?? 1000,
    };
    if (params?.symbol != null) q.symbol = params.symbol;
    if (params?.incomeType != null) q.incomeType = params.incomeType;
    if (params?.startTime != null) q.startTime = params.startTime;
    if (params?.endTime != null) q.endTime = params.endTime;
    return this.signedRequest('GET', '/income', q);
  }

  isHealthy(): boolean {
    return !this.circuit.isOpen();
  }
}
