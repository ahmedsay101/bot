import { useEffect, useState } from "react";
import axios from "axios";
import { io } from "socket.io-client";

const API_URL = import.meta.env.VITE_API_URL || "";

function fmt(value, digits = 2) {
  if (value == null || Number.isNaN(Number(value))) return "-";
  return Number(value).toFixed(digits);
}

function fmtPrice(value) {
  const n = Number(value);
  if (value == null || !Number.isFinite(n)) return "-";
  if (Math.abs(n) >= 1) return n.toFixed(4);
  if (Math.abs(n) >= 0.01) return n.toFixed(6);
  return n.toFixed(8);
}

function fmtVol(v) {
  if (!Number.isFinite(v) || v === 0) return "-";
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

function App() {
  const [status, setStatus] = useState({ mode: "TEST", balance: 0, equity: 0 });
  const [traders, setTraders] = useState([]);
  const [topGainers, setTopGainers] = useState([]);
  const [connected, setConnected] = useState(false);

  // All data via WebSocket — no HTTP polling
  useEffect(() => {
    const socket = io(API_URL, { path: "/api/socket.io", transports: ["websocket"] });

    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));

    socket.on("dashboardUpdate", (data) => {
      if (data.status) setStatus(data.status);
      if (data.traders) setTraders(data.traders);
      if (data.topGainers) setTopGainers(data.topGainers);
    });

    socket.on("priceUpdate", ({ symbol, price }) => {
      setTraders(prev => prev.map(t =>
        t.symbol === symbol ? { ...t, lastPrice: Number(price) } : t
      ));
    });

    return () => socket.disconnect();
  }, []);

  const destroyTrader = async (symbol) => {
    if (!window.confirm(`Destroy ${symbol} trader?`)) return;
    try {
      await axios.delete(`${API_URL}/api/traders/${symbol}`);
    } catch (error) {
      console.error("Failed to destroy trader:", error);
    }
  };

  return (
    <div style={{
      fontFamily: "monospace",
      padding: "20px",
      backgroundColor: "#0a0a0a",
      color: "#ffffff",
      minHeight: "100vh"
    }}>

      {/* Header */}
      <div style={{ marginBottom: "30px", borderBottom: "1px solid #333", paddingBottom: "20px" }}>
        <h1 style={{ margin: "0 0 10px 0", fontSize: "24px" }}>Perpetual Trader Dashboard</h1>
        <div style={{ display: "flex", gap: "30px", fontSize: "14px" }}>
          <span>Mode: <strong style={{ color: status.mode === "LIVE" ? "#00ff00" : "#ff9900" }}>{status.mode}</strong></span>
          <span>Balance: <strong>${fmt(status.balance)}</strong></span>
          <span>Equity: <strong>${fmt(status.equity)}</strong></span>
          <span>Traders: <strong>{status.activeTraders || traders.length}/{status.maxTraders || 5}</strong> slots</span>
          <span>Connection: <strong style={{ color: connected ? "#00ff00" : "#ff0000" }}>{connected ? "CONNECTED" : "DISCONNECTED"}</strong></span>
        </div>
      </div>

      {/* Top Gainers */}
      <TopGainersTable gainers={topGainers} activeSymbols={new Set(traders.map(t => t.symbol))} maxTraders={status.maxTraders || 5} />

      {/* Traders */}
      {traders.length === 0 ? (
        <div style={{ textAlign: "center", color: "#888", marginTop: "50px" }}>
          <h3>No Active Traders</h3>
          <p>Waiting for traders to be launched...</p>
        </div>
      ) : (
        traders.map(trader => {
          const rank = topGainers.findIndex(g => g.symbol === trader.symbol);
          return (
            <TraderCard
              key={trader.id}
              trader={trader}
              equity={status.equity}
              onDestroy={() => destroyTrader(trader.symbol)}
              rank={rank >= 0 ? rank + 1 : null}
            />
          );
        })
      )}
    </div>
  );
}

/* ── Top Gainers Table ───────────────────────────────────────── */

