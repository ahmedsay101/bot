-- Single-position grid: dynamic capital + level completion fields
ALTER TABLE "Trader" ADD COLUMN IF NOT EXISTS "currentCapital" TEXT;
ALTER TABLE "GridLevel" ADD COLUMN IF NOT EXISTS "tpPrice" TEXT;
ALTER TABLE "GridLevel" ADD COLUMN IF NOT EXISTS "slPrice" TEXT;
ALTER TABLE "GridLevel" ADD COLUMN IF NOT EXISTS "completionReason" TEXT;
ALTER TABLE "GridLevel" ADD COLUMN IF NOT EXISTS "completedAt" TIMESTAMP(3);
