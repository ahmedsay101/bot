import Decimal from 'decimal.js';
import type { PrismaClient } from '@prisma/client';
import type { BinanceClient } from '../binance/client';
import type { TraderMode } from '../../types';
import {
  applyRealizedTrade,
  buildAccountSnapshot,
  testingStartingBalance,
  type AccountSnapshot,
} from './accounting';
import { calcAllocation } from './allocation';
import { calcTotalMaintenanceMargin } from './maintenanceMargin';
import { createContextLogger } from '../logger';

const log = createContextLogger('AccountLedger');

/**
 * Single source of truth for Balance / Equity / Realized / fees.
 * Testing: persisted AccountLedger row, starts at TESTING_BASE_EQUITY USDT.
 * Live: Binance wallet + maintMargin via reconcileFromBinance.
 */
export class AccountLedger {
  private balance = testingStartingBalance();
  private realizedPnl = new Decimal(0);
  private totalFees = new Decimal(0);
  private dailyPnl = new Decimal(0);
  private dailyPnlDate = '';
  private loaded = false;
  /** Last Binance maint margin from reconcile (live). */
  private liveMaintMargin: Decimal | null = null;
  private lastReconcileAt = 0;

  constructor(
    private readonly db: PrismaClient,
    private readonly binanceClient: BinanceClient,
    private readonly mode: TraderMode,
  ) {}

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;

    if (this.mode === 'SIMULATION') {
      const today = new Date().toISOString().slice(0, 10);
      const row = await this.db.accountLedger.upsert({
        where: { id: 'singleton' },
        update: {},
        create: {
          id: 'singleton',
          balance: testingStartingBalance().toFixed(8),
          realizedPnl: '0',
          totalFees: '0',
          dailyPnl: '0',
          dailyPnlDate: today,
        },
      });
      this.balance = new Decimal(row.balance);
      this.realizedPnl = new Decimal(row.realizedPnl);
      this.totalFees = new Decimal(row.totalFees);
      this.dailyPnl = row.dailyPnlDate === today ? new Decimal(row.dailyPnl) : new Decimal(0);
      this.dailyPnlDate = today;
    }

