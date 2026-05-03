require("dotenv").config();

const http = require("http");
const https = require("https");
const WebSocket = require("ws");
const express = require("express");
const cors = require("cors");
const { Server } = require("socket.io");
const router = require("./server/router");
const store = require("./src/state/store");
const { log } = require("./src/utils/logger");
const { startBot } = require("./bot");
const config = require("./src/utils/config");

const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());
app.use("/api", router);

// Serve the built dashboard in production
const dashboardDist = path.join(__dirname, "dashboard", "dist");
app.use(express.static(dashboardDist));
app.get(/^\/(?!api|socket\.io).*/, (_req, res) => {
  res.sendFile(path.join(dashboardDist, "index.html"));
});

const server = http.createServer(app);
const io = new Server(server, {
  path: "/api/socket.io",
  cors: { origin: "*" }
});

let topGainers = [];
const tickerCache = new Map();   // symbol → { symbol, percent }
let topGainersWs = null;
let priceFeedAttached = false;

// Set of tradable USDT perpetuals — populated from /fapi/v1/exchangeInfo.
// Keeps the dashboard list aligned with Binance's Futures Top Gainers
// (perpetual contracts in TRADING status only — no delivery, no halted, etc.)
let tradablePerpetuals = null;
let tradablePerpetualsAt = 0;
const TRADABLE_TTL_MS = 10 * 60 * 1000;

async function refreshTradablePerpetuals(force = false) {
  const now = Date.now();
  if (!force && tradablePerpetuals && (now - tradablePerpetualsAt) < TRADABLE_TTL_MS) {
    return tradablePerpetuals;
  }
  try {
    const info = await fetchJson(`${config.baseRestUrl}/fapi/v1/exchangeInfo`);
    const symbols = Array.isArray(info?.symbols) ? info.symbols : [];
    const next = new Set(
      symbols
        .filter((s) => s.contractType === "PERPETUAL")
        .filter((s) => s.quoteAsset === "USDT")
        .filter((s) => s.status === "TRADING")
        .map((s) => s.symbol)
    );
    tradablePerpetuals = next;
    tradablePerpetualsAt = now;
    log("API", `Tradable perpetuals refreshed (${next.size} symbols)`);
  } catch (err) {
    log("API", `exchangeInfo refresh failed: ${err.message}`);
  }
  return tradablePerpetuals;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(err);
          }
        });
      })
      .on("error", reject);
  });
}

function updateTopGainersFromTickers(tickers) {
  const list = Array.isArray(tickers) ? tickers : [];
  for (const t of list) {
    const symbol = t?.symbol || t?.s;
    const percent = Number(t?.priceChangePercent ?? t?.P);
    const quoteVolume = Number(t?.quoteVolume ?? t?.q ?? 0);
    if (typeof symbol !== "string" || !symbol.endsWith("USDT")) continue;
    if (!Number.isFinite(percent)) continue;
    // Drop symbols Binance doesn't show on Futures (delivery contracts,
    // halted/settling perpetuals, BVOL/leveraged tokens, etc.).
    if (tradablePerpetuals && !tradablePerpetuals.has(symbol)) continue;
    tickerCache.set(symbol, { symbol, percent, quoteVolume });
  }
  // Always show a healthy list so the user can see the broader market —
  // the dashboard highlights which rows the scanner would actually pick.
  const displayCount = Math.max(15, Number(config.maxTraders) || 0);
  topGainers = Array.from(tickerCache.values())
    .filter((t) => !tradablePerpetuals || tradablePerpetuals.has(t.symbol))
    .sort((a, b) => b.percent - a.percent)
    .slice(0, displayCount);
}

// Seed the cache once at boot via REST so the dashboard has data immediately,
// before the !ticker@arr stream delivers its first batch. Also called on a
// short interval as a fallback in case the WS stream stalls.
async function seedTopGainersFromRest() {
  try {
    // Refresh the perpetuals whitelist on demand (cached for TRADABLE_TTL_MS).
    await refreshTradablePerpetuals();
    const data = await fetchJson(`${config.baseRestUrl}/fapi/v1/ticker/24hr`);
    updateTopGainersFromTickers(data);
  } catch (err) {
    log("API", `Top gainers REST refresh failed: ${err.message}`);
  }
}

