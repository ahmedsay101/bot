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
    this.userWs = null;
    this.listenKey = null;
    this.userReconnectTimer = null;
    this.userKeepAlive = null;
    this.algoIdToClientId = new Map();

    this.testOrders = new Map();
    this.testPositions = new Map();
    this.testBalance = config.startingBalanceUSDT;
    this.bestBook = new Map();
    this.markPrices = new Map();
    this.lastSimPrice = new Map();
    this.reconnectTimer = null;
    this.wsLastMessageAt = 0;
    this.wsWatchdog = null;
    this.exchangeInfoCache = {
      updatedAt: 0,
      symbols: new Map()
    };

    store.setMarketStatus({ ws: "idle" });
  }

  async startMarketStreams(symbols) {
    this.symbolStreams = new Set(symbols);
    await this._connectMarketWs();
  }

  async startUserDataStream() {
    if (this.mode !== "live") return;
    await this._connectUserDataWs();
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
    if (this.symbolStreams.size === 0) {
      store.setMarketStatus({ ws: "idle" });
      return;
    }
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

  async _connectUserDataWs() {
    if (!config.apiKey) {
      log("BINANCE", "User WS skipped: missing API key");
      return;
    }

    if (this.userKeepAlive) {
      clearInterval(this.userKeepAlive);
      this.userKeepAlive = null;
    }

    const data = await this._request("POST", "/fapi/v1/listenKey", {}, false);
    this.listenKey = data.listenKey;

    const url = `${config.baseWsUrl}/ws/${this.listenKey}`;
    const ws = new WebSocket(url);
    this.userWs = ws;

    ws.on("open", () => {
      if (this.userWs !== ws) return;
      log("BINANCE", "User WS connected");
      if (this.userReconnectTimer) {
        clearTimeout(this.userReconnectTimer);
        this.userReconnectTimer = null;
      }
    });

    ws.on("message", (raw) => {
      if (this.userWs !== ws) return;
      try {
        const data = JSON.parse(raw.toString());
        if (data.e === "listenKeyExpired") {
          log("BINANCE", "User WS listenKey expired, reconnecting");
          ws.terminate();
          return;
        }

        if (data.e === "ORDER_TRADE_UPDATE" || data.e === "CONDITIONAL_ORDER_TRADE_UPDATE") {
          this._handleOrderUpdate(data.o || data.order || data);
        }
      } catch (err) {
        log("BINANCE", `User WS parse error: ${err.message}`);
      }
    });

    ws.on("close", () => {
      if (this.userWs !== ws) return;
      log("BINANCE", "User WS closed");
      this._scheduleUserReconnect();
    });

    ws.on("error", (err) => {
      if (this.userWs !== ws) return;
      log("BINANCE", `User WS error: ${err.message}`);
      this._scheduleUserReconnect();
    });

    this.userKeepAlive = setInterval(() => {
      this._request("PUT", "/fapi/v1/listenKey", { listenKey: this.listenKey }, false)
        .catch((err) => log("BINANCE", `User WS keepalive failed: ${err.message}`));
    }, 25 * 60 * 1000);
  }

  _scheduleUserReconnect() {
    if (this.userReconnectTimer) return;
    this.userReconnectTimer = setTimeout(() => {
      this.userReconnectTimer = null;
      this._connectUserDataWs().catch((err) => {
        log("BINANCE", `User WS reconnect failed: ${err.message}`);
        this._scheduleUserReconnect();
      });
    }, 3000);
  }

  _handleOrderUpdate(order) {
    const symbol = order.s || order.symbol;
    const side = order.S || order.side;
    const status = order.X || order.status;
    const executionType = order.x || order.executionType;
    const orderType = order.o || order.type;
    const algoId = order.algoId || order.A;
    const clientOrderId = order.c || order.C || order.clientOrderId || order.clientAlgoId;
    const numericOrderId = order.i || order.orderId;

    // For algo orders (BOT- prefix in clientOrderId), use the client ID we set
    // For standard orders, use the numeric orderId that matches what REST returned
    let orderId;
    if (clientOrderId && String(clientOrderId).startsWith("BOT-")) {
      orderId = clientOrderId;
    } else if (algoId && this.algoIdToClientId.get(String(algoId))) {
      orderId = this.algoIdToClientId.get(String(algoId));
    } else {
      orderId = numericOrderId || clientOrderId || algoId;
    }

    log(
      "BINANCE",
      `Order update ${symbol} ${side} type=${orderType} status=${status} exec=${executionType} id=${orderId} numId=${numericOrderId || ""} clientId=${clientOrderId || ""}`
    );

    if (status === "FILLED") {
      const price = Number(order.ap || order.L || order.avgPrice || order.lastFilledPrice || order.p || 0);
      const quantity = Number(order.q || order.origQty || order.z || order.executedQty || 0);
      this.emit("orderFilled", {
        symbol,
        orderId,
        numericOrderId: numericOrderId ? Number(numericOrderId) : undefined,
        clientOrderId: clientOrderId || undefined,
        side,
        price,
        quantity
      });
    }

    if (status === "REJECTED" || status === "EXPIRED" || status === "CANCELLED") {
      this.emit("orderCancelled", {
        symbol,
        orderId,
        numericOrderId: numericOrderId ? Number(numericOrderId) : undefined,
        clientOrderId: clientOrderId || undefined,
        side,
        status,
        orderType
      });
    }
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

  async _requestWithQuery(method, path, params = {}, signed = false, options = {}) {
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

    if (options.logUrl) {
      log("BINANCE", `HTTP ${method} ${url.toString()}`);
    }

    const headers = {};
    if (config.apiKey) headers["X-MBX-APIKEY"] = config.apiKey;

    const response = await fetch(url, { method, headers, body: null });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Binance ${response.status}: ${text}`);
    }
    return response.json();
  }

  _isAlgoOrderType(type) {
    return ["STOP_MARKET", "STOP", "TAKE_PROFIT", "TAKE_PROFIT_MARKET"].includes(type);
  }

  async _sendOrder(type, params, options = {}) {
    if (!params.positionSide) {
      throw new Error(`positionSide required for ${type} orders in hedge mode`);
    }
    const isAlgo = this._isAlgoOrderType(type);
    const expectedPath = isAlgo ? "/fapi/v1/algoOrder" : "/fapi/v1/order";
    const path = options.path || expectedPath;
    if (path !== expectedPath) {
      throw new Error(`Order endpoint mismatch for ${type}: expected ${expectedPath}, got ${path}`);
    }
    const request = isAlgo ? this._requestWithQuery.bind(this) : this._request.bind(this);
    return request("POST", path, params, true, { logUrl: true });
  }

  _stepDecimals(step) {
    const text = String(step);
    if (text.includes("e-")) {
      const parts = text.split("e-");
      const exp = Number(parts[1]);
      return Number.isFinite(exp) ? exp : 0;
    }
    const parts = text.split(".");
    return parts[1] ? parts[1].length : 0;
  }

  _roundToStep(value, step) {
    if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return value;
    const rounded = Math.floor(value / step) * step;
    const decimals = this._stepDecimals(step);
    return Number(rounded.toFixed(decimals));
  }

  async _getSymbolFilters(symbol) {
    const cacheTtlMs = 10 * 60 * 1000;
    const now = Date.now();
    const cached = this.exchangeInfoCache.symbols.get(symbol);
    if (cached && now - this.exchangeInfoCache.updatedAt < cacheTtlMs) return cached;

    const info = await this.getExchangeInfo();
    const symbols = Array.isArray(info.symbols) ? info.symbols : [];
    const nextMap = new Map();
    for (const s of symbols) {
      if (!s || !s.symbol || !Array.isArray(s.filters)) continue;
      const priceFilter = s.filters.find((f) => f.filterType === "PRICE_FILTER");
      const lotFilter = s.filters.find((f) => f.filterType === "LOT_SIZE");
      nextMap.set(s.symbol, {
        tickSize: priceFilter ? Number(priceFilter.tickSize) : null,
        stepSize: lotFilter ? Number(lotFilter.stepSize) : null
      });
    }

    this.exchangeInfoCache = { updatedAt: now, symbols: nextMap };
    return nextMap.get(symbol) || null;
  }

  async _normalizeOrderParams(symbol, params) {
    const filters = await this._getSymbolFilters(symbol);
    if (!filters) return params;
    const next = { ...params };
    if (Number.isFinite(next.quantity) && Number.isFinite(filters.stepSize)) {
      next.quantity = this._roundToStep(next.quantity, filters.stepSize);
    }
    if (Number.isFinite(next.price) && Number.isFinite(filters.tickSize)) {
      next.price = this._roundToStep(next.price, filters.tickSize);
    }
    if (Number.isFinite(next.stopPrice) && Number.isFinite(filters.tickSize)) {
      next.stopPrice = this._roundToStep(next.stopPrice, filters.tickSize);
    }
    return next;
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
    if (this.mode === "test") {
      log("BINANCE", `Set leverage TEST ${symbol} ${leverage}x`);
      return { symbol, leverage, status: "TEST" };
    }
    log("BINANCE", `Set leverage ${symbol} ${leverage}x`);
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

  async placeStopLimitOrder({
    symbol,
    side,
    quantity,
    stopPrice,
    price,
    reduceOnly = false,
    positionSide
  }) {
    const normalized = await this._normalizeOrderParams(symbol, { quantity, stopPrice, price });
    const nextQuantity = normalized.quantity;
    const nextStopPrice = normalized.stopPrice;
    const nextPrice = normalized.price;
    if (this.mode === "test") {
      const orderId = `T-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      this.testOrders.set(orderId, {
        orderId,
        symbol,
        side,
        quantity: nextQuantity,
        stopPrice: nextStopPrice,
        price: nextPrice,
        status: "NEW",
        type: "STOP_MARKET",
        reduceOnly,
        positionSide
      });
      log(
        "BINANCE",
        `Order TEST stop-market ${symbol} ${side} qty=${nextQuantity} stop=${nextStopPrice} reduceOnly=${reduceOnly} positionSide=${positionSide || ""} id=${orderId}`
      );
      return { orderId };
    }

    log(
      "BINANCE",
      `Order stop-market ${symbol} ${side} qty=${nextQuantity} stop=${nextStopPrice} reduceOnly=${reduceOnly} positionSide=${positionSide || ""}`
    );
    const clientAlgoId = `BOT-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const payload = {
      algoType: "CONDITIONAL",
      symbol,
      side,
      positionSide,
      type: "STOP_MARKET",
      quantity: nextQuantity,
      triggerPrice: nextStopPrice,
      workingType: "MARK_PRICE",
      clientAlgoId
    };
    const result = await this._sendOrder("STOP_MARKET", payload);
    const algoId = result && (result.algoId || result.orderId);
    if (algoId) this.algoIdToClientId.set(String(algoId), clientAlgoId);
    const orderId = result && (result.clientAlgoId || clientAlgoId || result.algoId || result.orderId);
    return { ...result, orderId };
  }

  async placeLimitOrder({ symbol, side, quantity, price, reduceOnly = false, positionSide }) {
    const normalized = await this._normalizeOrderParams(symbol, { quantity, price });
    const nextQuantity = normalized.quantity;
    const nextPrice = normalized.price;
    if (this.mode === "test") {
      const orderId = `L-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      this.testOrders.set(orderId, {
        orderId,
        symbol,
        side,
        quantity: nextQuantity,
        price: nextPrice,
        status: "NEW",
        type: "LIMIT",
        reduceOnly,
        positionSide
      });
      log(
        "BINANCE",
        `Order TEST limit ${symbol} ${side} qty=${nextQuantity} limit=${nextPrice} reduceOnly=${reduceOnly} positionSide=${positionSide || ""} id=${orderId}`
      );
      return { orderId };
    }

    log(
      "BINANCE",
      `Order limit ${symbol} ${side} qty=${nextQuantity} limit=${nextPrice} reduceOnly=${reduceOnly} positionSide=${positionSide || ""}`
    );

    const payload = {
      symbol,
      side,
      type: "LIMIT",
      quantity: nextQuantity,
      price: nextPrice,
      timeInForce: "GTC"
    };
    if (reduceOnly && !positionSide) payload.reduceOnly = true;
    if (positionSide) payload.positionSide = positionSide;

    return this._sendOrder("LIMIT", payload);
  }

  async cancelOrder({ symbol, orderId }) {
    if (this.mode === "test") {
      this.testOrders.delete(orderId);
      log("BINANCE", `Cancel TEST order ${symbol} id=${orderId}`);
      return { orderId, status: "CANCELED" };
    }
    log("BINANCE", `Cancel order ${symbol} id=${orderId}`);
    try {
      if (String(orderId).startsWith("BOT-")) {
        return await this._requestWithQuery(
          "DELETE",
          "/fapi/v1/algoOrder",
          { symbol, clientAlgoId: orderId },
          true,
          { logUrl: true }
        );
      }
      return await this._request("DELETE", "/fapi/v1/order", { symbol, orderId }, true);
    } catch (err) {
      if (err && err.message && err.message.includes("-2011")) {
        log("BINANCE", `Cancel ignored (unknown order) ${symbol} id=${orderId}`);
        return { orderId, status: "UNKNOWN" };
      }
      throw err;
    }
  }

  async cancelAllOpenOrders(symbol) {
    if (this.mode === "test") {
      for (const [orderId, order] of this.testOrders.entries()) {
        if (order.symbol === symbol) this.testOrders.delete(orderId);
      }
      log("BINANCE", `Cancel TEST all orders ${symbol}`);
      return { symbol, status: "CANCELED" };
    }
    log("BINANCE", `Cancel all orders ${symbol}`);
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
    if (this.mode === "test") {
      return this.testBalance;
    }
    const data = await this._request("GET", "/fapi/v2/balance", {}, true);
    const usdt = data.find((b) => b.asset === "USDT");
    return usdt ? Number(usdt.balance) : 0;
  }

  async getOrderTrades(symbol, orderId) {
    if (this.mode === "test") {
      return [];
    }
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

  async placeMarketOrder({ symbol, side, quantity, positionSide }) {
    const normalized = await this._normalizeOrderParams(symbol, { quantity });
    const nextQuantity = normalized.quantity;
    if (this.mode === "test") {
      const price = this._getFillPrice(symbol, side);
      const qty = side === "BUY" ? nextQuantity : -nextQuantity;
      const pnl = this._realizePnl(symbol, qty, price);
      log(
        "BINANCE",
        `Order TEST market ${symbol} ${side} qty=${nextQuantity} fill=${price} pnl=${pnl} positionSide=${positionSide || ""}`
      );
      return { status: "FILLED", price, pnl };
    }

    log("BINANCE", `Order market ${symbol} ${side} qty=${nextQuantity} positionSide=${positionSide || ""}`);

    const payload = {
      symbol,
      side,
      type: "MARKET",
      quantity: nextQuantity
    };
    if (positionSide) payload.positionSide = positionSide;

    return this._sendOrder("MARKET", payload);
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