function TopGainersTable({ gainers, activeSymbols, maxTraders }) {
  if (!gainers || gainers.length === 0) return null;

  return (
    <div style={{
      marginBottom: "30px",
      border: "1px solid #333",
      borderRadius: "8px",
      padding: "15px",
      backgroundColor: "#111"
    }}>
      <h3 style={{ margin: "0 0 12px 0", color: "#00aaff", fontSize: "16px" }}>
        Top Gainers (24h) — Top {maxTraders} get traded
      </h3>
      <div style={{ maxHeight: "320px", overflowY: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
          <thead>
            <tr>
              <th style={tableHeaderStyle}>#</th>
              <th style={tableHeaderStyle}>Symbol</th>
              <th style={{ ...tableHeaderStyle, textAlign: "right" }}>Price</th>
              <th style={{ ...tableHeaderStyle, textAlign: "right" }}>24h Change</th>
              <th style={{ ...tableHeaderStyle, textAlign: "right" }}>Volume</th>
              <th style={{ ...tableHeaderStyle, textAlign: "center" }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {gainers.map((g, i) => {
              const isTopN = i < maxTraders;
              const isActive = activeSymbols.has(g.symbol);
              const rowBg = isTopN
                ? (isActive ? "rgba(0, 255, 0, 0.06)" : "rgba(255, 255, 0, 0.06)")
                : "transparent";
              return (
                <tr key={g.symbol} style={{
                  borderBottom: isTopN && i === maxTraders - 1 ? "2px solid #555" : "1px solid #222",
                  backgroundColor: rowBg
                }}>
                  <td style={tableCellStyle}>{i + 1}</td>
                  <td style={{ ...tableCellStyle, fontWeight: "bold" }}>{g.symbol.replace("USDT", "")}</td>
                  <td style={{ ...tableCellStyle, textAlign: "right" }}>{fmtPrice(g.price)}</td>
                  <td style={{
                    ...tableCellStyle,
                    textAlign: "right",
                    fontWeight: "bold",
                    color: g.percent >= 0 ? "#00ff00" : "#ff4444"
                  }}>
                    {g.percent >= 0 ? "+" : ""}{fmt(g.percent, 2)}%
                  </td>
                  <td style={{ ...tableCellStyle, textAlign: "right", color: "#aaa" }}>{fmtVol(g.volume)}</td>
                  <td style={{ ...tableCellStyle, textAlign: "center" }}>
                    {isActive ? (
                      <span style={{ color: "#00ff00", fontWeight: "bold" }}>● ACTIVE</span>
                    ) : isTopN ? (
                      <span style={{ color: "#ffff00" }}>○ PENDING</span>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TraderCard({ trader, onDestroy, rank }) {
  const pos = trader.position;
  const history = trader.tradeHistory || [];

  return (
    <div style={{ 
      border: "1px solid #333", 
      borderRadius: "8px", 
      padding: "20px", 
      marginBottom: "30px",
      backgroundColor: "#111"
    }}>
      
      {/* Trader Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          {rank != null && (
            <div style={{
              width: "36px", height: "36px",
              borderRadius: "50%",
              backgroundColor: rank <= 3 ? "#003300" : "#222",
              border: `2px solid ${rank <= 3 ? "#00ff00" : "#555"}`,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: "16px", fontWeight: "bold",
              color: rank <= 3 ? "#00ff00" : "#aaa"
            }}>
              #{rank}
            </div>
          )}
          <div>
            <h2 style={{ margin: "0", color: "#00aaff" }}>{trader.symbol}</h2>
            <div style={{ fontSize: "12px", color: "#888", marginTop: "5px" }}>
              Created: {new Date(trader.createdAt).toLocaleString()}
            </div>
          </div>
          {trader.change24h != null && (
            <div style={{
              padding: "4px 10px",
              borderRadius: "4px",
              fontSize: "14px",
              fontWeight: "bold",
              backgroundColor: trader.change24h >= 0 ? "#003300" : "#330000",
              color: trader.change24h >= 0 ? "#00ff00" : "#ff4444",
              border: `1px solid ${trader.change24h >= 0 ? "#00ff00" : "#ff4444"}`
            }}>
              {trader.change24h >= 0 ? "+" : ""}{fmt(trader.change24h, 2)}% 24h
            </div>
          )}
        </div>
        <button 
          onClick={onDestroy}
          style={{ 
            background: "#ff4444", 
            color: "white", 
            border: "none", 
            padding: "8px 16px", 
            borderRadius: "4px", 
            cursor: "pointer" 
          }}
        >
          Destroy
        </button>
      </div>

      {/* Stats Grid */}
      <div style={{ 
        display: "grid", 
        gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", 
        gap: "15px", 
        marginBottom: "20px" 
      }}>
        <StatBox label="Total Trades" value={trader.totalTrades || 0} />
        <StatBox label="Wins" value={trader.wins || 0} color="#00ff00" />
        <StatBox label="Losses" value={trader.losses || 0} color="#ff4444" />
        <StatBox 
          label="Win Rate" 
          value={`${fmt(trader.winRate || 0, 1)}%`} 
          color={(trader.winRate || 0) >= 50 ? "#00ff00" : "#ff4444"} 
        />
        <StatBox label="Leverage" value={`${trader.leverage}x`} />
        <StatBox label="Realized PnL" value={`$${fmt(trader.realizedPnl, 4)}`} color={trader.realizedPnl >= 0 ? "#00ff00" : "#ff4444"} />
        <StatBox label="Fees Paid" value={`$${fmt(trader.feesPaid, 4)}`} color="#ff9900" />
      </div>

      {/* Current Position */}
      {pos && (
        <div style={{ marginBottom: "20px", padding: "15px", backgroundColor: "#1a1a1a", borderRadius: "4px" }}>
          <h4 style={{ margin: "0 0 10px 0", color: "#00ff99" }}>Current Position</h4>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: "15px" }}>
            <div>
              <div style={{ fontSize: "12px", color: "#888" }}>Direction</div>
              <div style={{ 
                fontSize: "18px", 
                fontWeight: "bold", 
                color: pos.direction === "LONG" ? "#00ff00" : "#ff4444" 
              }}>
                {pos.direction}
              </div>
            </div>
            <div>
              <div style={{ fontSize: "12px", color: "#888" }}>Trade #</div>
              <div style={{ fontSize: "16px", fontWeight: "bold" }}>{pos.tradeNumber}</div>
            </div>
            <div>
              <div style={{ fontSize: "12px", color: "#888" }}>Entry</div>
              <div style={{ fontSize: "16px" }}>{fmtPrice(pos.entryPrice)}</div>
            </div>
            <div>
              <div style={{ fontSize: "12px", color: "#888" }}>Current Price</div>
              <div style={{ fontSize: "16px" }}>{fmtPrice(trader.lastPrice)}</div>
            </div>
            <div>
              <div style={{ fontSize: "12px", color: "#888" }}>Take Profit</div>
              <div style={{ fontSize: "16px", color: "#00ff00" }}>{fmtPrice(pos.tpPrice)}</div>
            </div>
            <div>
              <div style={{ fontSize: "12px", color: "#888" }}>Stop Loss</div>
              <div style={{ fontSize: "16px", color: "#ff4444" }}>{fmtPrice(pos.slPrice)}</div>
            </div>
            <div>
              <div style={{ fontSize: "12px", color: "#888" }}>Unrealized PnL</div>
              <div style={{ 
                fontSize: "16px", 
                fontWeight: "bold", 
                color: trader.unrealizedPnl >= 0 ? "#00ff00" : "#ff4444" 
              }}>
                ${fmt(trader.unrealizedPnl, 4)}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Trade History */}
      <div style={{ marginBottom: "20px" }}>
        <h4 style={{ margin: "0 0 15px 0", color: "#fff" }}>Trade History ({history.length} trades)</h4>
        
        {history.length === 0 ? (
          <div style={{ color: "#888", textAlign: "center", padding: "20px" }}>No trades yet</div>
        ) : (
          <div style={{ maxHeight: "400px", overflowY: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "14px" }}>
              <thead>
                <tr>
                  <th style={tableHeaderStyle}>#</th>
                  <th style={tableHeaderStyle}>Direction</th>
                  <th style={tableHeaderStyle}>Reason</th>
                  <th style={tableHeaderStyle}>Entry</th>
                  <th style={tableHeaderStyle}>Exit</th>
                  <th style={tableHeaderStyle}>Amount</th>
                  <th style={tableHeaderStyle}>Gross PnL</th>
                  <th style={tableHeaderStyle}>Fees</th>
                  <th style={tableHeaderStyle}>Net PnL</th>
                  <th style={tableHeaderStyle}>Time</th>
                </tr>
              </thead>
              <tbody>
                {history.map((trade, idx) => (
                  <tr key={`${trade.tradeNumber}-${idx}`} style={{ borderBottom: "1px solid #333" }}>
                    <td style={tableCellStyle}>{trade.tradeNumber}</td>
                    <td style={{
                      ...tableCellStyle, 
                      color: trade.direction === "LONG" ? "#00ff00" : "#ff4444",
                      fontWeight: "bold"
                    }}>
                      {trade.direction}
                    </td>
                    <td style={{
                      ...tableCellStyle,
                      color: trade.reason === "take-profit" ? "#00ff00" : 
                            trade.reason === "stop-loss" ? "#ff4444" : "#888"
                    }}>
                      {trade.reason}
                    </td>
                    <td style={tableCellStyle}>{fmtPrice(trade.entry)}</td>
                    <td style={tableCellStyle}>{fmtPrice(trade.exit)}</td>
                    <td style={tableCellStyle}>${fmt(trade.notional)}</td>
                    <td style={{
                      ...tableCellStyle,
                      color: trade.grossPnl >= 0 ? "#00ff00" : "#ff4444"
                    }}>
                      ${fmt(trade.grossPnl, 4)}
                    </td>
                    <td style={{ ...tableCellStyle, color: "#ff9900" }}>${fmt(trade.fees, 4)}</td>
                    <td style={{
                      ...tableCellStyle,
                      fontWeight: "bold",
                      color: trade.netPnl >= 0 ? "#00ff00" : "#ff4444"
                    }}>
                      ${fmt(trade.netPnl, 4)}
                    </td>
                    <td style={tableCellStyle}>
                      {new Date(trade.closedAt).toLocaleTimeString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Direction Change Pattern */}
      {history.length > 1 && (
        <div style={{ padding: "15px", backgroundColor: "#1a1a1a", borderRadius: "4px" }}>
          <h4 style={{ margin: "0 0 10px 0", color: "#ff9900" }}>Direction Changes (Last 10 trades)</h4>
          <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
            {history.slice(-10).map((trade, idx) => (
              <div key={idx} style={{
                padding: "8px 12px",
                borderRadius: "4px",
                backgroundColor: trade.direction === "LONG" ? "#003300" : "#330000",
                border: `2px solid ${trade.direction === "LONG" ? "#00ff00" : "#ff4444"}`,
                textAlign: "center",
                minWidth: "80px"
              }}>
                <div style={{ fontSize: "12px", color: "#888" }}>#{trade.tradeNumber}</div>
                <div style={{ 
                  fontWeight: "bold", 
                  color: trade.direction === "LONG" ? "#00ff00" : "#ff4444" 
                }}>
                  {trade.direction}
                </div>
                <div style={{ 
                  fontSize: "10px", 
                  color: trade.reason === "take-profit" ? "#00ff00" : "#ff4444" 
                }}>
                  {trade.reason === "take-profit" ? "TP" : "SL"}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatBox({ label, value, color = "#ffffff" }) {
  return (
    <div style={{ 
      padding: "10px", 
      backgroundColor: "#222", 
      borderRadius: "4px", 
      textAlign: "center" 
    }}>
      <div style={{ fontSize: "12px", color: "#888", marginBottom: "5px" }}>{label}</div>
      <div style={{ fontSize: "16px", fontWeight: "bold", color }}>{value}</div>
    </div>
  );
}

const tableHeaderStyle = {
  padding: "8px",
  textAlign: "left",
  borderBottom: "2px solid #444",
  backgroundColor: "#222",
  color: "#fff"
};

const tableCellStyle = {
  padding: "8px",
  textAlign: "left",
  color: "#fff"
};

export default App;
