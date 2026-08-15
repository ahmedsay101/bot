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
import {
  calcBalanceRange24h,
  selectExpiredBalanceSnapshotIds,
  type BalanceRange24h,
} from './balanceHistory';
import { calcAllocation } from './allocation';
import { calcTotalMaintenanceMargin } from './maintenanceMargin';
import { createContextLogger } from '../logger';

const log = createContextLogger('AccountLedger');

/**
 * Single source of truth for Balance / Equity / Realized / fees.
 * Testing: persisted AccountLedger row, starts at TESTING_BASE_EQUITY USDT.
 * Live: Binance wallet + maintMargin via reconcileFromBinance.
 *
 * Realized PnL is always net of trading fees (gross − fees).
 * totalFees accumulates entry + exit commissions (once each).
 *
 * BalanceSnapshot rows track wallet balance for rolling 24h high/low.
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
  /** Last balance written to BalanceSnapshot (skip duplicate unchanged). */
  private lastRecordedBalance: string | null = null;
  private cleanupInFlight = false;

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
    await this.ensureInitialBalanceSnapshot();
  }

  /**
   * Seed history with current balance if empty (new bot / after reset).
   */
  private async ensureInitialBalanceSnapshot(): Promise<void> {
    try {
      const count = await this.db.balanceSnapshot.count();
      if (count === 0) {
        await this.recordBalanceSnapshot(this.balance, true);
      } else {
        const latest = await this.db.balanceSnapshot.findFirst({
          orderBy: { recordedAt: 'desc' },
        });
        this.lastRecordedBalance = latest?.balance ?? null;
      }
    } catch (err) {
      log.warn('Failed to seed balance snapshot', { error: String(err) });
    }
  }

  /**
   * Persist a wallet-balance point when it changes (or force on seed).
   */
  private async recordBalanceSnapshot(
    balance: Decimal | string,
    force = false,
  ): Promise<void> {
    const bal = new Decimal(balance).toFixed(8);
    if (!force && this.lastRecordedBalance != null && this.lastRecordedBalance === bal) {
      return;
    }
    try {
      await this.db.balanceSnapshot.create({
        data: { balance: bal, recordedAt: new Date() },
      });
      this.lastRecordedBalance = bal;
      void this.cleanupExpiredSnapshots();
    } catch (err) {
      log.warn('Failed to record balance snapshot', { error: String(err) });
    }
  }

  private async cleanupExpiredSnapshots(): Promise<void> {
    if (this.cleanupInFlight) return;
    this.cleanupInFlight = true;
    try {
      const now = Date.now();
      // Load a bounded set of old rows for cleanup decisions
      const old = await this.db.balanceSnapshot.findMany({
        where: {
          recordedAt: { lt: new Date(now - 24 * 60 * 60 * 1000) },
        },
        orderBy: { recordedAt: 'asc' },
        select: { id: true, recordedAt: true },
      });
      const toDelete = selectExpiredBalanceSnapshotIds(old, now);
      if (toDelete.length > 0) {
        await this.db.balanceSnapshot.deleteMany({ where: { id: { in: toDelete } } });
      }
    } catch (err) {
      log.debug('Balance snapshot cleanup failed', { error: String(err) });
    } finally {
      this.cleanupInFlight = false;
    }
  }

  /**
   * Rolling 24h high/low from persisted snapshots + current balance.
   * Survives restart; frontend must not recalculate.
   */
  async getBalanceRange24h(currentOverride?: Decimal | string): Promise<BalanceRange24h> {
    await this.ensureLoaded();
    const current = currentOverride != null ? new Decimal(currentOverride) : this.balance;
    const now = Date.now();
    // Fetch window + one day buffer so anchor is available after restart
    const since = new Date(now - 48 * 60 * 60 * 1000);
    const rows = await this.db.balanceSnapshot.findMany({
      where: { recordedAt: { gte: since } },
      orderBy: { recordedAt: 'asc' },
      select: { balance: true, recordedAt: true },
    });
    return calcBalanceRange24h(current, rows, now);
  }

  /**
   * Pull wallet + maint margin from Binance.
   * Compare COMMISSION / REALIZED_PNL income against local fill accounting — log diffs,
   * do not silently overwrite local realized / fees (fill path is authoritative for bot trades).
   */
  async reconcileFromBinance(): Promise<void> {
    if (this.mode !== 'LIVE') return;
    const now = Date.now();
    if (now - this.lastReconcileAt < 2000) return;
    this.lastReconcileAt = now;

    try {
      const info = await this.binanceClient.getAccountInfo();
      const wallet = new Decimal(info.walletBalance);
      const prev = this.balance;
      this.balance = wallet;
      this.liveMaintMargin = new Decimal(info.maintMargin);

      if (!wallet.eq(prev) || this.lastRecordedBalance == null) {
        await this.recordBalanceSnapshot(wallet);
      }

      const todayStart = new Date();
      todayStart.setUTCHours(0, 0, 0, 0);
      const startTime = todayStart.getTime();

      const [pnlToday, commissionToday] = await Promise.all([
        this.binanceClient.getIncome({
          incomeType: 'REALIZED_PNL',
          startTime,
          limit: 1000,
        }),
        this.binanceClient.getIncome({
          incomeType: 'COMMISSION',
          startTime,
          limit: 1000,
        }),
      ]);

      let dayGross = new Decimal(0);
      for (const row of pnlToday) dayGross = dayGross.plus(row.income);
      let dayFees = new Decimal(0);
      for (const row of commissionToday) dayFees = dayFees.plus(new Decimal(row.income).abs());

      this.dailyPnl = dayGross.minus(dayFees);
      this.dailyPnlDate = new Date().toISOString().slice(0, 10);

      const [allPnl, allFees] = await Promise.all([
        this.binanceClient.getIncome({ incomeType: 'REALIZED_PNL', limit: 1000 }),
        this.binanceClient.getIncome({ incomeType: 'COMMISSION', limit: 1000 }),
      ]);
      let binanceGross = new Decimal(0);
      for (const row of allPnl) binanceGross = binanceGross.plus(row.income);
      let binanceFees = new Decimal(0);
      for (const row of allFees) binanceFees = binanceFees.plus(new Decimal(row.income).abs());
      const binanceNet = binanceGross.minus(binanceFees);

      const feeDiff = this.totalFees.minus(binanceFees).abs();
      const netDiff = this.realizedPnl.minus(binanceNet).abs();
      if (feeDiff.gte('0.01') || netDiff.gte('0.01')) {
        log.warn('Binance fee/PnL reconciliation discrepancy (local fill accounting kept)', {
          localNetRealized: this.realizedPnl.toFixed(8),
          binanceNetRealized: binanceNet.toFixed(8),
          localFees: this.totalFees.toFixed(8),
          binanceFees: binanceFees.toFixed(8),
          binanceGrossRealized: binanceGross.toFixed(8),
          walletBalance: this.balance.toFixed(8),
        });
      }

      log.debug('Reconciled from Binance', {
        balance: this.balance.toFixed(4),
        maint: this.liveMaintMargin.toFixed(4),
        dailyNet: this.dailyPnl.toFixed(4),
        localFees: this.totalFees.toFixed(4),
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
      // Live: Binance wallet is balance SSOT; track local net + fees until next reconcile
      const next = applyRealizedTrade(this.balance, this.realizedPnl, this.totalFees, grossPnl, fee);
      this.realizedPnl = next.realizedPnl;
      this.totalFees = next.totalFees;
      // Optimistic local balance for high/low until Binance reconcile confirms
      this.balance = next.balance;
      await this.recordBalanceSnapshot(this.balance);
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

    await this.recordBalanceSnapshot(this.balance);

    log.info('Balance updated', {
      netPnl: next.netPnl.toFixed(8),
      balance: this.balance.toFixed(4),
      realized: this.realizedPnl.toFixed(4),
      fees: this.totalFees.toFixed(4),
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

  getTotalFees(): Decimal {
    return this.totalFees;
  }

  /** Gross realized = net + fees (when all fees are trading commissions). */
  getGrossRealizedPnl(): Decimal {
    return this.realizedPnl.plus(this.totalFees);
  }

  async getSnapshot(params: {
    unrealizedPnl: Decimal | string;
    openNotionals: Array<Decimal | string>;
    leverage: number;
    dailyPnlOverride?: Decimal | string;
  }): Promise<AccountSnapshot & BalanceRange24h> {
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

        if (!wallet.eq(this.balance)) {
          this.balance = wallet;
          await this.recordBalanceSnapshot(wallet);
        } else {
          this.balance = wallet;
        }

        const range = await this.getBalanceRange24h(wallet);

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
          ...range,
          currentBalance: wallet.toFixed(8),
        };
      } catch (err) {
        log.error('Live account snapshot failed', { error: String(err) });
      }
    }

    const base = buildAccountSnapshot({
      balance: this.balance,
      realizedPnl: this.realizedPnl,
      unrealizedPnl: params.unrealizedPnl,
      dailyPnl: params.dailyPnlOverride ?? this.dailyPnl,
      totalFees: this.totalFees,
      openNotionals: params.openNotionals,
      leverage: params.leverage,
    });
    const range = await this.getBalanceRange24h(this.balance);
    return {
      ...base,
      ...range,
      currentBalance: base.balance,
    };
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
