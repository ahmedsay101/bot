import React, { useState, useEffect } from 'react';
import { TrendingUp, TrendingDown, BarChart3, Users, DollarSign, Activity, RefreshCw, Wifi, WifiOff } from 'lucide-react';
import api from '../services/api';
import websocket from '../services/websocket';
import TraderModal from './TraderModal';

const Dashboard = () => {
  const [dashboardData, setDashboardData] = useState({
    topGainers: [],
    topLosers: [],
    currentTraders: []
  });
  const [selectedTraderId, setSelectedTraderId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState(new Date());
  const [wsConnected, setWsConnected] = useState(false);
  const [useWebSocket, setUseWebSocket] = useState(true);

  const fetchDashboardData = async () => {
    try {
      const data = await api.getDashboard();
      setDashboardData(data);
      setLastUpdate(new Date());
    } catch (error) {
      console.error('Error fetching dashboard data:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (useWebSocket) {
      // Setup WebSocket connection for real-time updates
      websocket.onData((data) => {
        console.log('📊 Dashboard received WebSocket data:', {
          traders: data?.currentTraders?.length || 0,
          topGainers: data?.topGainers?.length || 0,
          topLosers: data?.topLosers?.length || 0,
          traderIds: data?.currentTraders?.map(t => ({symbol: t.symbol, id: t.id})) || [],
          firstTrader: data?.currentTraders?.[0]
        });
        setDashboardData(data);
        setLastUpdate(new Date());
        setLoading(false);
      });
      
      websocket.connect();
      setWsConnected(websocket.getConnectionStatus());
      
      // Check connection status periodically
      const statusInterval = setInterval(() => {
        setWsConnected(websocket.getConnectionStatus());
      }, 1000);
      
      return () => {
        clearInterval(statusInterval);
        websocket.disconnect();
      };
    } else {
      // Fallback to REST API polling
      fetchDashboardData();
      const interval = setInterval(fetchDashboardData, 5000);
      return () => clearInterval(interval);
    }
  }, [useWebSocket]);



  const formatCurrency = (value) => {
    const numValue = Number(value) || 0;
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 6
    }).format(numValue);
  };

  const formatPercentage = (value) => {
    const numValue = Number(value) || 0;
    const color = numValue >= 0 ? 'text-trading-green' : 'text-trading-red';
    const sign = numValue >= 0 ? '+' : '';
    return <span className={color}>{sign}{numValue.toFixed(2)}%</span>;
  };

  const MarketCard = ({ title, items, icon: Icon, trendColor }) => (
    <div className="bg-trading-card rounded-lg border border-trading-border p-6 hover:border-trading-blue/50 transition-colors">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center space-x-2">
          <Icon className={`w-6 h-6 ${trendColor}`} />
          <h3 className="text-lg font-semibold text-trading-text">{title}</h3>
        </div>
        <span className="text-sm text-trading-text-muted">{items.length} symbols</span>
      </div>
      <div className="space-y-3">
        {items.slice(0, 5).map((item, index) => (
          <div key={item.symbol || index} className="flex justify-between items-center p-3 bg-trading-dark rounded-lg">
            <div>
              <p className="font-mono font-bold text-trading-text">{item.symbol}</p>
              <p className="text-sm text-trading-text-muted">{formatCurrency(item.price || item.lastPrice)}</p>
            </div>
            <div className="text-right">
              <p className="font-mono">{formatPercentage(item.priceChangePercent)}</p>
              <p className="text-sm text-trading-text-muted">
                {formatCurrency(item.priceChange || (item.price * item.priceChangePercent / 100))}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  const TraderCard = ({ trader }) => (
    <div 
      className="bg-trading-card rounded-lg border border-trading-border p-6 hover:border-trading-blue/50 transition-all cursor-pointer hover:shadow-lg"
      onClick={() => {
        const traderId = trader.id || trader.symbol;
        console.log('🎯 Trader selected:', trader.symbol, 'Using ID:', traderId);
        setSelectedTraderId(traderId);
      }}
    >
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center space-x-3">
            <div className="bg-trading-blue p-2 rounded-lg">
              <BarChart3 className="w-5 h-5 text-white" />
            </div>
            <div>
              <h3 className="font-mono font-bold text-trading-text">{trader.symbol}</h3>
              <p className="text-sm text-trading-text-muted">
                {trader.testingMode ? 'Testing Mode' : 'Live Trading'} • {trader.tradeDirection || 'LONG'}
              </p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-sm text-trading-text-muted">Current Price</p>
            <p className="font-mono text-trading-text">{formatCurrency(trader.currentPrice)}</p>
            <div className="text-sm">
              {formatPercentage(trader.current24hChange || 0)}
            </div>
          </div>
        </div>      <div className="grid grid-cols-3 gap-3 mb-4">
        <div className="text-center">
          <p className="text-xs text-trading-text-muted">Total Profit</p>
          <p className={`font-mono font-bold text-sm ${
            (trader.realTimeTotalProfit || 0) >= 0 ? 'text-trading-green' : 'text-trading-red'
          }`}>
            {formatCurrency(trader.realTimeTotalProfit)}
          </p>
        </div>
        <div className="text-center">
          <p className="text-xs text-trading-text-muted">Average Price</p>
          <p className="font-mono font-bold text-sm text-trading-text">
            {formatCurrency(trader.averagePrice)}
          </p>
        </div>
        <div className="text-center">
          <p className="text-xs text-trading-text-muted">Position Size</p>
          <p className="font-mono font-bold text-sm text-trading-text">
            {formatCurrency((Number(trader.totalPosition) || 0) * (Number(trader.averagePrice) || 0))}
          </p>
        </div>
      </div>

      <div className="mb-4">
        <div className="flex justify-between text-sm text-trading-text-muted mb-1">
          <span>Take Profit Progress ({trader.tradeDirection})</span>
          <span>{formatPercentage(trader.takeProfitDistance)} to target</span>
        </div>
        <div className="w-full bg-trading-dark rounded-full h-2">
          <div 
            className={`h-2 rounded-full transition-all ${
              (trader.profitPercentage || 0) >= 0 
                ? 'bg-gradient-to-r from-trading-blue to-trading-green' 
                : 'bg-gradient-to-r from-trading-red/50 to-trading-red'
            }`}
            style={{ 
              width: `${Math.max(0, Math.min(100, 
                trader.tradeDirection === 'SHORT' 
                  ? Math.max(0, (trader.profitPercentage || 0) / 10 * 100) // For SHORT: positive profit = progress toward take profit
                  : Math.max(0, (trader.profitPercentage || 0) / 10 * 100) // For LONG: positive profit = progress toward take profit
              ))}%` 
            }}
          ></div>
        </div>
      </div>

      <div className="flex justify-between items-center">
        <div>
          <p className="text-sm text-trading-text-muted">Transactions</p>
          <p className="font-bold text-trading-text">{(trader.transactions || []).length}</p>
        </div>
        <div className="text-right">
          <p className="text-sm text-trading-text-muted">P&L</p>
          <p className={`text-sm font-mono font-bold ${
            (trader.profitPercentage || 0) >= 0 ? 'text-trading-green' : 'text-trading-red'
          }`}>
            {(trader.profitPercentage || 0) >= 0 ? '+' : ''}{(Number(trader.profitPercentage) || 0).toFixed(2)}%
          </p>
        </div>
      </div>

      <div className="mt-4 pt-3 border-t border-trading-border">
        <p className="text-sm text-trading-text-muted mb-2">Price Levels ({trader.currentLevelIndex + 1 || 1}/{trader.priceLevels?.length || 0})</p>
        <div className="flex flex-wrap gap-1">
          {trader.priceLevels?.slice(0, 8).map((priceLevel, index) => {
            const isExecuted = trader.executedLevels?.some(executed => 
              executed.includes(priceLevel.toFixed(4)) || Math.abs(parseFloat(executed.replace('$', '')) - priceLevel) < 0.0001
            );
            const isCurrent = index === (trader.currentLevelIndex || 0);
            
            return (
              <span
                key={index}
                className={`px-2 py-1 rounded text-xs font-mono ${
                  isCurrent 
                    ? 'bg-trading-green/30 text-trading-green border border-trading-green/50' 
                    : isExecuted 
                    ? 'bg-trading-blue/20 text-trading-blue' 
                    : 'bg-trading-dark/50 text-trading-text-muted border border-trading-border'
                }`}
              >
                ${priceLevel.toFixed(4)}
              </span>
            );
          })}
          {trader.priceLevels?.length > 8 && (
            <span className="px-2 py-1 bg-trading-text-muted/20 text-trading-text-muted rounded text-xs">
              +{trader.priceLevels.length - 8} more
            </span>
          )}
        </div>
      </div>
    </div>
  );

  const StatsCard = ({ title, value, subtitle, icon: Icon, color = "text-trading-text" }) => (
    <div className="bg-trading-card rounded-lg border border-trading-border p-4">
      <div className="flex items-center space-x-3">
        <div className="bg-trading-blue p-2 rounded-lg">
          <Icon className="w-5 h-5 text-white" />
        </div>
        <div>
          <p className="text-sm text-trading-text-muted">{title}</p>
          <p className={`text-xl font-bold ${color}`}>{value}</p>
          {subtitle && <p className="text-sm text-trading-text-muted">{subtitle}</p>}
        </div>
      </div>
    </div>
  );

  if (loading) {
    return (
      <div className="min-h-screen bg-trading-bg flex items-center justify-center">
        <div className="flex items-center space-x-3">
          <RefreshCw className="w-8 h-8 text-trading-blue animate-spin" />
          <span className="text-trading-text text-lg">Loading trading data...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-trading-bg">
      {/* Header */}
      <div className="bg-trading-card border-b border-trading-border p-6">
        <div className="max-w-7xl mx-auto">
          <div className="flex justify-between items-center">
            <div>
              <h1 className="text-3xl font-bold text-trading-text">Trading Dashboard</h1>
              <p className="text-trading-text-muted">Real-time cryptocurrency trading platform</p>
            </div>
            <div className="flex items-center space-x-4">
              <div className="flex items-center space-x-2">
                {wsConnected ? (
                  <Wifi className="w-4 h-4 text-trading-green" />
                ) : (
                  <WifiOff className="w-4 h-4 text-trading-red" />
                )}
                <span className="text-sm text-trading-text-muted">
                  {wsConnected ? 'Real-time' : 'Polling'}
                </span>
              </div>
              <div className="text-right">
                <p className="text-sm text-trading-text-muted">Last Update</p>
                <p className="text-sm font-mono text-trading-text">{lastUpdate.toLocaleTimeString()}</p>
              </div>
              <button
                onClick={() => setUseWebSocket(!useWebSocket)}
                className={`px-4 py-2 rounded-lg flex items-center space-x-2 transition-colors ${
                  useWebSocket 
                    ? 'bg-trading-green hover:bg-trading-green/80 text-white' 
                    : 'bg-trading-text-muted hover:bg-trading-text-muted/80 text-white'
                }`}
              >
                {useWebSocket ? <Wifi className="w-4 h-4" /> : <WifiOff className="w-4 h-4" />}
                <span>{useWebSocket ? 'WebSocket' : 'REST API'}</span>
              </button>
              {!useWebSocket && (
                <button
                  onClick={fetchDashboardData}
                  className="bg-trading-blue hover:bg-trading-blue/80 text-white px-4 py-2 rounded-lg flex items-center space-x-2 transition-colors"
                >
                  <RefreshCw className="w-4 h-4" />
                  <span>Refresh</span>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto p-6">
        {/* Stats Overview */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
          <StatsCard
            title="Active Traders"
            value={dashboardData.currentTraders?.length || 0}
            subtitle="Running strategies"
            icon={Users}
          />
          <StatsCard
            title="Active Positions"
            value={(dashboardData.currentTraders || []).reduce((sum, trader) => sum + ((trader.transactions || []).length), 0)}
            subtitle="Total open positions"
            icon={TrendingUp}
            color="text-trading-blue"
          />
          <StatsCard
            title="Profitable Traders"
            value={(dashboardData.currentTraders || []).filter(trader => (trader.realTimeTotalProfit || 0) > 0).length}
            subtitle="Making profit"
            icon={TrendingUp}
            color="text-trading-green"
          />
          <StatsCard
            title="Total Profit"
            value={formatCurrency(
              (dashboardData.currentTraders || []).reduce((sum, trader) => sum + (trader.realTimeTotalProfit || 0), 0)
            )}
            subtitle="All active traders"
            icon={DollarSign}
            color={(dashboardData.currentTraders || []).reduce((sum, trader) => sum + (trader.realTimeTotalProfit || 0), 0) >= 0 ? 'text-trading-green' : 'text-trading-red'}
          />
        </div>

        {/* Main Content Grid */}
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
          {/* Market Data */}
          <MarketCard
            title="Top Gainers"
            items={dashboardData.topGainers}
            icon={TrendingUp}
            trendColor="text-trading-green"
          />
          
          <MarketCard
            title="Top Losers"
            items={dashboardData.topLosers}
            icon={TrendingDown}
            trendColor="text-trading-red"
          />

          {/* Quick Stats */}
          <div className="bg-trading-card rounded-lg border border-trading-border p-6">
            <div className="flex items-center space-x-2 mb-4">
              <Activity className="w-6 h-6 text-trading-blue" />
              <h3 className="text-lg font-semibold text-trading-text">Platform Stats</h3>
            </div>
            <div className="space-y-4">
              <div className="flex justify-between">
                <span className="text-trading-text-muted">Total Transactions</span>
                <span className="font-mono font-bold text-trading-text">
                  {(dashboardData.currentTraders || []).reduce((sum, trader) => sum + ((trader.transactions || []).length), 0)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-trading-text-muted">Testing Mode Traders</span>
                <span className="font-mono font-bold text-trading-text">
                  {(dashboardData.currentTraders || []).filter(trader => trader.testingMode).length}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-trading-text-muted">Live Traders</span>
                <span className="font-mono font-bold text-trading-text">
                  {(dashboardData.currentTraders || []).filter(trader => !trader.testingMode).length}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-trading-text-muted">Avg Performance</span>
                <span className="font-mono font-bold">
                  {formatPercentage(
                    (dashboardData.currentTraders || []).length > 0 
                      ? (dashboardData.currentTraders || []).reduce((sum, trader) => sum + (trader.profitPercentage || 0), 0) / (dashboardData.currentTraders || []).length
                      : 0
                  )}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Active Traders */}
        {(dashboardData.currentTraders || []).length > 0 && (
          <div className="mt-8">
            <div className="mb-6">
              <h2 className="text-2xl font-bold text-trading-text mb-2">Active Traders</h2>
              <p className="text-trading-text-muted">Click on any trader card to view detailed information</p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
              {(dashboardData.currentTraders || []).map((trader, index) => (
                <TraderCard key={trader.id || trader.symbol || index} trader={trader} />
              ))}
            </div>
          </div>
        )}

        {/* Empty State */}
        {(dashboardData.currentTraders || []).length === 0 && (
          <div className="mt-8 bg-trading-card rounded-lg border border-trading-border p-12 text-center">
            <BarChart3 className="w-16 h-16 text-trading-text-muted mx-auto mb-4" />
            <h3 className="text-xl font-semibold text-trading-text mb-2">No Active Traders</h3>
            <p className="text-trading-text-muted">Start trading by selecting symbols from the market data above</p>
          </div>
        )}
      </div>

      {/* Trader Modal */}
      <TraderModal
        key={selectedTraderId || 'no-trader'}
        traderId={selectedTraderId}
        dashboardData={dashboardData}
        isOpen={!!selectedTraderId}
        onClose={() => {
          setSelectedTraderId(null);
        }}
      />
    </div>
  );
};

export default Dashboard;