import Decimal from 'decimal.js';
import {
  buildStepLadder,
  calcStepAmount,
  calcStepNotional,
  calcStepUnit,
  clampStep,
  nextStepAfterClose,
  simulateStepSequence,
} from '../../src/modules/calc/capitalSteps';
import { nextSideAfterClose } from '../../src/modules/calc/strategy';

describe('capital step calculation', () => {
  it('divides $100 into 5 steps: 20,40,60,80,100', () => {
    const ladder = buildStepLadder('100', 5);
    expect(ladder.map((s) => s.amount.toFixed(0))).toEqual(['20', '40', '60', '80', '100']);
    expect(calcStepUnit('100', 5).toFixed(0)).toBe('20');
  });

  it('divides $100 into 10 steps', () => {
    const ladder = buildStepLadder('100', 10);
    expect(ladder).toHaveLength(10);
    expect(ladder[0]!.amount.toFixed(0)).toBe('10');
    expect(ladder[9]!.amount.toFixed(0)).toBe('100');
  });

  it('divides $100 into 3 steps with Decimal precision', () => {
    expect(calcStepAmount('100', 3, 1).toFixed(8)).toBe(
      new Decimal(100).div(3).toFixed(8),
    );
    expect(calcStepAmount('100', 3, 3).toFixed(8)).toBe('100.00000000');
  });

  it('TP progression 1→2→3→4→5→5', () => {
    expect(simulateStepSequence(5, ['TP', 'TP', 'TP', 'TP', 'TP'])).toEqual([1, 2, 3, 4, 5, 5]);
  });

  it('SL always resets directly to Step 1 from any step', () => {
    expect(nextStepAfterClose(1, 'SL', 5)).toBe(1);
    expect(nextStepAfterClose(2, 'SL', 5)).toBe(1);
    expect(nextStepAfterClose(3, 'SL', 5)).toBe(1);
    expect(nextStepAfterClose(4, 'SL', 5)).toBe(1);
    expect(nextStepAfterClose(5, 'SL', 5)).toBe(1);
    // Not gradual: 5 → 1, never 5→4→3→2→1
    expect(simulateStepSequence(5, ['SL'], 5)).toEqual([5, 1]);
  });

  it('mixed sequence with SL resets', () => {
    // 1 -TP→ 2 -TP→ 3 -TP→ 4 -SL→ 1 -TP→ 2 -TP→ 3 -SL→ 1
    expect(
      simulateStepSequence(5, ['TP', 'TP', 'TP', 'SL', 'TP', 'TP', 'SL']),
    ).toEqual([1, 2, 3, 4, 1, 2, 3, 1]);
  });

  it('never goes below 1 or above max', () => {
    expect(nextStepAfterClose(1, 'SL', 5)).toBe(1);
    expect(nextStepAfterClose(5, 'TP', 5)).toBe(5);
    expect(clampStep(0, 5)).toBe(1);
    expect(clampStep(99, 5)).toBe(5);
  });

  it('direction rules remain unchanged with steps', () => {
    expect(nextSideAfterClose('SHORT', 'TP')).toBe('SHORT');
    expect(nextSideAfterClose('LONG', 'TP')).toBe('LONG');
    expect(nextSideAfterClose('SHORT', 'SL')).toBe('LONG');
    expect(nextSideAfterClose('LONG', 'SL')).toBe('SHORT');
  });

  it('SL reset uses Step 1 allocation (not intermediate)', () => {
    const alloc = '100';
    const steps = 5;
    // Was step 4 ($80), after SL → step 1 ($20)
    expect(calcStepAmount(alloc, steps, nextStepAfterClose(4, 'SL', steps)).toFixed(2)).toBe('20.00');
    expect(calcStepAmount(alloc, steps, nextStepAfterClose(5, 'SL', steps)).toFixed(2)).toBe('20.00');
  });

  it('notional = step margin × leverage', () => {
    expect(calcStepNotional('20', 5).toFixed(0)).toBe('100');
    expect(calcStepNotional(calcStepAmount('100', 5, 3), 10).toFixed(0)).toBe('600');
  });

  it('PnL does not affect step amounts (fixed allocation)', () => {
    const a = calcStepAmount('100', 5, 3);
    const b = calcStepAmount('100', 5, 3);
    expect(a.equals(b)).toBe(true);
    expect(a.toFixed(0)).toBe('60');
  });

  describe('dashboard allocation examples (SSOT)', () => {
    it('Example 1: $100 / 5 steps → step 1 = $20', () => {
      expect(calcStepAmount('100', 5, 1).toFixed(2)).toBe('20.00');
    });

    it('Example 2: $100 / 5 steps → step 3 = $60', () => {
      expect(calcStepAmount('100', 5, 3).toFixed(2)).toBe('60.00');
    });

    it('Example 3: $100 / 5 steps → step 5 = $100', () => {
      expect(calcStepAmount('100', 5, 5).toFixed(2)).toBe('100.00');
    });

    it('Example 4: $100 / 3 steps → step 2 ≈ $66.67', () => {
      const amt = calcStepAmount('100', 3, 2);
      expect(amt.toFixed(2)).toBe('66.67');
      expect(amt.toFixed(8)).toBe(new Decimal(100).mul(2).div(3).toFixed(8));
    });

    it('Example 5: current step allocation never exceeds trader allocation', () => {
      for (const steps of [3, 5, 10]) {
        for (let s = 1; s <= steps; s++) {
          const a = calcStepAmount('100', steps, s);
          expect(a.lte(100)).toBe(true);
        }
      }
      expect(calcStepAmount('100', 5, 5).eq(100)).toBe(true);
    });

    it('position notional is separate from step allocation', () => {
      const stepAlloc = calcStepAmount('100', 5, 3);
      expect(stepAlloc.toFixed(2)).toBe('60.00');
      expect(calcStepNotional(stepAlloc, 5).toFixed(2)).toBe('300.00');
    });
  });
});
