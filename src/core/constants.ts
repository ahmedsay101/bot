export const Side = {
  LONG: 'LONG',
  SHORT: 'SHORT',
} as const;
export type Side = (typeof Side)[keyof typeof Side];

export const Regime = {
  RANGE: 'RANGE',
  TREND: 'TREND',
  UNKNOWN: 'UNKNOWN',
} as const;
export type Regime = (typeof Regime)[keyof typeof Regime];

export const OrderType = {
  MARKET: 'MARKET',
  LIMIT: 'LIMIT',
  STOP_MARKET: 'STOP_MARKET',
  TAKE_PROFIT_MARKET: 'TAKE_PROFIT_MARKET',
} as const;
export type OrderType = (typeof OrderType)[keyof typeof OrderType];

export const OrderStatus = {
  NEW: 'NEW',
  PARTIALLY_FILLED: 'PARTIALLY_FILLED',
  FILLED: 'FILLED',
  CANCELED: 'CANCELED',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED',
} as const;
export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

export const Mode = {
  TEST: 'test',
  LIVE: 'live',
} as const;
export type Mode = (typeof Mode)[keyof typeof Mode];

export const TradeReason = {
  TP: 'take_profit',
  SL: 'stop_loss',
  RSI_NEUTRAL: 'rsi_neutral',
  REGIME_CHANGE: 'regime_change',
  KILL_SWITCH: 'kill_switch',
  LIQUIDATION: 'liquidation',
  MANUAL: 'manual',
  SHUTDOWN: 'shutdown',
} as const;
export type TradeReason = (typeof TradeReason)[keyof typeof TradeReason];

// Channels for Redis pub/sub
export const Channels = {
  CONFIG_UPDATED: 'config:updated',
  CANDLE_CLOSE: 'marketData:candleClose',
  BOOK_TICKER: 'marketData:bookTicker',
  ORDER_FILLED: 'order:filled',
  ORDER_PARTIAL: 'order:partial',
  TRADE_CLOSED: 'trade:closed',
  POSITION_UPDATED: 'position:updated',
  BALANCE_UPDATED: 'balance:updated',
  KILL_SWITCH: 'kill_switch',
  LOG: 'log',
} as const;