    this.loaded = true;
  }

  /**
   * Pull wallet + maint margin + today's REALIZED_PNL from Binance.
   * Safe to call frequently; rate-limited to once per 2s internally.
   */
  async reconcileFromBinance(): Promise<void> {
    if (this.mode !== 'LIVE') return;
    const now = Date.now();
    if (now - this.lastReconcileAt < 2000) return;
    this.lastReconcileAt = now;

    try {
      const info = await this.binanceClient.getAccountInfo();
      this.balance = new Decimal(info.walletBalance);
      this.liveMaintMargin = new Decimal(info.maintMargin);

      const todayStart = new Date();
      todayStart.setUTCHours(0, 0, 0, 0);
      const income = await this.binanceClient.getIncome({
        incomeType: 'REALIZED_PNL',
        startTime: todayStart.getTime(),
        limit: 1000,
      });
      let day = new Decimal(0);
      let fees = new Decimal(0);
      for (const row of income) {
        if (row.incomeType === 'REALIZED_PNL') day = day.plus(row.income);
        if (row.incomeType === 'COMMISSION') fees = fees.plus(new Decimal(row.income).abs());
      }
      this.dailyPnl = day;
      this.dailyPnlDate = new Date().toISOString().slice(0, 10);

      // Cumulative realized from REALIZED_PNL income (best-effort)
      const allPnl = await this.binanceClient.getIncome({
        incomeType: 'REALIZED_PNL',
        limit: 1000,
      });
      let realized = new Decimal(0);
      for (const row of allPnl) realized = realized.plus(row.income);
      this.realizedPnl = realized;

      log.debug('Reconciled from Binance', {
        balance: this.balance.toFixed(4),
        maint: this.liveMaintMargin.toFixed(4),
        daily: this.dailyPnl.toFixed(4),
      });
    } catch (err) {
      log.warn('Binance reconcile failed', { error: String(err) });
    }
  }

  /**
   * Record a closed trade. Instantly updates Balance + Realized PnL.
   * grossPnl = price PnL before fees; fee is subtracted from balance.
   */
  async recordRealized(grossPnl: Decimal | string, fee: Decimal | string): Promise<Decimal> {
    await this.ensureLoaded();
    if (this.mode !== 'SIMULATION') {
      // Live: Binance is source of truth; track locally until next reconcile
      const next = applyRealizedTrade(this.balance, this.realizedPnl, this.totalFees, grossPnl, fee);
      this.realizedPnl = next.realizedPnl;
      this.totalFees = next.totalFees;
      return next.netPnl;
    }

    const today = new Date().toISOString().slice(0, 10);
    if (this.dailyPnlDate !== today) {
      this.dailyPnl = new Decimal(0);
      this.dailyPnlDate = today;
    }

    const next = applyRealizedTrade(this.balance, this.realizedPnl, this.totalFees, grossPnl, fee);
    this.balance = next.balance;
    this.realizedPnl = next.realizedPnl;
    this.totalFees = next.totalFees;
    this.dailyPnl = this.dailyPnl.plus(next.netPnl);

    await this.db.accountLedger.update({
      where: { id: 'singleton' },
      data: {
        balance: this.balance.toFixed(8),
        realizedPnl: this.realizedPnl.toFixed(8),
        totalFees: this.totalFees.toFixed(8),
        dailyPnl: this.dailyPnl.toFixed(8),
        dailyPnlDate: this.dailyPnlDate,
      },
    });

    log.info('Balance updated', {
      netPnl: next.netPnl.toFixed(8),
      balance: this.balance.toFixed(4),
      realized: this.realizedPnl.toFixed(4),
    });

    return next.netPnl;
  }

  /** Opening fee reduces balance immediately (no gross PnL). */
  async recordFee(fee: Decimal | string): Promise<void> {
    await this.recordRealized('0', fee);
  }

  getBalance(): Decimal {
    return this.balance;
  }

  getRealizedPnl(): Decimal {
    return this.realizedPnl;
  }

  async getSnapshot(params: {
    unrealizedPnl: Decimal | string;
    openNotionals: Array<Decimal | string>;
    leverage: number;
    dailyPnlOverride?: Decimal | string;
  }): Promise<AccountSnapshot> {
    await this.ensureLoaded();

    if (this.mode === 'LIVE') {
      await this.reconcileFromBinance();
      try {
        const info = await this.binanceClient.getAccountInfo();
        const wallet = new Decimal(info.walletBalance);
        const available = new Decimal(info.availableBalance);
        const unrealized =
          info.unrealizedProfit !== '0'
            ? new Decimal(info.unrealizedProfit)
            : new Decimal(params.unrealizedPnl);
        const equity = wallet.plus(unrealized);
        let openPositionValue = new Decimal(0);
        for (const n of params.openNotionals) openPositionValue = openPositionValue.plus(n);
        const usedMargin =
          info.positionInitialMargin !== '0'
            ? new Decimal(info.positionInitialMargin)
            : Decimal.max(new Decimal(0), equity.minus(available));
        const maint =
          this.liveMaintMargin ??
          (info.maintMargin !== '0'
            ? new Decimal(info.maintMargin)
            : calcTotalMaintenanceMargin(params.openNotionals));

        this.balance = wallet;

        return {
          balance: wallet.toFixed(8),
          equity: equity.toFixed(8),
          realizedPnl: this.realizedPnl.toFixed(8),
          unrealizedPnl: unrealized.toFixed(8),
          dailyPnl: new Decimal(params.dailyPnlOverride ?? this.dailyPnl).toFixed(8),
          totalFees: this.totalFees.toFixed(8),
          openPositionValue: openPositionValue.toFixed(8),
          usedMargin: usedMargin.toFixed(8),
          availableMargin: available.toFixed(8),
          maintenanceMargin: maint.toFixed(8),
        };
      } catch (err) {
        log.error('Live account snapshot failed', { error: String(err) });
      }
    }

    return buildAccountSnapshot({
      balance: this.balance,
      realizedPnl: this.realizedPnl,
      unrealizedPnl: params.unrealizedPnl,
      dailyPnl: params.dailyPnlOverride ?? this.dailyPnl,
      totalFees: this.totalFees,
      openNotionals: params.openNotionals,
      leverage: params.leverage,
    });
  }

  /** Position sizing uses Balance (wallet), not equity-with-unrealized. */
  async getAllocation(maxTraders: number, leverage: number) {
    await this.ensureLoaded();
    let balance = this.balance;
    if (this.mode === 'LIVE') {
      try {
        await this.reconcileFromBinance();
        balance = this.balance;
      } catch {
        /* keep local */
      }
    }
    return calcAllocation(balance, maxTraders, leverage);
  }
}
