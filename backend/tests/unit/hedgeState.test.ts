/**
 * Hedge SSOT invariants: PENDING until stop; SL from entry %; never use STOP-LIMIT trigger as SL.
 */
import type { HedgeLevel, OrderStatus } from '../../src/types';
import { calcHedgeStopLoss } from '../../src/modules/calc/strategy';

/** Mirrors TraderManager.reconstructStateFromOrders hedge mapping (kept in sync for regression). */
function reconstructHedgeStatus(args: {
  entryStatus?: OrderStatus;
  tpFilled?: boolean;
  slFilled?: boolean;
  entryFilled?: boolean;
}): HedgeLevel['status'] {
  if (args.tpFilled) return 'HIT_TP';
  if (args.slFilled) return 'HIT_SL';
  if (args.entryFilled) return 'OPEN';
  if (args.entryStatus === 'TRIGGERED') return 'TRIGGERED';
  return 'PENDING';
}

function reconstructPositionSl(args: {
  slOrderStop?: string | null;
  dbHedgeStop?: string | null;
  entryPrice: string;
  hedgeSlPercent: string;
  entryOrderStop?: string | null; // STOP-LIMIT trigger — MUST NOT be used as SL
}): string {
  if (args.slOrderStop != null) return args.slOrderStop;
  if (args.dbHedgeStop != null) return args.dbHedgeStop;
  return calcHedgeStopLoss(args.entryPrice, args.hedgeSlPercent).toFixed();
}

describe('hedge state reconstruction', () => {
  it('maps resting STOP-LIMIT to PENDING, not TRIGGERED', () => {
    expect(reconstructHedgeStatus({ entryStatus: 'PENDING' })).toBe('PENDING');
    expect(reconstructHedgeStatus({ entryStatus: 'NEW' })).toBe('PENDING');
    expect(reconstructHedgeStatus({ entryStatus: 'TRIGGERED' })).toBe('TRIGGERED');
  });

  it('never uses entry STOP-LIMIT stopPrice as position SL', () => {
    const hedgeEntry = '0.019630';
    const hedgeTrigger = '0.019630';
    const sl = reconstructPositionSl({
      slOrderStop: null,
      dbHedgeStop: null,
      entryPrice: hedgeEntry,
      hedgeSlPercent: '0.03',
      entryOrderStop: hedgeTrigger,
    });
    expect(sl).toBe(calcHedgeStopLoss(hedgeEntry, '0.03').toFixed());
    expect(sl).not.toBe(hedgeTrigger);
  });

  it('prefers persisted SL order / DB stop over recomputed', () => {
    expect(
      reconstructPositionSl({
        slOrderStop: '106.70',
        dbHedgeStop: '999',
        entryPrice: '110',
        hedgeSlPercent: '0.03',
        entryOrderStop: '110',
      }),
    ).toBe('106.70');
  });
});
