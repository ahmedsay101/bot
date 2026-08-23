export {
  ema,
  calcAdx,
  calcAdxDi,
  calcRoc,
  average,
  evaluateTrendFromCandles,
  strengthFromScore,
  statusFromStrength,
  DEFAULT_TREND_CALC_CONFIG,
  type Candle,
  type TrendSignals,
  type TrendResult,
  type TrendCalcConfig,
  type TrendStrength,
  type TrendStatus,
  type AdxDiResult,
} from './trendCalc';

export {
  TrendDetector,
  DEFAULT_TREND_DETECTOR_CONFIG,
  combineMultiTimeframeTrends,
  mapLimit,
  emptyTrendView,
  type TrendDetectorConfig,
  type TrendDetectionView,
  type MultiTrendSignals,
} from './TrendDetector';

export {
  evaluateTrendConfirmation,
  DEFAULT_TREND_ENGINE_CONFIG,
  toLegacyCompatible,
  isTradeableRegime,
  type TrendConfirmation,
  type TrendEngineConfig,
  type TrendDecision,
  type MarketRegime,
  type TfKey,
  type RejectionReasonCode,
} from './trendEngine';

export {
  buildHistoricalRecord,
  calibrateConfidence,
  DEFAULT_FORWARD_HORIZONS,
  type HistoricalSignalRecord,
  type CalibrationBucket,
} from './historicalValidation';
