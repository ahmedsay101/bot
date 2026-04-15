const config = require("../utils/config");
const { log } = require("../utils/logger");

const DEFAULTS = {
  maxAbsChange24h: 80,
  maxVolumeSpike: 3,
  maxSpreadPct: 0.2,
  maxAbsFundingRate: 0.05,
  maxAtrRatio: 0.08,
  minListingAgeDays: 7,
  atrPeriod: 14,
  concurrencyLimit: 5
};

function getThresholds() {
  return { ...DEFAULTS, ...(config.safetyFilter || {}) };
}

function calculateATR(klines, period) {
  if (!Array.isArray(klines) || klines.length < 2) return Infinity;
  const trs = [];
  for (let i = 1; i < klines.length; i++) {
    const high = Number(klines[i][2]);
    const low = Number(klines[i][3]);
    const prevClose = Number(klines[i - 1][4]);
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trs.push(tr);
  }
  const slice = trs.slice(-period);
  if (slice.length === 0) return Infinity;
  return slice.reduce((s, v) => s + v, 0) / slice.length;
}

async function runBatch(tasks, limit) {
  const results = [];
  for (let i = 0; i < tasks.length; i += limit) {
    const batch = tasks.slice(i, i + limit);
    const batchResults = await Promise.all(batch.map((fn) => fn()));
    results.push(...batchResults);
  }
  return results;
}

/**
 * Filter scanner candidates down to "safe" symbols.
 * @param {Array<{symbol: string, change: number}>} candidates
 * @param {object} api - BinanceApi instance
 * @param {Map<string, object>} exchangeInfoMap - symbol → { onboardDate } from exchangeInfo
 * @returns {Promise<Array<{symbol: string, change: number}>>}
 */
async function filterSafeSymbols(candidates, api, exchangeInfoMap) {
  if (!candidates || candidates.length === 0) return [];
  const t = getThresholds();
  const now = Date.now();

  const tasks = candidates.map((candidate) => async () => {
    const { symbol, change } = candidate;
    const reasons = [];

    // 1. Absolute 24h change
    if (Math.abs(change) > t.maxAbsChange24h) {
      reasons.push(`24h change ${change.toFixed(1)}% > ±${t.maxAbsChange24h}%`);
    }

    // 2. Listing age
    let listingKnown = false;
    if (exchangeInfoMap) {
      const info = exchangeInfoMap.get(symbol);
      if (info && info.onboardDate) {
        listingKnown = true;
        const ageDays = (now - info.onboardDate) / 86_400_000;
        if (ageDays < t.minListingAgeDays) {
          reasons.push(`listed ${ageDays.toFixed(1)}d ago < ${t.minListingAgeDays}d`);
        }
      }
    }
    if (!listingKnown) {
      try {
        const dailyKlines = await api.getKlines(symbol, "1d", t.minListingAgeDays);
        if (Array.isArray(dailyKlines) && dailyKlines.length < t.minListingAgeDays) {
          reasons.push(`only ${dailyKlines.length} daily candles < ${t.minListingAgeDays}d`);
        }
      } catch (_) {
        // skip if klines unavailable
      }
    }

    // Skip expensive API calls if already rejected by cheap checks
    if (reasons.length > 0) {
      for (const r of reasons) log("SAFETY", `${symbol} rejected: ${r}`);
      return null;
    }

    try {
      // Fetch klines, depth, funding in parallel
      const [klines, depth, premiumIndex] = await Promise.all([
        api.getKlines(symbol, "1h", 25),
        api.getDepth(symbol, 5),
        api._request("GET", "/fapi/v1/premiumIndex", { symbol })
      ]);

      // 3. Volume spike: 1h volume vs avg hourly volume
      if (Array.isArray(klines) && klines.length >= 2) {
        const volumes = klines.map((k) => Number(k[7])); // quoteVolume
        const avgHourlyVol = volumes.slice(0, -1).reduce((s, v) => s + v, 0) / Math.max(volumes.length - 1, 1);
        const lastHourVol = volumes[volumes.length - 1] || 0;
        if (avgHourlyVol > 0 && lastHourVol > t.maxVolumeSpike * avgHourlyVol) {
          reasons.push(`1h vol spike ${(lastHourVol / avgHourlyVol).toFixed(1)}x > ${t.maxVolumeSpike}x`);
        }
      }

      // 4. Bid-ask spread
      if (depth && Array.isArray(depth.bids) && Array.isArray(depth.asks) &&
          depth.bids.length > 0 && depth.asks.length > 0) {
        const bestBid = Number(depth.bids[0][0]);
        const bestAsk = Number(depth.asks[0][0]);
        const mid = (bestBid + bestAsk) / 2;
        if (mid > 0) {
          const spreadPct = ((bestAsk - bestBid) / mid) * 100;
          if (spreadPct > t.maxSpreadPct) {
            reasons.push(`spread ${spreadPct.toFixed(3)}% > ${t.maxSpreadPct}%`);
          }
        }
      }

      // 5. Funding rate
      if (premiumIndex) {
        const fundingRate = Number(premiumIndex.lastFundingRate);
        if (Number.isFinite(fundingRate) && Math.abs(fundingRate) > t.maxAbsFundingRate) {
          reasons.push(`funding ${(fundingRate * 100).toFixed(3)}% > ±${t.maxAbsFundingRate * 100}%`);
        }
      }

      // 6. ATR / price ratio
      if (Array.isArray(klines) && klines.length >= 2) {
        const atr = calculateATR(klines, t.atrPeriod);
        const lastClose = Number(klines[klines.length - 1][4]);
        if (lastClose > 0) {
          const atrRatio = atr / lastClose;
          if (atrRatio > t.maxAtrRatio) {
            reasons.push(`ATR ratio ${(atrRatio * 100).toFixed(2)}% > ${t.maxAtrRatio * 100}%`);
          }
        }
      }
    } catch (err) {
      reasons.push(`API error: ${err.message}`);
    }

    if (reasons.length > 0) {
      for (const r of reasons) log("SAFETY", `${symbol} rejected: ${r}`);
      return null;
    }

    log("SAFETY", `${symbol} passed all checks`);
    return candidate;
  });

  const results = await runBatch(tasks, t.concurrencyLimit);
  return results.filter((r) => r !== null);
}

module.exports = { filterSafeSymbols, calculateATR };
