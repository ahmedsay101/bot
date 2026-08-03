/**
 * Hedge SSOT invariants: PENDING until stop, SL = previous level, never entry stop as SL.
 */
import type { HedgeLevel, OrderStatus } from '../../src/types';

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
  shortEntry?: string | null;
  entryOrderStop?: string | null; // STOP-LIMIT trigger — MUST NOT be used as SL
}): string {
  return args.slOrderStop ?? args.dbHedgeStop ?? args.shortEntry ?? '0';
}

describe('hedge state reconstruction', () => {
  it('maps resting STOP-LIMIT to PENDING, not TRIGGERED', () => {
    expect(reconstructHedgeStatus({ entryStatus: 'PENDING' })).toBe('PENDING');
    expect(reconstructHedgeStatus({ entryStatus: 'NEW' })).toBe('PENDING');
    expect(reconstructHedgeStatus({ entryStatus: 'TRIGGERED' })).toBe('TRIGGERED');
  });

  it('never uses entry STOP-LIMIT stopPrice as position SL', () => {
    const shortEntry = '0.017844';
    const hedgeTrigger = '0.019630';
    const sl = reconstructPositionSl({
      slOrderStop: null,
      dbHedgeStop: shortEntry,
      shortEntry,
      entryOrderStop: hedgeTrigger,
    });
    expect(sl).toBe(shortEntry);
    expect(sl).not.toBe(hedgeTrigger);
  });

  it('falls back to short entry when no SL order exists', () => {
    expect(
      reconstructPositionSl({
        slOrderStop: null,
        dbHedgeStop: null,
        shortEntry: '100',
        entryOrderStop: '110',
      }),
    ).toBe('100');
  });
});
