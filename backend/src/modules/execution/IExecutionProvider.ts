import type { OrderRequest, OrderResult, CancelOrderRequest, PositionInfo, SymbolInfo } from '../../types';

/**
 * Abstraction over live and simulated trade execution.
 * All trading logic depends only on this interface.
 */
export interface IExecutionProvider {
  /** Place a new order. */
  placeOrder(req: OrderRequest): Promise<OrderResult>;

  /** Cancel an existing order. */
  cancelOrder(req: CancelOrderRequest): Promise<void>;

  /** Cancel all open orders for a symbol. */
  cancelAllOrders(symbol: string): Promise<void>;

  /** Get open positions for a symbol. */
  getPositions(symbol: string): Promise<PositionInfo[]>;

  /** Close a position at market price. */
  closePosition(symbol: string, side: 'LONG' | 'SHORT', quantity: string): Promise<OrderResult>;

  /** Set leverage for a symbol. */
  setLeverage(symbol: string, leverage: number): Promise<void>;

  /** Set margin mode for a symbol. */
  setMarginMode(symbol: string, marginMode: string): Promise<void>;

  /** Get current mark price for a symbol. */
  getMarkPrice(symbol: string): Promise<string>;

  /** Retrieve symbol exchange info. */
  getSymbolInfo(symbol: string): Promise<SymbolInfo>;

  /** Whether the provider is a simulation. */
  readonly isSimulation: boolean;
}
