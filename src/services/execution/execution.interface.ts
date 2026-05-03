import type { Side, OrderType, OrderStatus } from '../../core/constants.js';

export interface OrderRequest {
  clientOrderId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  positionSide: Side;
  type: OrderType;
  qty: number;
  price?: number;
  stopPrice?: number;
  reduceOnly?: boolean;
  purpose: 'ENTRY' | 'EXIT' | 'SL' | 'TP' | 'GRID' | 'HEDGE' | 'GRID_TP' | 'HEDGE_CLOSE';
}

export interface OrderResult {
  clientOrderId: string;
  exchangeOrderId: string | null;
  status: OrderStatus;
  filledQty: number;
  avgFillPrice: number;
  fees: number;
}

export interface FillEvent {
  clientOrderId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  positionSide: Side;
  qty: number;
  price: number;
  fee: number;
  ts: number;
  isFinal: boolean;
  purpose: 'ENTRY' | 'EXIT' | 'SL' | 'TP' | 'GRID' | 'HEDGE' | 'GRID_TP' | 'HEDGE_CLOSE';
}

export interface PositionSnapshot {
  symbol: string;
  side: Side;
  size: number;
  entryPrice: number;
  leverage: number;
  margin: number;
  notional: number;
  liquidationPrice: number;
  stopPrice: number;
  takeProfitPrice: number;
}

export interface BalanceSnapshot {
  balance: number;
  equity: number;
  marginUsed: number;
  unrealizedPnl: number;
  feesPaid: number;
}

export type FillHandler = (e: FillEvent) => void;
export type Unsubscribe = () => void;

export interface IExecutionService {
  start(): Promise<void>;
  stop(): Promise<void>;

  placeOrder(req: OrderRequest): Promise<OrderResult>;
  cancelOrder(symbol: string, clientOrderId: string): Promise<void>;

  getPosition(symbol: string): Promise<PositionSnapshot | null>;
  getAllPositions(): Promise<PositionSnapshot[]>;
  getBalance(): Promise<BalanceSnapshot>;

  /** Reconcile DB ↔ exchange. Throws if hard inconsistency in live mode. */
  reconcile(): Promise<void>;

  onFill(handler: FillHandler): Unsubscribe;
}
