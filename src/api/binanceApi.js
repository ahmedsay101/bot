const crypto = require("crypto");
const EventEmitter = require("events");
const WebSocket = require("ws");
const config = require("../utils/config");
const { log } = require("../utils/logger");
const store = require("../state/store");

class BinanceApi extends EventEmitter {
  constructor() {
    super();
    this.mode = config.mode;
    this.symbolStreams = new Set();
    this.ws = null;
    this.listenKey = null;

    this.testOrders = new Map();
    this.testPositions = new Map();
    this.testBalance = config.startingBalanceUSDT;
    this.bestBook = new Map();
    this.markPrices = new Map();
    this.lastSimPrice = new Map();
    this.reconnectTimer = null;
    this.wsLastMessageAt = 0;
    this.wsWatchdog = null;
  }

  async startMarketStreams(symbols) {
    this.symbolStreams = new Set(symbols);
    await this._connectMarketWs();
  }

  async updateSymbols(symbols) {
    const next = new Set(symbols);
    const changed = next.size !== this.symbolStreams.size ||
      [...next].some((s) => !this.symbolStreams.has(s));
    if (!changed) return;
    this.symbolStreams = next;
    if (this.ws) this.ws.terminate();
    await this._connectMarketWs();
  }

  async _connectMarketWs() {
    if (this.symbolStreams.size === 0) return;
    const streams = [];
    for (const symbol of this.symbolStreams) {
      const lower = symbol.toLowerCase();
      streams.push(`${lower}@markPrice@1s`);
      streams.push(`${lower}@bookTicker`);
    }
    const url = `${config.baseWsUrl}/stream?streams=${streams.join("/")}`;
    const ws = new WebSocket(url);
    this.ws = ws;
    this.wsLastMessageAt = Date.now();
    if (this.wsWatchdog) {
      clearInterval(this.wsWatchdog);
      this.wsWatchdog = null;
    }

    ws.on("open", () => {
      if (this.ws !== ws) return;
      log("BINANCE", `Market WS connected (${this.symbolStreams.size} symbols)`);
      store.setMarketStatus({ ws: "connected" });
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
    });

    ws.on("message", (raw) => {
      if (this.ws !== ws) return;
      this.wsLastMessageAt = Date.now();
      try {
        const data = JSON.parse(raw.toString());
        const stream = data.stream || "";
        const payload = data.data || {};

        if (stream.endsWith("@markPrice@1s")) {
          const symbol = payload.s;
          const price = Number(payload.p);
          this.markPrices.set(symbol, price);
          this.emit("markPrice", { symbol, price });
          if (this.mode === "test") this._simulateFills(symbol, price);
        }

        if (stream.endsWith("@bookTicker")) {
          const symbol = payload.s;
          const bid = Number(payload.b);
          const ask = Number(payload.a);
          this.bestBook.set(symbol, { bid, ask });
          this.emit("bookTicker", { symbol, bid, ask });
          if (this.mode === "test" && Number.isFinite(bid) && Number.isFinite(ask)) {
            this._simulateFills(symbol, (bid + ask) / 2);
          }
        }
      } catch (err) {
        log("BINANCE", `WS parse error: ${err.message}`);
      }
    });

    this.wsWatchdog = setInterval(() => {
      if (this.ws !== ws) return;
      const now = Date.now();
      if (now - this.wsLastMessageAt > 10000) {
        log("BINANCE", "Market WS stale, reconnecting");
        ws.terminate();
      }
    }, 5000);

    ws.on("close", () => {
      if (this.ws !== ws) return;
      log("BINANCE", "Market WS closed");
      store.setMarketStatus({ ws: "disconnected" });
      if (this.wsWatchdog) {
        clearInterval(this.wsWatchdog);
        this.wsWatchdog = null;
      }
      this._scheduleReconnect();
    });

    ws.on("error", (err) => {
      if (this.ws !== ws) return;
      log("BINANCE", `Market WS error: ${err.message}`);
      store.setMarketStatus({ ws: "error" });
      this._scheduleReconnect();
    });
  }

