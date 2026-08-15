-- Binance Futures maker/taker fee rates (VIP0 defaults: 0.02% / 0.05%)
ALTER TABLE "Configuration" ADD COLUMN IF NOT EXISTS "makerFeeRate" TEXT NOT NULL DEFAULT '0.0002';
ALTER TABLE "Configuration" ADD COLUMN IF NOT EXISTS "takerFeeRate" TEXT NOT NULL DEFAULT '0.0005';
ALTER TABLE "Configuration" ALTER COLUMN "feeRate" SET DEFAULT '0.0005';
