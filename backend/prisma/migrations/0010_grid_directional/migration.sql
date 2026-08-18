-- Grid directional trader behavior + config knobs
ALTER TABLE "Configuration" ADD COLUMN IF NOT EXISTS "traderBehavior" TEXT NOT NULL DEFAULT 'reversal';
ALTER TABLE "Configuration" ADD COLUMN IF NOT EXISTS "gridLevelsPerSide" INTEGER NOT NULL DEFAULT 10;
ALTER TABLE "Configuration" ADD COLUMN IF NOT EXISTS "gridDistancePercent" TEXT NOT NULL DEFAULT '5';
ALTER TABLE "Configuration" ADD COLUMN IF NOT EXISTS "traderTakeProfitPercent" TEXT NOT NULL DEFAULT '10';
ALTER TABLE "Configuration" ADD COLUMN IF NOT EXISTS "traderMaxLifetimeHours" DOUBLE PRECISION NOT NULL DEFAULT 12;

ALTER TABLE "Trader" ADD COLUMN IF NOT EXISTS "behavior" TEXT NOT NULL DEFAULT 'reversal';
ALTER TABLE "Trader" ADD COLUMN IF NOT EXISTS "startPrice" TEXT;
ALTER TABLE "Trader" ADD COLUMN IF NOT EXISTS "exitReason" TEXT;
ALTER TABLE "Trader" ADD COLUMN IF NOT EXISTS "gridLevelsPerSide" INTEGER;
ALTER TABLE "Trader" ADD COLUMN IF NOT EXISTS "gridDistancePercent" TEXT;
ALTER TABLE "Trader" ADD COLUMN IF NOT EXISTS "traderTakeProfitPercent" TEXT;

CREATE TABLE IF NOT EXISTS "GridLevel" (
    "id" TEXT NOT NULL,
    "traderId" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "direction" TEXT NOT NULL,
    "triggerPrice" TEXT NOT NULL,
    "limitPrice" TEXT NOT NULL,
    "weight" INTEGER NOT NULL,
    "allocatedMargin" TEXT NOT NULL,
    "notional" TEXT NOT NULL,
    "quantity" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "clientOrderId" TEXT,
    "exchangeOrderId" TEXT,
    "triggeredAt" TIMESTAMP(3),
    "filledAt" TIMESTAMP(3),
    "entryPrice" TEXT,
    "filledQuantity" TEXT,
    "fees" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GridLevel_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "GridLevel_traderId_direction_level_key" ON "GridLevel"("traderId", "direction", "level");
CREATE INDEX IF NOT EXISTS "GridLevel_traderId_idx" ON "GridLevel"("traderId");
CREATE INDEX IF NOT EXISTS "GridLevel_status_idx" ON "GridLevel"("status");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'GridLevel_traderId_fkey'
  ) THEN
    ALTER TABLE "GridLevel" ADD CONSTRAINT "GridLevel_traderId_fkey"
      FOREIGN KEY ("traderId") REFERENCES "Trader"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
