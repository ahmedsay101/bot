-- SL resets capital step to 1; track atomic resets (not gradual decreases)
ALTER TABLE "Trader" ADD COLUMN IF NOT EXISTS "stepResets" INTEGER NOT NULL DEFAULT 0;
