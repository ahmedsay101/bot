const WebSocket = require('ws');
const axios = require('axios');

class MarketActivityDetector {
  constructor(symbol = 'UNIUSDT', opts = {}) {
    this.symbol = symbol;
    this.mode = opts.mode || 'medium';
    this.client = axios.create({ baseURL: 'https://fapi.binance.com' });

    // WebSocket references
    this.wsKline = null;
    this.wsAgg = null;
    this.wsDepth = null;

    this.reconnectDelays = { kline: 5000, agg: 5000, depth: 5000 }; // 5 sec retry
    this.maxRetries = 10; // prevent infinite loops
    this.retryCount = { kline: 0, agg: 0, depth: 0 };

    this.reset();

    const modes = {
      medium: { volThreshold: 2, volPctThreshold: 0.6, scoreThreshold: 3.5, fastMovePct: 1.0 },
      strict: { volThreshold: 3, volPctThreshold: 1.2, scoreThreshold: 5, fastMovePct: 2.0 }
    };

    const paramsMode = modes[this.mode];
    this.params = {
      volWindow: opts.volWindow || 20,
      volThreshold: opts.volThreshold || paramsMode.volThreshold,
      volPctThreshold: opts.volPctThreshold || paramsMode.volPctThreshold,
      freqThreshold: opts.freqThreshold || 30,
      depthImbalanceThreshold: opts.depthImbalanceThreshold || 2.5,
      oiChangeWindow: opts.oiChangeWindow || 60,
      oiChangeThreshold: opts.oiChangeThreshold || 5,
      scoreThreshold: opts.scoreThreshold || paramsMode.scoreThreshold,
      emaShort: opts.emaShort || 5,
      emaLong: opts.emaLong || 20,
      fastMovePct: opts.fastMovePct || paramsMode.fastMovePct
    };

    this.init();
  }

  reset() {
    this.klineHistory = [];
    this.tradeCount = 0;
    this.depth = { bids: {}, asks: {} };
    this.openInterest = null;
    this.oiTimestamp = null;
    setInterval(() => (this.tradeCount = 0), 1000);
  }

