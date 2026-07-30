// Shared domain types for the entire backend

export type TraderStatus = 'INITIALIZING' | 'ACTIVE' | 'PAUSED' | 'COMPLETING' | 'COMPLETED' | 'FAILED';
export type TraderMode = 'LIVE' | 'SIMULATION';
export type OrderSide = 'BUY' | 'SELL';
export type OrderType = 'MARKET' | 'LIMIT' | 'STOP_LIMIT' | 'TAKE_PROFIT' | 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
export type OrderStatus = 'PENDING' | 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'REJECTED' | 'EXPIRED';
export type PositionSide = 'LONG' | 'SHORT' | 'BOTH';
export type HedgeRole = 'SHORT' | 'HEDGE';
export type MarginMode = 'ISOLATED' | 'CROSSED';

export interface SymbolInfo {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  pricePrecision: number;
  quantityPrecision: number;
  tickSize: string;
  stepSize: string;
  minQty: string;
  minNotional: string;
  maxLeverage: number;
  contractType: string;
  status: string;
}

export interface Ticker24h {
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

export interface OrderRequest {
  traderId: string;
  clientOrderId: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  role: HedgeRole;
  hedgeLevel: number;
  quantity: string;
  price?: string;
  stopPrice?: string;
  reduceOnly?: boolean;
}

export interface OrderResult {
  clientOrderId: string;
  exchangeOrderId: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  status: OrderStatus;
  quantity: string;
  price?: string;
  stopPrice?: string;
  filledQuantity: string;
  avgFillPrice?: string;
  fee: string;
  feeCurrency: string;
  createdAt: Date;
  filledAt?: Date;
}

export interface CancelOrderRequest {
  symbol: string;
  clientOrderId: string;
  exchangeOrderId?: string;
}

export interface PositionInfo {
  symbol: string;
  side: PositionSide;
  entryPrice: string;
  quantity: string;
  unrealizedPnl: string;
  leverage: number;
  liquidationPrice: string;
  markPrice: string;
}

export interface TraderConfig {
  maxTraders: number;
  initialCapital: string;
  positionSize: string;
  leverage: number;
  marginMode: MarginMode;
  hedgeDistance: string;
  hedgeTpPercent: string;
  hedgeSlPercent: string;
  shortTpPercent: string;
  refreshInterval: number;
  retryLimit: number;
  feeRate: string;
  slippage: string;
  mode: TraderMode;
}

export interface HedgeLevel {
  level: number;
  entryPrice: string;
  stopPrice: string;
  tpPrice: string;
  status: 'PENDING' | 'ACTIVE' | 'HIT_TP' | 'HIT_SL' | 'CANCELED';
}

export interface TraderState {
  id: string;
  symbol: string;
  mode: TraderMode;
  status: TraderStatus;
  leverage: number;
  marginMode: string;
  initialCapital: string;
  positionSize: string;
  shortEntryPrice: string | null;
  shortTpPrice: string | null;
  currentHedgeLevel: number;
  hedgeLevels: HedgeLevel[];
  realizedPnl: string;
  unrealizedPnl: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface PriceUpdate {
  symbol: string;
  price: string;
  timestamp: number;
}

export interface OrderUpdate {
  clientOrderId: string;
  exchangeOrderId: string;
  symbol: string;
  status: OrderStatus;
  filledQuantity: string;
  avgFillPrice?: string;
  fee?: string;
  feeCurrency?: string;
  timestamp: number;
}

export interface WebSocketEvent {
  type: 'PRICE_UPDATE' | 'ORDER_UPDATE' | 'ACCOUNT_UPDATE';
  data: PriceUpdate | OrderUpdate | AccountUpdate;
}

export interface AccountUpdate {
  balances: Array<{ asset: string; balance: string; availableBalance: string }>;
  positions: PositionInfo[];
  timestamp: number;
}

export interface SystemHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  uptime: number;
  database: boolean;
  redis: boolean;
  binanceApi: boolean;
  binanceWs: boolean;
  activeTraders: number;
  cpuPercent: number;
  memoryMb: number;
  timestamp: Date;
}

export interface DashboardSummary {
  activeTraders: number;
  totalTraders: number;
  completedTraders: number;
  topGainers: Ticker24h[];
  activeSymbols: string[];
  realizedPnl: string;
  unrealizedPnl: string;
  dailyPnl: string;
  winRate: string;
  health: SystemHealth;
}
