// Shared domain types for the entire backend — Strategy V2 (position reversal)

export type TraderStatus = 'INITIALIZING' | 'ACTIVE' | 'PAUSED' | 'COMPLETING' | 'COMPLETED' | 'FAILED';
export type TraderMode = 'LIVE' | 'SIMULATION';
/** Strategy behavior — this branch is grid-only. */
export type TraderBehavior = 'grid_directional';
export type OrderSide = 'BUY' | 'SELL';
export type OrderType = 'MARKET' | 'LIMIT' | 'STOP_LIMIT' | 'TAKE_PROFIT' | 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
export type OrderStatus =
  | 'PENDING'
  | 'NEW'
  | 'TRIGGERED'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'CANCELED'
  | 'REJECTED'
  | 'EXPIRED';

export type PositionSide = 'LONG' | 'SHORT' | 'BOTH';
/** Order/position role — ENTRY for the single active position (legacy HEDGE = LONG). */
export type HedgeRole = 'SHORT' | 'HEDGE' | 'LONG';
export type MarginMode = 'ISOLATED' | 'CROSSED';
export type TradeSide = 'LONG' | 'SHORT';
export type CloseReason = 'TP' | 'SL' | 'FORCE' | 'EXPIRED';

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
  /** Position number (1-based). */
  hedgeLevel: number;
  quantity: string;
  price?: string;
  stopPrice?: string;
  reduceOnly?: boolean;
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
  /** Trader lifetime in hours (default 24). */
  traderLifetimeHours: number;
  takeProfitPercent: string;
  stopLossPercent: string;
  startingSide: TradeSide;
  /** Number of capital steps from allocation (default 5). */
  capitalSteps: number;
  /**
   * When true: TP → opposite side, SL → same side.
   * When false (default): TP → same side, SL → opposite (legacy).
   */
  switchPositionOnTakeProfit: boolean;
  /** Strategy behavior — always grid directional on this branch. */
  traderBehavior: TraderBehavior;
  /** Grid levels above and below start price (default 10). */
  gridLevelsPerSide: number;
  /** Distance between grid levels in percent points (e.g. '5' = 5%). */
  gridDistancePercent: string;
  /** Grid directional take-profit in percent points (e.g. '10' = 10%). */
  traderTakeProfitPercent: string;
  /** Max lifetime for grid directional traders in hours (default 12). */
  traderMaxLifetimeHours: number;
  refreshInterval: number;
  retryLimit: number;
  feeRate: string;
  /** Binance Futures maker fee (decimal). Default 0.0002 = 0.02%. */
  makerFeeRate: string;
  /** Binance Futures taker fee (decimal). Default 0.0005 = 0.05%. */
  takerFeeRate: string;
  slippage: string;
  mode: TraderMode;
  /** @deprecated unused in V2 — kept for hot-apply compatibility */
  hedgeDistance?: string;
  hedgeTpPercent?: string;
  hedgeSlPercent?: string;
  shortTpPercent?: string;
}

/** Closed / active position record for timeline. */
export interface PositionTimelineEntry {
  number: number;
  side: TradeSide;
  capitalStep: number;
  stepAmount: string;
  entryPrice: string;
  exitPrice: string | null;
  quantity: string;
  leverage: number;
  takeProfit: string | null;
  stopLoss: string | null;
  /** @deprecated prefer totalFees */
  fees: string | null;
  entryFee: string | null;
  exitFee: string | null;
  totalFees: string | null;
  grossPnl: string | null;
  /** Net = gross − entryFee − exitFee */
  realizedPnl: string | null;
  closeReason: CloseReason | null;
  openedAt: string;
  closedAt: string | null;
}

/** Live open position view. */
export interface CurrentPositionView {
  number: number;
  side: TradeSide;
  capitalStep: number;
  /** USD margin used for this position (historical step amount). */
  stepAmount: string;
  /** Notional = stepAmount × leverage. */
  positionNotional: string;
  entryPrice: string;
  quantity: string;
  tpPrice: string;
  /** @deprecated grid strategy has no SL — may be empty/null */
  slPrice?: string | null;
  /** Gross unrealized (price MTM only). */
  unrealizedPnl: string;
  /** Estimated exit fee at mark (taker). */
  estimatedExitFee: string;
  /** Gross unrealized − entryFee − estimatedExitFee. */
  netUnrealizedPnl: string;
  entryFee: string;
  roiPercent: string;
  status: 'OPEN' | 'SUBMITTED';
}

export interface CapitalStepView {
  step: number;
  amount: string;
  isCurrent: boolean;
}

/** Capital step progression SSOT for dashboard. */
export interface CapitalProgressView {
  /** Frozen original USD allocation for this trader (not PnL / equity). */
  traderAllocatedAmount: string;
  /** Alias of capitalSteps — total steps in the ladder. */
  totalSteps: number;
  capitalSteps: number;
  currentStep: number;
  /** USD margin for the current step (allocation × step / totalSteps). */
  currentStepAllocation: string;
  /** @deprecated use currentStepAllocation — kept for compatibility */
  currentStepAmount: string;
  /** Notional = currentStepAllocation × leverage (not the same as allocation). */
  positionNotional: string;
  steps: CapitalStepView[];
  highestStepReached: number;
  lowestStepReached: number;
  stepIncreases: number;
  stepDecreases: number;
  /** SL → Step 1 transitions (one per SL, not per intermediate level). */
  stepResets: number;
  step1Trades: number;
  maxStepTrades: number;
}

