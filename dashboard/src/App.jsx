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

function App() {
  const [status, setStatus] = useState({ mode: "TEST", balance: 0, equity: 0 });
  const [traders, setTraders] = useState([]);
  const [connected, setConnected] = useState(false);

  // Load initial data
  useEffect(() => {
    Promise.all([
      axios.get(`${API_URL}/api/status`),
      axios.get(`${API_URL}/api/traders`)
    ]).then(([s, t]) => {
      setStatus(s.data);
      setTraders(t.data);
    }).catch(console.error);
  }, []);

  // WebSocket connection
  useEffect(() => {
    const socket = io(API_URL, { path: "/api/socket.io", transports: ["websocket"] });
    
    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));

    socket.on("dashboardUpdate", (data) => {
      if (data.status) setStatus(data.status);
      if (data.traders) setTraders(data.traders);
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
          <span>Connection: <strong style={{ color: connected ? "#00ff00" : "#ff0000" }}>{connected ? "CONNECTED" : "DISCONNECTED"}</strong></span>
        </div>
      </div>

      {/* Traders */}
      {traders.length === 0 ? (
        <div style={{ textAlign: "center", color: "#888", marginTop: "50px" }}>
          <h3>No Active Traders</h3>
          <p>Waiting for traders to be launched...</p>
        </div>
      ) : (
        traders.map(trader => (
          <TraderCard key={trader.id} trader={trader} onDestroy={() => destroyTrader(trader.symbol)} />
        ))
      )}
    </div>
  );
}

function TraderCard({ trader, onDestroy }) {
  const pos = trader.position;
  const history = trader.tradeHistory || [];
  
  // Calculate equity-based numbers for verification
  const equityFraction = 0.50; // From config
  const currentEquity = 80; // Default, could get from status
  const expectedBaseNotional = equityFraction * currentEquity;
  const expectedNotional = expectedBaseNotional * trader.leverage;

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
        <div>
          <h2 style={{ margin: "0", color: "#00aaff" }}>{trader.symbol}</h2>
          <div style={{ fontSize: "12px", color: "#888", marginTop: "5px" }}>
            Created: {new Date(trader.createdAt).toLocaleString()}
          </div>
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

      {/* Notional Verification */}
      <div style={{ marginBottom: "20px", padding: "15px", backgroundColor: "#1a1a1a", borderRadius: "4px" }}>
        <h4 style={{ margin: "0 0 10px 0", color: "#ffff00" }}>Notional Calculation Verification</h4>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "20px", fontSize: "14px" }}>
          <div>
            <div>Expected Base: ${fmt(expectedBaseNotional, 2)}</div>
            <div>Actual Base: ${fmt(trader.baseNotional, 2)}</div>
            <div style={{ color: Math.abs(expectedBaseNotional - trader.baseNotional) < 0.01 ? "#00ff00" : "#ff4444" }}>
              {Math.abs(expectedBaseNotional - trader.baseNotional) < 0.01 ? "✓ CORRECT" : "✗ INCORRECT"}
            </div>
          </div>
          <div>
            <div>Expected Notional: ${fmt(expectedNotional, 2)}</div>
            <div>Actual Notional: ${fmt(trader.notional, 2)}</div>
            <div style={{ color: Math.abs(expectedNotional - trader.notional) < 0.01 ? "#00ff00" : "#ff4444" }}>
              {Math.abs(expectedNotional - trader.notional) < 0.01 ? "✓ CORRECT" : "✗ INCORRECT"}
            </div>
          </div>
          <div>
            <div>Formula: 0.5 × ${currentEquity} × {trader.leverage}x</div>
            <div>Result: ${fmt(expectedNotional, 2)}</div>
          </div>
        </div>
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
