const WebSocket = require('ws');
const axios = require('axios');

class MomentumBreakoutDetector {
  constructor(symbol = 'UNIUSDT', targetMove = 0.06, opts = {}) {
    this.symbol = symbol;
    this.targetMove = targetMove;
    this.client = axios.create({ baseURL: 'https://fapi.binance.com' });

    this.params = {
      depthLevels: opts.depthLevels || 5,
      imbalanceThreshold: opts.imbalanceThreshold || 3.0,
      sustainTime: opts.sustainTime || 5000,
      minTradeFrequency: opts.minTradeFrequency || 20,
      recentVolWindow: opts.recentVolWindow || 5,
      recentVolThreshold: opts.recentVolThreshold || 0.3,
      momentumWindow: opts.momentumWindow || 10, // 10 recent ticks
      candleExpansionFactor: opts.candleExpansionFactor || 1.8, // large candle multiplier
      emaShort: opts.emaShort || 5,
      emaLong: opts.emaLong || 20
    };

    this.depthHistory = [];
    this.tradeCount = 0;
    this.klineHistory = [];
    this.priceTicks = [];

    this.wsDepth = null;
    this.wsAgg = null;
    this.wsTicker = null;

    setInterval(() => (this.tradeCount = 0), 1000);

    this.init();
  }

  async init() {
    await this.preloadKlines();
    this.startDepth();
    this.startAggTrade();
    this.startTicker(); // ✅ new price momentum stream
  }

  async preloadKlines() {
    try {
      const res = await this.client.get('/fapi/v1/klines', {
        params: { symbol: this.symbol, interval: '1m', limit: 20 }
      });
      this.klineHistory = res.data.map(k => ({
        o: parseFloat(k[1]),
        c: parseFloat(k[4])
      }));
    } catch (err) {
      console.error("❌ Failed to load klines:", err.message);
    }
  }

  startAggTrade() {
    const url = `wss://fstream.binance.com/ws/${this.symbol.toLowerCase()}@aggTrade`;
    this.wsAgg = new WebSocket(url);
    this.wsAgg.on('message', () => this.tradeCount++);
  }

  startDepth() {
    const url = `wss://fstream.binance.com/ws/${this.symbol.toLowerCase()}@depth20@100ms`;
    this.wsDepth = new WebSocket(url);
    this.wsDepth.on('message', msg => {
      const json = JSON.parse(msg);
      this.depthHistory.push({
        bids: json.b.slice(0, this.params.depthLevels),
        asks: json.a.slice(0, this.params.depthLevels),
        ts: Date.now()
      });
      if (this.depthHistory.length > 100) this.depthHistory.shift();
    });
  }

  /** ✅ Stream live price for momentum detection */
  startTicker() {
    const url = `wss://fstream.binance.com/ws/${this.symbol.toLowerCase()}@trade`;
    this.wsTicker = new WebSocket(url);
    this.wsTicker.on('message', msg => {
      const trade = JSON.parse(msg);
      const price = parseFloat(trade.p);
      const ts = Date.now();
      this.priceTicks.push({ price, ts });
      if (this.priceTicks.length > 50) this.priceTicks.shift();
    });
  }

  getCurrentPrice() {
    if (this.klineHistory.length === 0) return null;
    return this.klineHistory[this.klineHistory.length - 1].c;
  }

  calculateImbalance(snapshot) {
    const bidVol = snapshot.bids.reduce((s, [_, q]) => s + parseFloat(q), 0);
    const askVol = snapshot.asks.reduce((s, [_, q]) => s + parseFloat(q), 0);
    return bidVol / askVol;
  }

  sustainedImbalance() {
    const now = Date.now();
    const recent = this.depthHistory.filter(d => now - d.ts < this.params.sustainTime);
    if (recent.length === 0) return { signal: null, avgImb: 1 };
    const avgImb = recent.map(this.calculateImbalance, this).reduce((a, b) => a + b, 0) / recent.length;
    if (avgImb > this.params.imbalanceThreshold) return { signal: 'BUY', avgImb };
    if (avgImb < 1 / this.params.imbalanceThreshold) return { signal: 'SELL', avgImb };
    return { signal: null, avgImb };
  }

  recentVolatility() {
    if (this.klineHistory.length < this.params.recentVolWindow) return 0;
    const r = this.klineHistory.slice(-this.params.recentVolWindow);
    return Math.abs((r[r.length - 1].c - r[0].c) / r[0].c) * 100;
  }

  /** ✅ Detects if current candle is large compared to average */
  candleExpansion() {
    if (this.klineHistory.length < 6) return 0;
    const recent = this.klineHistory.slice(-6, -1);
    const avgSize = recent.reduce((s, c) => s + Math.abs(c.c - c.o), 0) / recent.length;
    const last = this.klineHistory[this.klineHistory.length - 1];
    const lastSize = Math.abs(last.c - last.o);
    return lastSize / avgSize;
  }

  /** ✅ Detect short-term momentum based on recent price ticks */
  momentumFactor() {
    if (this.priceTicks.length < 5) return 0;
    const recent = this.priceTicks.slice(-this.params.momentumWindow);
    const first = recent[0].price;
    const last = recent[recent.length - 1].price;
    const movePct = Math.abs((last - first) / first) * 100;
    return Math.min(movePct / ((this.targetMove / first) * 100), 1); // normalized
  }

  computeEMA(period) {
    if (this.klineHistory.length < period) return null;
    const k = 2 / (period + 1);
    return this.klineHistory.slice(-period).reduce((ema, c, i) =>
      i === 0 ? c.c : c.c * k + ema * (1 - k), 0);
  }

  getBreakoutProbability() {
    const price = this.getCurrentPrice();
    if (!price) return { probability: 0, likely: false };

    const { signal, avgImb } = this.sustainedImbalance();
    const vol5m = this.recentVolatility();
    const tradesActive = this.tradeCount > this.params.minTradeFrequency;

    const emaShort = this.computeEMA(this.params.emaShort);
    const emaLong = this.computeEMA(this.params.emaLong);
    const emaTrend = emaShort && emaLong && (emaShort > emaLong * 1.001 || emaShort < emaLong * 0.999);

    const requiredPct = (this.targetMove / price) * 100;

    // ✅ Factors
    const imbalanceScore = Math.min(avgImb / this.params.imbalanceThreshold, 2) / 2;
    const tradeScore = tradesActive ? 1 : 0;
    const volScore = Math.min(vol5m / requiredPct, 1);
    const sustainScore = signal ? 1 : 0;
    const momentumScore = this.momentumFactor();
    const candleBoost = this.candleExpansion() > this.params.candleExpansionFactor ? 1 : 0;
    const emaScore = emaTrend ? 0.5 : 0;

    // ✅ Weighted probability
    const probability =
      imbalanceScore * 0.25 +
      tradeScore * 0.15 +
      volScore * 0.15 +
      sustainScore * 0.1 +
      momentumScore * 0.2 +
      candleBoost * 0.1 +
      emaScore * 0.05;

    return {
      probability,
      likely: probability >= 0.6,
      direction: signal || (emaTrend ? (emaShort > emaLong ? "BUY" : "SELL") : "UNKNOWN"),
      factors: { imbalanceScore, tradeScore, volScore, sustainScore, momentumScore, candleBoost, emaScore }
    };
  }
}

module.exports = MomentumBreakoutDetector;