  _scheduleReconnect() {
    if (this.reconnectTimer || this.symbolStreams.size === 0) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._connectMarketWs().catch((err) => {
        log("BINANCE", `Market WS reconnect failed: ${err.message}`);
        this._scheduleReconnect();
      });
    }, 3000);
  }

  async _request(method, path, params = {}, signed = false) {
    const url = new URL(`${config.baseRestUrl}${path}`);
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) query.append(key, String(value));
    }

    if (signed) {
      query.append("timestamp", String(Date.now()));
      query.append("recvWindow", String(config.recvWindow));
      const signature = crypto
        .createHmac("sha256", config.apiSecret)
        .update(query.toString())
        .digest("hex");
      query.append("signature", signature);
    }

    url.search = query.toString();

    const headers = { "Content-Type": "application/json" };
    if (config.apiKey) headers["X-MBX-APIKEY"] = config.apiKey;

    const response = await fetch(url, { method, headers });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Binance ${response.status}: ${text}`);
    }
    return response.json();
  }

  async getMarkPrice(symbol) {
    if (this.mode === "test" && this.markPrices.has(symbol)) {
      return this.markPrices.get(symbol);
    }
    const data = await this._request("GET", "/fapi/v1/premiumIndex", { symbol });
    return Number(data.markPrice);
  }

  async getTickerPrice(symbol) {
    const data = await this._request("GET", "/fapi/v1/ticker/price", { symbol });
    return Number(data.price);
  }

  async get24hTickers() {
    return this._request("GET", "/fapi/v1/ticker/24hr");
  }

  async getExchangeInfo() {
    return this._request("GET", "/fapi/v1/exchangeInfo");
  }

  async getKlines(symbol, interval, limit) {
    return this._request("GET", "/fapi/v1/klines", { symbol, interval, limit });
  }

  async getDepth(symbol, limit = 100) {
    return this._request("GET", "/fapi/v1/depth", { symbol, limit });
  }

  async setLeverage(symbol, leverage) {
    if (this.mode === "test") return { symbol, leverage, status: "TEST" };
    return this._request(
      "POST",
      "/fapi/v1/leverage",
      {
        symbol,
        leverage
      },
      true
    );
  }

  async placeStopLimitOrder({ symbol, side, quantity, stopPrice, price, reduceOnly = false }) {
    if (this.mode === "test") {
      const orderId = `T-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      this.testOrders.set(orderId, {
        orderId,
        symbol,
        side,
        quantity,
        stopPrice,
        price,
        status: "NEW",
        type: "STOP",
        reduceOnly
      });
      return { orderId };
    }

    return this._request(
      "POST",
      "/fapi/v1/order",
      {
        symbol,
        side,
        type: "STOP",
        quantity,
        stopPrice,
        price,
        timeInForce: "GTC",
        workingType: "MARK_PRICE",
        reduceOnly
      },
      true
    );
  }

  async placeLimitOrder({ symbol, side, quantity, price, reduceOnly = false }) {
    if (this.mode === "test") {
      const orderId = `L-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      this.testOrders.set(orderId, {
        orderId,
        symbol,
        side,
        quantity,
        price,
        status: "NEW",
        type: "LIMIT",
        reduceOnly
      });
      return { orderId };
    }

    return this._request(
      "POST",
      "/fapi/v1/order",
      {
        symbol,
        side,
        type: "LIMIT",
        quantity,
        price,
        timeInForce: "GTC",
        reduceOnly
      },
      true
    );
  }

  async cancelOrder({ symbol, orderId }) {
    if (this.mode === "test") {
      this.testOrders.delete(orderId);
      return { orderId, status: "CANCELED" };
    }
    return this._request("DELETE", "/fapi/v1/order", { symbol, orderId }, true);
  }

  async cancelAllOpenOrders(symbol) {
    if (this.mode === "test") {
      for (const [orderId, order] of this.testOrders.entries()) {
        if (order.symbol === symbol) this.testOrders.delete(orderId);
      }
      return { symbol, status: "CANCELED" };
    }
    return this._request("DELETE", "/fapi/v1/allOpenOrders", { symbol }, true);
  }

  async getPosition(symbol) {
    if (this.mode === "test") {
      return this.testPositions.get(symbol) || { qty: 0, entryPrice: 0 };
    }
    const data = await this._request("GET", "/fapi/v2/positionRisk", {}, true);
    const pos = data.find((p) => p.symbol === symbol);
    return {
      qty: pos ? Number(pos.positionAmt) : 0,
      entryPrice: pos ? Number(pos.entryPrice) : 0
    };
  }

  async getBalance() {
    if (this.mode === "test") return this.testBalance;
    const data = await this._request("GET", "/fapi/v2/balance", {}, true);
    const usdt = data.find((b) => b.asset === "USDT");
    return usdt ? Number(usdt.balance) : 0;
  }

  async getOrderTrades(symbol, orderId) {
    if (this.mode === "test") return [];
    return this._request("GET", "/fapi/v1/userTrades", { symbol, orderId }, true);
  }

  async closePositionMarket(symbol) {
    const position = await this.getPosition(symbol);
    if (!position || position.qty === 0) return { status: "NONE" };
    const side = position.qty > 0 ? "SELL" : "BUY";
    return this.placeMarketOrder({
      symbol,
      side,
      quantity: Math.abs(position.qty)
    });
  }

  async placeMarketOrder({ symbol, side, quantity }) {
    if (this.mode === "test") {
      const price = this._getFillPrice(symbol, side);
      const qty = side === "BUY" ? quantity : -quantity;
      const pnl = this._realizePnl(symbol, qty, price);
      return { status: "FILLED", price, pnl };
    }

    return this._request(
      "POST",
      "/fapi/v1/order",
      {
        symbol,
        side,
        type: "MARKET",
        quantity
      },
      true
    );
  }

  _getFillPrice(symbol, side) {
    const book = this.bestBook.get(symbol);
    const mark = this.markPrices.get(symbol);
    const base = book ? (side === "BUY" ? book.ask : book.bid) : mark;
    const slip = base * config.slippageRate;
    return side === "BUY" ? base + slip : base - slip;
  }

  _realizePnl(symbol, deltaQty, price) {
    const pos = this.testPositions.get(symbol) || { qty: 0, entryPrice: 0 };
    const newQty = pos.qty + deltaQty;
    let pnl = 0;

    if (pos.qty === 0 || Math.sign(pos.qty) === Math.sign(newQty)) {
      const totalNotional = pos.entryPrice * Math.abs(pos.qty) + price * Math.abs(deltaQty);
      const totalQty = Math.abs(pos.qty) + Math.abs(deltaQty);
      const avgPrice = totalQty === 0 ? 0 : totalNotional / totalQty;
      this.testPositions.set(symbol, { qty: newQty, entryPrice: avgPrice });
    } else {
      const closedQty = Math.min(Math.abs(pos.qty), Math.abs(deltaQty));
      const direction = pos.qty > 0 ? 1 : -1;
      pnl = (price - pos.entryPrice) * closedQty * direction;
      const remainingQty = newQty;
      this.testPositions.set(symbol, {
        qty: remainingQty,
        entryPrice: remainingQty === 0 ? 0 : price
      });
    }

    const fee = Math.abs(deltaQty * price) * config.feeRate;
    this.testBalance += pnl - fee;
    return pnl - fee;
  }

  _simulateFills(symbol, markPrice) {
    const prevPrice = this.lastSimPrice.get(symbol);
    for (const order of this.testOrders.values()) {
      if (order.symbol !== symbol || order.status !== "NEW") continue;
      let trigger = false;
      if (order.type === "LIMIT") {
        trigger = order.side === "BUY"
          ? markPrice <= order.price
          : markPrice >= order.price;
      } else {
        trigger = order.side === "BUY"
          ? markPrice >= order.stopPrice
          : markPrice <= order.stopPrice;
      }
      if (!trigger) continue;

      const filledImmediately = order.type !== "LIMIT" && (
        !Number.isFinite(prevPrice) ||
        (order.side === "BUY" ? prevPrice >= order.stopPrice : prevPrice <= order.stopPrice)
      );
      if (filledImmediately) {
        log("BINANCE", `Test fill: ${order.symbol} ${order.side} stop already passed @ ${order.stopPrice}`);
      }

      const fillPrice = Number.isFinite(order.price) ? order.price : order.stopPrice;
      order.status = "FILLED";
      this.testOrders.delete(order.orderId);
      const qty = order.side === "BUY" ? order.quantity : -order.quantity;
      this._realizePnl(symbol, qty, fillPrice);

      this.emit("orderFilled", {
        symbol,
        orderId: order.orderId,
        side: order.side,
        price: fillPrice,
        quantity: order.quantity
      });
    }

    this.lastSimPrice.set(symbol, markPrice);
  }
}

module.exports = BinanceApi;
