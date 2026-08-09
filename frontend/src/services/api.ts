import axios from 'axios';

const BASE_URL = import.meta.env.VITE_API_URL ?? '/api';

export const apiClient = axios.create({
  baseURL: BASE_URL,
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' },
});

apiClient.interceptors.response.use(
  (res) => res,
  (err: unknown) => {
    if (axios.isAxiosError(err)) {
      const message = (err.response?.data as { error?: string })?.error ?? err.message;
      return Promise.reject(new Error(message));
    }
    return Promise.reject(err);
  },
);

// Trader endpoints
export const tradersApi = {
  getAll: () => apiClient.get<ApiResponse<Trader[]>>('/traders'),
  getActive: () => apiClient.get<ApiResponse<TraderSummary[]>>('/traders/active'),
  getById: (id: string) => apiClient.get<ApiResponse<TraderDetail>>(`/traders/${id}`),
  pause: () => apiClient.post('/traders/pause'),
  resume: () => apiClient.post('/traders/resume'),
  emergencyStop: () => apiClient.post('/traders/emergency-stop'),
};

// Orders endpoints
export const ordersApi = {
  getAll: (params?: { traderId?: string; status?: string; symbol?: string }) =>
    apiClient.get<ApiResponse<Order[]>>('/orders', { params }),
  getById: (id: string) => apiClient.get<ApiResponse<Order>>(`/orders/${id}`),
};

// Statistics endpoints
export const statisticsApi = {
  getGlobal: () => apiClient.get<ApiResponse<GlobalStats>>('/statistics'),
  getSummary: () => apiClient.get<ApiResponse<StatsSummary>>('/statistics/summary'),
  getByTraderId: (id: string) => apiClient.get<ApiResponse<TraderStats>>(`/statistics/traders/${id}`),
};

// System endpoints
export const systemApi = {
  getHealth: () => apiClient.get<ApiResponse<SystemHealth>>('/system/health'),
  getLogs: (params?: { level?: string; limit?: number }) =>
    apiClient.get<ApiResponse<AppLog[]>>('/system/logs', { params }),
};

// Config endpoints
export const configApi = {
  get: () => apiClient.get<ApiResponse<Configuration>>('/config'),
  update: (data: Partial<Configuration>) => apiClient.patch<ApiResponse<Configuration>>('/config', data),
};

// Types
export interface ApiResponse<T> {
  success: boolean;
  data: T;
  error?: string;
}

