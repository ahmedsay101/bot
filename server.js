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
    tickerCache.set(symbol, { symbol, percent, quoteVolume });
  }
  topGainers = Array.from(tickerCache.values())
    .filter((t) => t.quoteVolume >= 10_000_000)
    .sort((a, b) => b.percent - a.percent)
    .slice(0, 5);
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

const port = Number(process.env.API_PORT) || 4000;

server.listen(port, () => {
  log("API", `Server listening on port ${port}`);
});

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
