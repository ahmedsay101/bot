-- Toggle: TP→opposite / SL→same when true (default false = legacy TP→same / SL→opposite)
ALTER TABLE "Configuration" ADD COLUMN IF NOT EXISTS "switchPositionOnTakeProfit" BOOLEAN NOT NULL DEFAULT false;
