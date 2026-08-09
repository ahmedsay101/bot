/**
 * Capital step progression — shared by Live and Simulation.
 * Step amounts are derived from a fixed trader allocation (not PnL/balance).
 */
import Decimal from 'decimal.js';

/** Margin/capital for a given step: allocation × step / capitalSteps. */
export function calcStepAmount(
  traderAllocatedAmount: string | Decimal,
  capitalSteps: number,
  step: number,
): Decimal {
  const steps = Math.max(1, Math.floor(capitalSteps));
  const s = clampStep(step, steps);
  return new Decimal(traderAllocatedAmount).mul(s).div(steps);
}

/** Base unit = allocation / capitalSteps (Step 1 amount). */
export function calcStepUnit(
  traderAllocatedAmount: string | Decimal,
  capitalSteps: number,
): Decimal {
  const steps = Math.max(1, Math.floor(capitalSteps));
  return new Decimal(traderAllocatedAmount).div(steps);
}

/** Full ladder Step 1..N with amounts. */
export function buildStepLadder(
  traderAllocatedAmount: string | Decimal,
  capitalSteps: number,
): Array<{ step: number; amount: Decimal }> {
  const steps = Math.max(1, Math.floor(capitalSteps));
  const out: Array<{ step: number; amount: Decimal }> = [];
  for (let i = 1; i <= steps; i++) {
    out.push({ step: i, amount: calcStepAmount(traderAllocatedAmount, steps, i) });
  }
  return out;
}

/** Clamp step into [1, maxSteps]. */
export function clampStep(step: number, capitalSteps: number): number {
  const max = Math.max(1, Math.floor(capitalSteps));
  if (!Number.isFinite(step)) return 1;
  return Math.min(max, Math.max(1, Math.floor(step)));
}

/**
 * Next capital step after a close.
 * TP → +1 (cap at max); SL → −1 (floor at 1).
 */
export function nextStepAfterClose(
  currentStep: number,
  reason: 'TP' | 'SL',
  capitalSteps: number,
): number {
  const max = Math.max(1, Math.floor(capitalSteps));
  const cur = clampStep(currentStep, max);
  if (reason === 'TP') return Math.min(max, cur + 1);
  return Math.max(1, cur - 1);
}

/** Notional = step margin × leverage. */
export function calcStepNotional(
  stepAmount: string | Decimal,
  leverage: number,
): Decimal {
  return new Decimal(stepAmount).mul(Math.max(1, leverage));
}

/** Apply a sequence of TP/SL outcomes starting at step 1 (for tests / determinism checks). */
export function simulateStepSequence(
  capitalSteps: number,
  outcomes: Array<'TP' | 'SL'>,
  startStep = 1,
): number[] {
  const steps: number[] = [clampStep(startStep, capitalSteps)];
  let cur = steps[0]!;
  for (const o of outcomes) {
    cur = nextStepAfterClose(cur, o, capitalSteps);
    steps.push(cur);
  }
  return steps;
}
