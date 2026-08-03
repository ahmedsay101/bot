import type { IExecutionProvider } from './IExecutionProvider';
import { BinanceClient } from '../binance/client';
import type { OrderRequest, OrderResult, CancelOrderRequest, PositionInfo, SymbolInfo } from '../../types';
import { createContextLogger } from '../logger';

const log = createContextLogger('LiveExecutionProvider');

export class LiveExecutionProvider implements IExecutionProvider {
  readonly isSimulation = false;
  private symbolCache = new Map<string, SymbolInfo>();

  constructor(private readonly client: BinanceClient) {}

  get hedgeModeEnabled(): boolean {
    return this.client.hedgeModeEnabled;
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    const withSide: OrderRequest = {
      ...req,
      positionSide: req.positionSide ?? (req.role === 'SHORT' ? 'SHORT' : 'LONG'),
    };
    log.info('Placing live order', {
      symbol: withSide.symbol,
      side: withSide.side,
      type: withSide.type,
      qty: withSide.quantity,
      price: withSide.price,
      stopPrice: withSide.stopPrice,
      positionSide: withSide.positionSide,
      clientId: withSide.clientOrderId,
    });
    return this.client.placeOrder(withSide);
  }

  async cancelOrder(req: CancelOrderRequest): Promise<void> {
    log.info('Cancelling live order', { symbol: req.symbol, clientId: req.clientOrderId });
    await this.client.cancelOrder(req.symbol, req.clientOrderId);
  }

  async cancelAllOrders(symbol: string): Promise<void> {
    log.info('Cancelling all orders', { symbol });
    await this.client.cancelAllOpenOrders(symbol);
  }

  async getPositions(symbol: string): Promise<PositionInfo[]> {
    return this.client.getPositions(symbol);
  }

  async closePosition(symbol: string, side: 'LONG' | 'SHORT', quantity: string): Promise<OrderResult> {
    log.info('Closing live position', { symbol, side, quantity });
    return this.client.closePosition(symbol, side, quantity);
  }

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    await this.client.setLeverage(symbol, leverage);
  }

  async setMarginMode(symbol: string, marginMode: string): Promise<void> {
    await this.client.setMarginType(symbol, marginMode);
  }

  async setHedgeMode(enabled: boolean): Promise<void> {
    await this.client.setHedgeMode(enabled);
  }

  async getMarkPrice(symbol: string): Promise<string> {
    return this.client.getMarkPrice(symbol);
  }

  async getSymbolInfo(symbol: string): Promise<SymbolInfo> {
    if (this.symbolCache.has(symbol)) {
      return this.symbolCache.get(symbol)!;
    }
    const infos = await this.client.getExchangeInfo();
    for (const info of infos) this.symbolCache.set(info.symbol, info);
    const found = this.symbolCache.get(symbol);
    if (found == null) throw new Error(`Symbol ${symbol} not found in exchange info`);
    return found;
  }
}
