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
