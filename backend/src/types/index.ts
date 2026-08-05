// Shared domain types for the entire backend

export type TraderStatus = 'INITIALIZING' | 'ACTIVE' | 'PAUSED' | 'COMPLETING' | 'COMPLETED' | 'FAILED';
export type TraderMode = 'LIVE' | 'SIMULATION';
export type OrderSide = 'BUY' | 'SELL';
export type OrderType = 'MARKET' | 'LIMIT' | 'STOP_LIMIT' | 'TAKE_PROFIT' | 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
/**
 * Order lifecycle (Binance-aligned + TRIGGERED for stop→limit activation):
 * PENDING → (stop touched) → TRIGGERED → FILLED | CANCELED | REJECTED | EXPIRED
 * MARKET orders go straight to FILLED (or NEW briefly).
 */
export type OrderStatus =
  | 'PENDING'
  | 'NEW'
  | 'TRIGGERED'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'CANCELED'
  | 'REJECTED'
  | 'EXPIRED';

/** Human-readable phase for dashboard (derived from OrderStatus + position). */
export type OrderLifecyclePhase =
  | 'PENDING'
  | 'TRIGGERED'
  | 'FILLED'
  | 'OPEN_POSITION'
  | 'CLOSED'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'REJECTED';
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
  /**
   * Binance Hedge Mode: LONG | SHORT required.
   * One-way Mode: BOTH (default).
   * Derived from role when omitted: SHORT→SHORT, HEDGE→LONG.
   */
  positionSide?: PositionSide;
}

export interface OrderResult {
  clientOrderId: string;
  exchangeOrderId: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  status: OrderStatus;
  quantity: string;
  price: string | null;
  stopPrice: string | null;
  filledQuantity: string;
  avgFillPrice: string | null;
  fee: string;
  feeCurrency: string;
  createdAt: Date;
  filledAt: Date | null;
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
  /**
   * Position stop-loss = hedgeEntry × (1 − hedgeSlPercent).
   * NOT the STOP-LIMIT trigger (that equals entryPrice).
   */
  stopPrice: string;
  /**
   * Previous reference used to derive entry (short entry for L1, prior hedge TP for L2+).
   * Informational — not the position SL.
   */
  previousLevelPrice: string;
  tpPrice: string;
  /** Sized independently from main short via hedge allocation × leverage. */
  quantity: string;
  /**
   * Strategy phase (engine SSOT):
   * PENDING   — STOP-LIMIT resting; stop not reached
   * TRIGGERED — stop hit; limit order active
   * OPEN      — long position filled
   * HIT_TP / HIT_SL / CANCELED — terminal
   */
  status: 'PENDING' | 'TRIGGERED' | 'OPEN' | 'HIT_TP' | 'HIT_SL' | 'CANCELED';
  /** Entry STOP-LIMIT order status from the order book (mirrors OrderStatus). */
  entryOrderStatus?: OrderStatus | null;
}

/** Hedge lifecycle counters — engine SSOT for dashboard. */
export interface HedgeLifecycleStats {
  currentHedgeNumber: number;
  ordersCreated: number;
  ordersTriggered: number;
  positionsOpened: number;
  positionsClosed: number;
  stopLosses: number;
  takeProfits: number;
  recreations: number;
  pendingOrders: number;
  activePositions: number;
}

/** Compact trader view for REST + dashboard WebSocket snapshots. */
export interface TraderSummaryView {
  id: string;
  symbol: string;
  status: TraderStatus;
  realizedPnl: string;
  unrealizedPnl: string;
  /** Main short unrealized only */
  shortUnrealizedPnl: string;
  hedgeLevel: number;
  /** @deprecated use hedgeStats.stopLosses */
  hedgeLosses: number;
  /** @deprecated use hedgeStats.takeProfits */
  hedgeWins: number;
  entryPrice: string | null;
  tpPrice: string | null;
  /** Main short has no SL by strategy design */
  shortSl: null;
  markPrice: string;
  shortQuantity: string | null;
  openOrders: number;
  pendingOrders: number;
  closedOrders: number;
  /** @deprecated use hedgeStats.recreations */
  hedgeRecreates: number;
  /** Full hedge lifecycle stats (SSOT). */
  hedgeStats: HedgeLifecycleStats;
  /** Distance from mark to short TP as fraction of entry (positive = still above TP for short) */
  distanceToTpPct: string | null;
  distanceToTpAbs: string | null;
  /** realized + unrealized — computed only in the engine */
  totalPnl: string;
  hedgeUnrealizedPnl: string;
  orders: Array<{
    clientOrderId: string;
    role: HedgeRole;
    type: OrderType;
    status: OrderStatus;
    side: OrderSide;
    price: string | null;
    stopPrice: string | null;
    hedgeLevel: number;
    quantity: string;
  }>;
  hedgeLevels: HedgeLevel[];
}

export type DashboardEvent =
  | { type: 'STATUS_CHANGED'; traderId: string; status: TraderStatus }
  | { type: 'COMPLETED'; traderId: string; symbol: string }
  | { type: 'FAILED'; traderId: string; symbol: string; error: string }
  | { type: 'PNL_UPDATE'; traderId: string; realizedPnl: string; unrealizedPnl: string; totalPnl: string }
  | { type: 'TRADER_SNAPSHOT'; trader: TraderSummaryView }
  | {
      type: 'SUMMARY';
      data: {
        balance: string;
        equity: string;
        totalPnl: string;
        totalRealizedPnl: string;
        totalUnrealizedPnl: string;
        dailyPnl: string;
        openPositionValue: string;
        usedMargin: string;
        availableMargin: string;
        openPositions: number;
        activeTraders: number;
        maxTraders: number;
        topGainers: Ticker24h[];
        tradingMode: TraderMode;
        botStatus: string;
      };
    };

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
  avgFillPrice: string | null;
  fee: string | null;
  feeCurrency: string | null;
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
