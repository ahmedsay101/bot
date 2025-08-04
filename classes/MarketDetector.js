// marketActivityDetector.js
const WebSocket = require('ws');
const axios = require('axios');

class MarketActivityDetector {
  constructor(symbol='UNIUSDT', opts={}) {
    this.symbol = symbol;
    this.wsKline = null;
    this.wsAgg = null;
    this.wsDepth = null;
    this.client = axios.create({ baseURL: 'https://fapi.binance.com' });
    this.reset();
    this.params = {
      volWindow: opts.volWindow || 20,   // number of periods to average
      volThreshold: opts.volThreshold || 2, // multiple of avg volume
      volPctThreshold: opts.volPctThreshold || 0.5, // percent change threshold
      freqThreshold: opts.freqThreshold || 10, // trades/sec
      depthImbalanceThreshold: opts.depthImbalanceThreshold || 1.5, // bid/ask
      oiChangeWindow: opts.oiChangeWindow || 60 // seconds window
    };
    this.init();
  }

  reset() {
    this.klineHistory = [];
    this.tradeCount = 0;
    this.depth = { bids: {}, asks: {} };
    this.openInterest = null;
    this.oiTimestamp = null;
    setInterval(()=> this.tradeCount = 0, 1000);
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
    }
    catch(error) {
      console.log(error);
    }
  }

  async init() {
    await this.preloadKlines();
    this.startKline();
    this.startAggTrade();
    this.startDepth();
    this.pollOpenInterest();
    setInterval(() => this.pollOpenInterest(), this.params.oiChangeWindow*1000);
  }

  startKline() {
    try {
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
    catch(error) {
      console.log(error);
    }

  }

  startAggTrade() {
    try {
      const url = `wss://fstream.binance.com/ws/${this.symbol.toLowerCase()}@aggTrade`;
      this.wsAgg = new WebSocket(url);
      this.wsAgg.on('message', msg => { this.tradeCount++; });
    }
    catch(error) {
      console.log(error);
    }
  }

  startDepth() {
    try {
      const url = `wss://fstream.binance.com/ws/${this.symbol.toLowerCase()}@depth20@100ms`;
      this.wsDepth = new WebSocket(url);
      this.wsDepth.on('message', msg => {
        const json = JSON.parse(msg);
        this.depth.bids = json.b; this.depth.asks = json.a;
      });
    }
    catch(error) {
      console.log(error);
    }
  }

  async pollOpenInterest() {
    try {
      const resp = await this.client.get('/fapi/v1/openInterest', { params: { symbol: this.symbol } });
      const newOi = parseFloat(resp.data.openInterest);
      const now = Date.now()/1000;
      if (this.openInterest !== null) {
        this.oiDelta = (newOi - this.openInterest) / this.openInterest * 100;
        this.oiTimeDelta = now - this.oiTimestamp;
      }
      this.openInterest = newOi;
      this.oiTimestamp = now;
    }
    catch(error) {
      console.log(error);
    }
  }

  average(arr, key) {
    return arr.reduce((sum,x)=> sum+(key? x[key]: x),0)/arr.length;
  }

  compute() {
    if (this.klineHistory.length < this.params.volWindow) return { active: false, reason:'warming up' };
    const avgVol = this.average(this.klineHistory, 'volume');
    const last = this.klineHistory[this.klineHistory.length-1];
    const volSpike = last.volume > avgVol * this.params.volThreshold;
    const pctMove = Math.abs((last.c - last.o)/last.o) * 100;
    const volPct = pctMove > this.params.volPctThreshold;

    const freq = this.tradeCount;
    const freqHigh = freq > this.params.freqThreshold;

    const topBid = parseFloat(this.depth.bids[0]?.[1] || 0);
    const topAsk = parseFloat(this.depth.asks[0]?.[1] || 0);
    const imbalance = topBid && topAsk ? topBid/topAsk : 1;
    const depthHigh = imbalance > this.params.depthImbalanceThreshold || imbalance < 1/this.params.depthImbalanceThreshold;

    let oiHigh=false;
    if (this.oiDelta && this.oiTimeDelta) {
      oiHigh = Math.abs(this.oiDelta) > 1; // >1% change in window
    }

    const score = [volSpike||volPct, freqHigh, depthHigh, oiHigh].filter(b=>b).length;
    const active = score >= 3;

    const reasons = [];
    if (volSpike) reasons.push('volume spike');
    if (volPct) reasons.push('price volatility');
    if (freqHigh) reasons.push('high trade frequency');
    if (depthHigh) reasons.push('order‑book imbalance');
    if (oiHigh) reasons.push('open interest shift');

    return { active, score, reasons };
  }
}

module.exports = MarketActivityDetector;
