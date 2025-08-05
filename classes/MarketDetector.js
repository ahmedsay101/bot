const WebSocket = require('ws');
const axios = require('axios');

class MarketActivityDetector {
  constructor(symbol = 'UNIUSDT', opts = {}) {
    this.symbol = symbol;
    this.wsKline = null;
    this.wsAgg = null;
    this.wsDepth = null;
    this.client = axios.create({ baseURL: 'https://fapi.binance.com' });

    this.reset();

    // 🔥 Stricter thresholds for stronger signals
    this.params = {
      volWindow: opts.volWindow || 20,              // number of candles for average
      volThreshold: opts.volThreshold || 3,         // require >3x avg volume
      volPctThreshold: opts.volPctThreshold || 1.2, // require >1.2% candle move
      freqThreshold: opts.freqThreshold || 30,      // require >30 trades/sec
      depthImbalanceThreshold: opts.depthImbalanceThreshold || 2.5, // strong imbalance
      oiChangeWindow: opts.oiChangeWindow || 60,    // seconds
      oiChangeThreshold: opts.oiChangeThreshold || 5, // require >5% open interest shift
      scoreThreshold: opts.scoreThreshold || 5      // minimum weighted score
    };

    this.init();
  }

  reset() {
    this.klineHistory = [];
    this.tradeCount = 0;
    this.depth = { bids: {}, asks: {} };
    this.openInterest = null;
    this.oiTimestamp = null;
    setInterval(() => (this.tradeCount = 0), 1000); // reset trade counter every sec
  }

  async init() {
    await this.preloadKlines(); // ✅ preload historical candles for instant readiness
    this.startKline();
    this.startAggTrade();
    this.startDepth();
    await this.pollOpenInterest();
    setInterval(() => this.pollOpenInterest(), this.params.oiChangeWindow * 1000);
  }

  async preloadKlines() {
    try {
      const res = await this.client.get('/fapi/v1/klines', {
        params: { symbol: this.symbol, interval: '1m', limit: this.params.volWindow }
      });
      this.klineHistory = res.data.map(k => ({
        o: parseFloat(k[1]),
        c: parseFloat(k[4]),
        volume: parseFloat(k[5])
      }));
    } catch (err) {
      console.error("⚠️ Failed to preload klines:", err.message);
    }
  }

  startKline() {
    const url = `wss://fstream.binance.com/ws/${this.symbol.toLowerCase()}@kline_1m`;
    this.wsKline = new WebSocket(url);
    this.wsKline.on('message', msg => {
      const json = JSON.parse(msg);
      if (json.k && json.k.x) {
        const { v: volume, o, c } = json.k;
        this.klineHistory.push({ volume: parseFloat(volume), o: parseFloat(o), c: parseFloat(c) });
        if (this.klineHistory.length > this.params.volWindow) this.klineHistory.shift();
      }
    });
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
      this.depth.bids = json.b;
      this.depth.asks = json.a;
    });
  }

  async pollOpenInterest() {
    try {
      const resp = await this.client.get('/fapi/v1/openInterest', { params: { symbol: this.symbol } });
      const newOi = parseFloat(resp.data.openInterest);
      const now = Date.now() / 1000;
      if (this.openInterest !== null) {
        this.oiDelta = ((newOi - this.openInterest) / this.openInterest) * 100;
        this.oiTimeDelta = now - this.oiTimestamp;
      }
      this.openInterest = newOi;
      this.oiTimestamp = now;
    } catch (err) {
      console.error("⚠️ Failed to fetch Open Interest:", err.message);
    }
  }

  average(arr, key) {
    return arr.reduce((sum, x) => sum + (key ? x[key] : x), 0) / arr.length;
  }

  compute() {
    if (this.klineHistory.length === 0) return { active: false, reason: 'no data yet' };

    // --- Volume & Price Volatility ---
    const avgVol = this.average(this.klineHistory, 'volume');
    const last = this.klineHistory[this.klineHistory.length - 1];
    const volSpike = last.volume > avgVol * this.params.volThreshold;
    const pctMove = Math.abs((last.c - last.o) / last.o) * 100;
    const volPct = pctMove > this.params.volPctThreshold;

    // --- Trade Frequency ---
    const freqHigh = this.tradeCount > this.params.freqThreshold;

    // --- Order Book Imbalance ---
    const topBid = parseFloat(this.depth.bids?.[0]?.[1] || 0);
    const topAsk = parseFloat(this.depth.asks?.[0]?.[1] || 0);
    const imbalance = topBid && topAsk ? topBid / topAsk : 1;
    const depthHigh = imbalance > this.params.depthImbalanceThreshold || imbalance < 1 / this.params.depthImbalanceThreshold;

    // --- Open Interest Change ---
    let oiHigh = false;
    if (this.oiDelta && this.oiTimeDelta) {
      oiHigh = Math.abs(this.oiDelta) > this.params.oiChangeThreshold;
    }

    // --- Weighted Composite Score ---
    const score =
      (volSpike ? 2.5 : 0) +
      (volPct ? 2 : 0) +
      (freqHigh ? 2 : 0) +
      (depthHigh ? 1.5 : 0) +
      (oiHigh ? 2.5 : 0);

    const active = score >= this.params.scoreThreshold;

    const reasons = [];
    if (volSpike) reasons.push('massive volume spike');
    if (volPct) reasons.push('large price move');
    if (freqHigh) reasons.push('extremely high trade frequency');
    if (depthHigh) reasons.push('strong order book imbalance');
    if (oiHigh) reasons.push('significant open interest change');

    return { active, score, reasons };
  }
}

module.exports = MarketActivityDetector;