export interface TraderLifecycleStats {
  startedAt: string | null;
  endsAt: string | null;
  remainingMs: number;
  runtimeMs: number;
  currentPositionNumber: number;
  positionsOpened: number;
  positionsClosed: number;
  winningPositions: number;
  losingPositions: number;
  takeProfits: number;
  stopLosses: number;
  longPositions: number;
  shortPositions: number;
  winRate: string;
  /** Gross price PnL before fees (= net + fees). */
  grossRealizedPnl: string;
  /** Cumulative trading fees (entry + exit). */
  totalFees: string;
  /** Cumulative net = gross − fees (matches realizedPnl on trader). */
  netRealizedPnl: string;
  currentStep: number;
  highestStepReached: number;
  lowestStepReached: number;
  stepIncreases: number;
  stepDecreases: number;
  stepResets: number;
  step1Trades: number;
  maxStepTrades: number;
}

export interface GridLevelView {
  level: number;
  direction: 'LONG' | 'SHORT';
  triggerPrice: string;
  limitPrice: string;
  /** Capital margin for this level (not exposure). */
  allocatedMargin: string;
  /** Market exposure = margin × leverage (or entry × qty when filled). */
  notional: string;
  leverage: number;
  quantity: string;
  status: string;
  entryPrice: string | null;
  unrealizedPnl: string | null;
  tpPrice?: string | null;
  slPrice?: string | null;
  weight?: number;
  allocationPct?: string | null;
  completionReason?: string | null;
}

export interface GridTraderView {
  startPrice: string;
  levelsPerSide: number;
  distancePercent: string;
  takeProfitPercent: string;
  longFilled: number;
  shortFilled: number;
  levels: GridLevelView[];
  profitPercent: string;
  exitReason: string | null;
  currentCapital?: string;
  initialCapital?: string;
  gridDistanceAbs?: string;
  /** currentCapital + unrealized (presentation equity) */
  equity?: string;
  /** Always 1 — at most one open position per side. */
  maxPerSide?: number;
  /** Structural max = 1 LONG + 1 SHORT. */
  maxOpenPositions?: number;
  activeOpenCount?: number;
  longOpen?: number;
  shortOpen?: number;
  capitalHistory?: Array<{ at: string; capital: string; event: string; netPnl?: string }>;
  /** Absolute net-PnL target = initialCapital × takeProfitPercent / 100 (frozen). */
  traderTpTarget?: string;
  /** Combined realized + open net PnL (fees included). */
  traderTpCurrentPnl?: string;
  /** Progress toward trader TP (0–100). */
  traderTpProgress?: string;
  /** Whether combined net PnL has reached traderTpTarget. */
  traderTpReached?: boolean;
}

/** Compact trader view for REST + dashboard WebSocket snapshots. */
export interface TraderSummaryView {
  id: string;
  symbol: string;
  status: TraderStatus;
  /** Net realized PnL after fees. */
  realizedPnl: string;
  unrealizedPnl: string;
  totalPnl: string;
  /** Gross realized (price PnL only). */
  grossRealizedPnl: string;
  totalFees: string;
  markPrice: string;
  leverage: number;
  capital: CapitalProgressView;
  currentPosition: CurrentPositionView | null;
  /** All open grid positions (0–maxOpen). */
  currentPositions?: CurrentPositionView[];
  stats: TraderLifecycleStats;
  timeline: PositionTimelineEntry[];
  distanceToTpPct: string | null;
  distanceToTpAbs: string | null;
  distanceToSlPct: string | null;
  distanceToSlAbs: string | null;
  openOrders: number;
  pendingOrders: number;
  closedOrders: number;
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
  /** Strategy label — e.g. grid_directional */
  behavior?: string;
  /** Present when behavior is grid_directional */
  grid?: GridTraderView;
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
        /** Active strategy: reversal | grid_directional */
        traderBehavior?: string;
        currentBalance?: string;
        highestBalance24h?: string;
        lowestBalance24h?: string;
      };
    };

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

export interface PriceUpdate {
  symbol: string;
  price: string;
  timestamp: number;
}

export interface AccountUpdate {
  balances: Array<{ asset: string; balance: string; availableBalance: string }>;
  positions: Array<{
    symbol: string;
    side: 'LONG' | 'SHORT';
    entryPrice: string;
    quantity: string;
    unrealizedPnl: string;
    leverage: number;
    liquidationPrice: string;
    markPrice: string;
  }>;
  timestamp: number;
}

export interface AccountInfo {
  totalWalletBalance: string;
  availableBalance: string;
  totalUnrealizedProfit: string;
  totalMarginBalance: string;
  positions: PositionInfo[];
}

export interface SystemHealth {
  status: string;
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
