const WebSocket = require('ws');
const axios = require('axios');

class BreakoutDetector {
  constructor(symbol = 'UNIUSDT', targetMove = 0.06, opts = {}) {
    this.symbol = symbol;
    this.targetMove = targetMove;
    this.client = axios.create({ baseURL: 'https://fapi.binance.com' });

    // Tunable parameters
    this.params = {
      depthLevels: opts.depthLevels || 5,
      imbalanceThreshold: opts.imbalanceThreshold || 3.0,
      sustainTime: opts.sustainTime || 5000,
      minTradeFrequency: opts.minTradeFrequency || 20,
      recentVolWindow: opts.recentVolWindow || 5,
      recentVolThreshold: opts.recentVolThreshold || 0.3 // %
    };

    this.depthHistory = [];
    this.tradeCount = 0;
    this.klineHistory = [];

    this.wsDepth = null;
    this.wsAgg = null;

    this.init();

    setInterval(() => (this.tradeCount = 0), 1000);
  }

  async init() {
    await this.preloadKlines();
    this.startDepth();
    this.startAggTrade();
  }

  async preloadKlines() {
    try {
      const res = await this.client.get('/fapi/v1/klines', {
        params: { symbol: this.symbol, interval: '1m', limit: 10 }
      });
      this.klineHistory = res.data.map(k => ({ c: parseFloat(k[4]) }));
    } catch (err) {
      console.error("❌ Failed to load historical klines:", err.message);
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

  getCurrentPrice() {
    if (this.klineHistory.length === 0) return null;
    return this.klineHistory[this.klineHistory.length - 1].c;
  }

  calculateImbalance(snapshot) {
    const bidVol = snapshot.bids.reduce((sum, [_, qty]) => sum + parseFloat(qty), 0);
    const askVol = snapshot.asks.reduce((sum, [_, qty]) => sum + parseFloat(qty), 0);
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
    const recent = this.klineHistory.slice(-this.params.recentVolWindow);
    const first = recent[0].c;
    const last = recent[recent.length - 1].c;
    return Math.abs((last - first) / first) * 100;
  }

  /** ✅ Computes breakout probability */
  getBreakoutProbability() {
    const price = this.getCurrentPrice();
    if (!price) return { probability: 0, likely: false };

    const { signal, avgImb } = this.sustainedImbalance();
    const vol5m = this.recentVolatility();
    const tradesActive = this.tradeCount > this.params.minTradeFrequency;

    const requiredPct = (this.targetMove / price) * 100;

    // --- Scores (0-1 scale) ---
    const imbalanceScore = Math.min(avgImb / this.params.imbalanceThreshold, 2) / 2; // 0..1
    const tradeScore = tradesActive ? 1 : 0;
    const volScore = Math.min(vol5m / requiredPct, 1); // how much volatility covers required move
    const sustainScore = signal ? 1 : 0;

    // --- Weighted probability ---
    const probability =
      imbalanceScore * 0.4 +
      tradeScore * 0.2 +
      volScore * 0.3 +
      sustainScore * 0.1;

    return {
      probability,
      likely: probability >= 0.7,
      direction: signal || 'UNKNOWN',
      factors: { imbalanceScore, tradeScore, volScore, sustainScore }
    };
  }
}

module.exports = BreakoutDetector;
