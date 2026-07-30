import Decimal from 'decimal.js';
import type { OrderRequest, SymbolInfo } from '../../types';
import { createContextLogger } from '../logger';
import { validateNotional } from '../utils/precision';

const log = createContextLogger('RiskManager');

export class RiskValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RiskValidationError';
  }
}

export class RiskManager {
  private openOrderClientIds = new Set<string>();
  private readonly maxClockDriftMs = 5000;

  validateOrder(req: OrderRequest, symbolInfo: SymbolInfo, availableBalance: string): void {
    // Duplicate order guard
    if (this.openOrderClientIds.has(req.clientOrderId)) {
      throw new RiskValidationError(`Duplicate order: ${req.clientOrderId}`);
    }

    // Price precision guard
    if (req.price != null) {
      const priceDecimal = new Decimal(req.price);
      if (priceDecimal.lte(0)) {
        throw new RiskValidationError(`Invalid price: ${req.price}`);
      }
    }

    // Quantity guard
    const qty = new Decimal(req.quantity);
    if (qty.lte(0)) {
      throw new RiskValidationError(`Invalid quantity: ${req.quantity}`);
    }
    if (qty.lt(symbolInfo.minQty)) {
      throw new RiskValidationError(`Quantity ${req.quantity} below minimum ${symbolInfo.minQty}`);
    }

    // Notional guard
    if (req.price != null) {
      validateNotional(req.price, req.quantity, symbolInfo);
    }

    // Available balance check for new positions (not reduce-only)
    if (req.reduceOnly !== true && req.price != null) {
      const notional = new Decimal(req.price).mul(req.quantity);
      const required = notional.div(10); // assumes 10x leverage minimum
      if (new Decimal(availableBalance).lt(required)) {
        log.warn('Insufficient balance warning', {
          required: required.toFixed(2),
          available: availableBalance,
        });
      }
    }

    log.debug('Order passed risk validation', { clientId: req.clientOrderId });
  }

  trackOpenOrder(clientOrderId: string): void {
    this.openOrderClientIds.add(clientOrderId);
  }

  releaseOrder(clientOrderId: string): void {
    this.openOrderClientIds.delete(clientOrderId);
  }

  checkClockDrift(serverTime: number): void {
    const drift = Math.abs(serverTime - Date.now());
    if (drift > this.maxClockDriftMs) {
      log.warn(`Clock drift detected: ${drift}ms`);
    }
  }

  validateSymbol(symbol: string): void {
    if (!symbol.endsWith('USDT') && !symbol.endsWith('BUSD')) {
      throw new RiskValidationError(`Non-USDT symbol not supported: ${symbol}`);
    }
    if (/\d[LS]$/.test(symbol)) {
      throw new RiskValidationError(`Leveraged token not allowed: ${symbol}`);
    }
  }

  validateLeverage(leverage: number, maxLeverage: number): void {
    if (leverage > maxLeverage) {
      throw new RiskValidationError(`Leverage ${leverage}x exceeds max ${maxLeverage}x`);
    }
    if (leverage < 1) {
      throw new RiskValidationError(`Leverage must be at least 1x`);
    }
  }
}