function startTopGainersWs() {
  if (topGainersWs) {
    try { topGainersWs.terminate(); } catch (_) {}
    topGainersWs = null;
  }
  const url = `${config.baseWsUrl}/ws/!ticker@arr`;
  topGainersWs = new WebSocket(url);

  topGainersWs.on("open", () => {
    log("API", "Top gainers WS connected");
  });

  topGainersWs.on("message", (raw) => {
    try {
      topGainersWs._lastMessage = Date.now();
      const data = JSON.parse(raw.toString());
      if (Array.isArray(data)) {
        updateTopGainersFromTickers(data);
      } else if (Array.isArray(data?.data)) {
        updateTopGainersFromTickers(data.data);
      }
    } catch (err) {
      log("API", `Top gainers WS parse error: ${err.message}`);
    }
  });

  topGainersWs.on("close", () => {
    log("API", "Top gainers WS closed — reconnecting in 5s");
    topGainersWs = null;
    setTimeout(startTopGainersWs, 5000);
  });

  topGainersWs.on("error", (err) => {
    log("API", `Top gainers WS error: ${err.message} — reconnecting`);
    try { topGainersWs.terminate(); } catch (_) {}
    topGainersWs = null;
    setTimeout(startTopGainersWs, 5000);
  });
}

// Watchdog: restart top gainers WS if no message received in 60s
setInterval(() => {
  if (topGainersWs && topGainersWs._lastMessage && Date.now() - topGainersWs._lastMessage > 60000) {
    log("API", "Top gainers WS stale (no data 60s) — reconnecting");
    startTopGainersWs();
  }
}, 30000);

io.on("connection", (socket) => {
  socket.emit("dashboardUpdate", {
    ...store.getDashboardUpdate(),
    topGainers
  });
});

setInterval(() => {
  io.emit("dashboardUpdate", {
    ...store.getDashboardUpdate(),
    topGainers
  });
}, 2000);

startTopGainersWs();
seedTopGainersFromRest();
// Refresh the tradable-perpetuals whitelist hourly to catch new listings.
setInterval(() => { refreshTradablePerpetuals(true); }, 60 * 60 * 1000);
// REST fallback / source of truth: refresh the full 24h ticker every 10s so
// the dashboard always matches Binance even if the WS stream stalls.
setInterval(() => { seedTopGainersFromRest(); }, 10 * 1000);

const port = Number(process.env.API_PORT) || 8080;
const host = process.env.HOST || "0.0.0.0";

server.listen(port, host, () => {
  log("API", `Server listening on http://${host}:${port}`);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("API", `Received ${signal} — shutting down gracefully`);
  try {
    const controller = app.get("controller");
    if (controller && typeof controller.stop === "function") {
      await controller.stop();
    }
  } catch (err) {
    log("API", `Error during controller stop: ${err.message}`);
  }
  try { if (topGainersWs) topGainersWs.terminate(); } catch (_) {}
  io.close();
  server.close(() => process.exit(0));
  // Hard timeout in case sockets hang
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

startBot().catch((err) => {
  log("API", `Bot failed to start: ${err.message}`);
  process.exit(1);
}).then((bot) => {
  app.set("botApi", bot.api);
  app.set("controller", bot.controller);
  if (!priceFeedAttached) {
    priceFeedAttached = true;
    bot.api.on("bookTicker", ({ symbol, bid, ask }) => {
      const bidNum = Number(bid);
      const askNum = Number(ask);
      let price = null;
      if (Number.isFinite(bidNum) && Number.isFinite(askNum)) {
        price = (bidNum + askNum) / 2;
      } else if (Number.isFinite(bidNum)) {
        price = bidNum;
      } else if (Number.isFinite(askNum)) {
        price = askNum;
      }

      if (!Number.isFinite(price)) return;
      io.emit("priceUpdate", {
        symbol,
        price,
        bid: bidNum,
        ask: askNum,
        ts: Date.now()
      });
    });
  }
  log("API", "Bot API attached to server");
});