export interface Trader {
  id: string;
  symbol: string;
  mode: string;
  status: string;
  leverage: number;
  marginMode: string;
  initialCapital: string;
  positionSize: string;
  entryPrice: string | null;
  tpPrice: string | null;
  slPrice: string | null;
  currentSide: 'LONG' | 'SHORT' | null;
  currentPositionNumber: number;
  realizedPnl: string;
  unrealizedPnl: string;
  startedAt: string | null;
  endsAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TraderOrderView {
  clientOrderId: string;
  role: string;
  type: string;
  status: string;
  side: string;
  price: string | null;
  stopPrice: string | null;
  hedgeLevel: number;
  quantity: string;
}

export interface CurrentPositionView {
  number: number;
  side: 'LONG' | 'SHORT';
  capitalStep: number;
  stepAmount: string;
  positionNotional: string;
  entryPrice: string;
  quantity: string;
  tpPrice: string;
  slPrice: string;
  unrealizedPnl: string;
  roiPercent: string;
  status: 'OPEN' | 'SUBMITTED';
}

export interface CapitalStepView {
  step: number;
  amount: string;
  isCurrent: boolean;
}

export interface CapitalProgressView {
  traderAllocatedAmount: string;
  totalSteps: number;
  capitalSteps: number;
  currentStep: number;
  currentStepAllocation: string;
  currentStepAmount: string;
  positionNotional: string;
  steps: CapitalStepView[];
  highestStepReached: number;
  lowestStepReached: number;
  stepIncreases: number;
  stepDecreases: number;
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
  totalFees: string;
  currentStep: number;
  highestStepReached: number;
  lowestStepReached: number;
  stepIncreases: number;
  stepDecreases: number;
  step1Trades: number;
  maxStepTrades: number;
}

export interface PositionTimelineEntry {
  number: number;
  side: 'LONG' | 'SHORT';
  capitalStep: number;
  stepAmount: string;
  entryPrice: string;
  exitPrice: string | null;
  quantity: string;
  leverage?: number;
  takeProfit?: string | null;
  stopLoss?: string | null;
  fees?: string | null;
  closeReason: 'TP' | 'SL' | 'FORCE' | 'EXPIRED' | null;
  realizedPnl: string | null;
  openedAt: string;
  closedAt: string | null;
}

export interface TraderSummary {
  id: string;
  symbol: string;
  status: string;
  realizedPnl: string;
  unrealizedPnl: string;
  totalPnl: string;
  markPrice: string;
  leverage: number;
  capital: CapitalProgressView;
  currentPosition: CurrentPositionView | null;
  stats: TraderLifecycleStats;
  timeline: PositionTimelineEntry[];
  distanceToTpPct?: string | null;
  distanceToTpAbs?: string | null;
  distanceToSlPct?: string | null;
  distanceToSlAbs?: string | null;
  openOrders?: number;
  pendingOrders?: number;
  closedOrders?: number;
  orders?: TraderOrderView[];
}

export interface TraderDetail extends Trader {
  orders: Order[];
  positions: Position[];
  trades: Trade[];
  statistics: TraderStats | null;
}

export interface Order {
  id: string;
  traderId: string;
  clientOrderId: string;
  exchangeOrderId: string | null;
  symbol: string;
  side: string;
  type: string;
  status: string;
  role: string;
  hedgeLevel: number;
  quantity: string;
  price: string | null;
  stopPrice: string | null;
  filledQuantity: string;
  avgFillPrice: string | null;
  fee: string;
  createdAt: string;
  filledAt: string | null;
}

export interface Position {
  id: string;
  symbol: string;
  side: string;
  role: string;
  entryPrice: string;
  quantity: string;
  unrealizedPnl: string;
  isOpen: boolean;
}

export interface Trade {
  id: string;
  symbol: string;
  side: string;
  quantity: string;
  price: string;
  fee: string;
  realizedPnl: string;
  tradeTime: string;
}

export interface GlobalStats {
  totalTraders: number;
  activeTraders: number;
  completedTraders: number;
  balance?: string;
  equity?: string;
  totalRealizedPnl: string;
  totalUnrealizedPnl?: string;
  totalPnl?: string;
  totalFees: string;
  dailyPnl: string;
  openPositionValue?: string;
  usedMargin?: string;
  availableMargin?: string;
  winRate: string;
  totalEquity?: string;
  equityPerTrader: string;
  positionEquity: string;
  positionNotional: string;
  maxTraders: number;
  leverage: number;
  tradingMode: string;
}

export interface StatsSummary {
  balance?: string;
  equity?: string;
  dailyPnl?: string;
  activeTraders: number;
  maxTraders?: number;
  openPositions?: number;
  openPositionValue?: string;
  usedMargin?: string;
  availableMargin?: string;
  topGainers: Ticker[];
  totalEquity?: string;
  totalPnl?: string;
  totalRealizedPnl: string;
  totalUnrealizedPnl: string;
  tradingMode?: string;
  botStatus?: string;
  equityPerTrader?: string;
  positionNotional?: string;
  leverage?: number;
  traders?: TraderSummary[];
}

export interface Ticker {
  symbol: string;
  priceChangePercent: string;
  lastPrice: string;
}

export interface TraderStats {
  traderId: string;
  symbol: string;
  mode: string;
  totalHedgeLevels: number;
  hedgeWins: number;
  hedgeLosses: number;
  realizedPnl: string;
  winRate: string;
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
  timestamp: string;
}

export interface AppLog {
  id: string;
  level: string;
  message: string;
  context: string | null;
  meta: string | null;
  timestamp: string;
}

export interface Configuration {
  id: string;
  maxTraders: number;
  traderLifetimeHours: number;
  initialCapital: string;
  positionSize: string;
  leverage: number;
  marginMode: string;
  takeProfitPercent: string;
  stopLossPercent: string;
  startingSide: 'LONG' | 'SHORT';
  capitalSteps: number;
  refreshInterval: number;
  retryLimit: number;
  feeRate: string;
  slippage: string;
  mode: string;
  isPaused: boolean;
}
