-- AlterEnum: STOP_LIMIT two-phase status
ALTER TYPE "OrderStatus" ADD VALUE 'TRIGGERED';

-- Testing-mode wallet ledger
CREATE TABLE "AccountLedger" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "balance" TEXT NOT NULL DEFAULT '200',
    "realizedPnl" TEXT NOT NULL DEFAULT '0',
    "totalFees" TEXT NOT NULL DEFAULT '0',
    "dailyPnl" TEXT NOT NULL DEFAULT '0',
    "dailyPnlDate" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountLedger_pkey" PRIMARY KEY ("id")
);
