-- Strategy defaults + hedge lifecycle counters on Trader
ALTER TABLE "Trader" ADD COLUMN IF NOT EXISTS "hedgeOrdersCreated" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Trader" ADD COLUMN IF NOT EXISTS "hedgeOrdersTriggered" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Trader" ADD COLUMN IF NOT EXISTS "hedgePositionsOpened" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Trader" ADD COLUMN IF NOT EXISTS "hedgePositionsClosed" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Trader" ADD COLUMN IF NOT EXISTS "hedgeStopLosses" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Trader" ADD COLUMN IF NOT EXISTS "hedgeTakeProfits" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Trader" ADD COLUMN IF NOT EXISTS "hedgeRecreations" INTEGER NOT NULL DEFAULT 0;

-- Update Configuration column defaults for new installs / resets
ALTER TABLE "Configuration" ALTER COLUMN "hedgeTpPercent" SET DEFAULT '0.10';
ALTER TABLE "Configuration" ALTER COLUMN "hedgeSlPercent" SET DEFAULT '0.03';
ALTER TABLE "Configuration" ALTER COLUMN "shortTpPercent" SET DEFAULT '0.10';

-- Align singleton config row to new strategy defaults when still on legacy values
UPDATE "Configuration"
SET
  "hedgeTpPercent" = '0.10',
  "hedgeSlPercent" = '0.03',
  "shortTpPercent" = '0.10'
WHERE "id" = 'singleton'
  AND (
    "hedgeTpPercent" = '0.50'
    OR "hedgeSlPercent" = '0.10'
    OR "shortTpPercent" = '0.20'
  );
