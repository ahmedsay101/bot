-- Consecutive SL protection: temporary symbol blocks
CREATE TABLE IF NOT EXISTS "SymbolBlock" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "blockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "blockedUntil" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "consecutiveStopLosses" INTEGER NOT NULL,
    "traderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SymbolBlock_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SymbolBlock_symbol_key" ON "SymbolBlock"("symbol");
CREATE INDEX IF NOT EXISTS "SymbolBlock_blockedUntil_idx" ON "SymbolBlock"("blockedUntil");

ALTER TABLE "Configuration" ADD COLUMN IF NOT EXISTS "consecutiveStopLossLimit" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "Configuration" ADD COLUMN IF NOT EXISTS "symbolBlockDurationHours" DOUBLE PRECISION NOT NULL DEFAULT 3;

ALTER TABLE "Trader" ADD COLUMN IF NOT EXISTS "consecutiveStopLosses" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Trader" ADD COLUMN IF NOT EXISTS "completionReason" TEXT;
