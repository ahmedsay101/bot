-- Persistent wallet-balance snapshots for rolling 24h high/low
CREATE TABLE IF NOT EXISTS "BalanceSnapshot" (
    "id" TEXT NOT NULL,
    "balance" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BalanceSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "BalanceSnapshot_recordedAt_idx" ON "BalanceSnapshot"("recordedAt");