  async init() {
    await this.preloadKlines();
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
      console.log(`✅ [${this.symbol}] Preloaded ${this.klineHistory.length} candles`);
    } catch (err) {
      console.error("❌ Failed to preload klines:", err.message);
    }
  }

  /** 🔄 Generic Reconnect Logic */
  reconnect(type) {
    if (this.retryCount[type] >= this.maxRetries) {
      console.error(`❌ [${type}] Max retries reached. Giving up.`);
      return;
    }
    this.retryCount[type]++;
    console.log(`🔄 [${type}] Reconnecting in ${this.reconnectDelays[type] / 1000}s...`);
    setTimeout(() => {
      if (type === 'kline') this.startKline();
      if (type === 'agg') this.startAggTrade();
      if (type === 'depth') this.startDepth();
    }, this.reconnectDelays[type]);
  }

  startKline() {
    const url = `wss://fstream.binance.com/ws/${this.symbol.toLowerCase()}@kline_1m`;
    console.log(`▶️ Connecting to KLINE WS: ${url}`);
    this.wsKline = new WebSocket(url);

    this.wsKline.on('open', () => {
      console.log('✅ KLINE WS connected');
      this.retryCount.kline = 0;
    });

    this.wsKline.on('message', msg => {
      const json = JSON.parse(msg);
      if (json.k && json.k.x) {
        const { v: volume, o, c } = json.k;
        this.klineHistory.push({ volume: parseFloat(volume), o: parseFloat(o), c: parseFloat(c) });
        if (this.klineHistory.length > this.params.volWindow) this.klineHistory.shift();
      }
    });

    this.wsKline.on('error', err => {
      console.error('⚠️ KLINE WS error:', err.message);
    });

    this.wsKline.on('close', () => {
      console.warn('⚠️ KLINE WS closed');
      this.reconnect('kline');
    });
  }

  startAggTrade() {
    const url = `wss://fstream.binance.com/ws/${this.symbol.toLowerCase()}@aggTrade`;
    console.log(`▶️ Connecting to AGG WS: ${url}`);
    this.wsAgg = new WebSocket(url);

    this.wsAgg.on('open', () => {
      console.log('✅ AGG WS connected');
      this.retryCount.agg = 0;
    });

    this.wsAgg.on('message', () => this.tradeCount++);

    this.wsAgg.on('error', err => {
      console.error('⚠️ AGG WS error:', err.message);
    });

    this.wsAgg.on('close', () => {
      console.warn('⚠️ AGG WS closed');
      this.reconnect('agg');
    });
  }

  startDepth() {
    const url = `wss://fstream.binance.com/ws/${this.symbol.toLowerCase()}@depth20@100ms`;
    console.log(`▶️ Connecting to DEPTH WS: ${url}`);
    this.wsDepth = new WebSocket(url);

    this.wsDepth.on('open', () => {
      console.log('✅ DEPTH WS connected');
      this.retryCount.depth = 0;
    });

    this.wsDepth.on('message', msg => {
      const json = JSON.parse(msg);
      this.depth.bids = json.b;
      this.depth.asks = json.a;
    });

    this.wsDepth.on('error', err => {
      console.error('⚠️ DEPTH WS error:', err.message);
    });

    this.wsDepth.on('close', () => {
      console.warn('⚠️ DEPTH WS closed');
      this.reconnect('depth');
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

  computeEMA(period) {
    if (this.klineHistory.length < period) return null;
    const k = 2 / (period + 1);
    return this.klineHistory
      .slice(-period)
      .reduce((ema, candle, i) => (i === 0 ? candle.c : candle.c * k + ema * (1 - k)), 0);
  }

  compute() {
    if (this.klineHistory.length === 0) {
      return { active: false, reason: 'no data yet' };
    }

    const avgVol = this.average(this.klineHistory, 'volume');
    const last = this.klineHistory[this.klineHistory.length - 1];

    const volSpike = last.volume > avgVol * this.params.volThreshold;
    const pctMove = Math.abs((last.c - last.o) / last.o) * 100;
    const volPct = pctMove > this.params.volPctThreshold;

    const recent = this.klineHistory.slice(-5);
    let fastMove = false;
    if (recent.length === 5) {
      const move5m = ((recent[4].c - recent[0].c) / recent[0].c) * 100;
      fastMove = Math.abs(move5m) >= this.params.fastMovePct;
    }

    const freqHigh = this.tradeCount > this.params.freqThreshold;

    const topBid = parseFloat(this.depth.bids?.[0]?.[1] || 0);
    const topAsk = parseFloat(this.depth.asks?.[0]?.[1] || 0);
    const imbalance = topBid && topAsk ? topBid / topAsk : 1;
    const depthHigh = imbalance > this.params.depthImbalanceThreshold || imbalance < 1 / this.params.depthImbalanceThreshold;

    let oiHigh = false;
    if (this.oiDelta && this.oiTimeDelta) {
      oiHigh = Math.abs(this.oiDelta) > this.params.oiChangeThreshold;
    }

    const emaShort = this.computeEMA(this.params.emaShort);
    const emaLong = this.computeEMA(this.params.emaLong);
    let trendDirection = "NONE";
    let emaTrend = false;

    if (emaShort && emaLong) {
      if (emaShort > emaLong * 1.002) {
        trendDirection = "UP";
        emaTrend = true;
      } else if (emaShort < emaLong * 0.998) {
        trendDirection = "DOWN";
        emaTrend = true;
      }
    }

    const score =
      (volSpike ? 2 : 0) +
      (volPct ? 1.5 : 0) +
      (fastMove ? 2 : 0) +
      (freqHigh ? 1.5 : 0) +
      (depthHigh ? 1 : 0) +
      (oiHigh ? 2 : 0) +
      (emaTrend ? 1.5 : 0);

    const active = score >= this.params.scoreThreshold;

    const reasons = [];
    if (volSpike) reasons.push('volume spike');
    if (volPct) reasons.push('large 1m candle');
    if (fastMove) reasons.push('fast 5m move');
    if (freqHigh) reasons.push('high trade frequency');
    if (depthHigh) reasons.push('order book imbalance');
    if (oiHigh) reasons.push('open interest change');
    if (emaTrend) reasons.push(`EMA trend (${trendDirection})`);

    return {
      active,
      score,
      trendDirection,
      reasons: reasons.length ? reasons : ['low activity'],
      lastPrice: last.c
    };
  }
}

module.exports = MarketActivityDetector;
