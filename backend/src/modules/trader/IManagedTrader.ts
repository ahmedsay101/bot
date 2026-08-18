import type { EventEmitter } from 'events';
import type {
  CloseReason,
  OrderUpdate,
  TraderMode,
  TraderStatus,
  TraderSummaryView,
} from '../../types';

export type ManagedTraderEvent =
  | { type: 'STATUS_CHANGED'; traderId: string; status: TraderStatus }
  | { type: 'COMPLETED'; traderId: string; symbol: string; reason?: CloseReason | string }
  | { type: 'FAILED'; traderId: string; symbol: string; error: string }
  | { type: 'PNL_UPDATE'; traderId: string; realizedPnl: string; unrealizedPnl: string; totalPnl: string }
  | { type: 'TRADER_SNAPSHOT'; trader: TraderSummaryView };

/**
 * Common surface used by TraderManager for both reversal and grid traders.
 */
export interface IManagedTrader extends EventEmitter {
  readonly id: string;
  readonly symbol: string;
  readonly mode: TraderMode;

  initialize(): Promise<void>;
  restore(state: any): Promise<void>;
  resumeCompleting(): Promise<void>;
  onOrderUpdate(update: OrderUpdate): Promise<void>;
  onPriceUpdate(price: string): void;
  pause(): Promise<void>;
  resume(): Promise<void>;
  destroy(): void;
  emergencyStop(): Promise<void>;
  toSummary(): TraderSummaryView;
  getStatus(): TraderStatus;
  isActive(): boolean;
  hasOpenPosition(): boolean;
  getOpenNotional(): string | null;
  getId(): string;
  getSymbol(): string;
  getRealizedPnl(): string;
  getUnrealizedPnl(): string;
}
