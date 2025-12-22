import React, { useState } from 'react';
import { X, TrendingUp, DollarSign, Target, Clock, Activity, BarChart3 } from 'lucide-react';

const TraderModal = ({ traderId, dashboardData, isOpen, onClose }) => {
  // Find the current trader data from dashboardData
  const trader = React.useMemo(() => {
    if (!traderId || !dashboardData.currentTraders) return null;
    // Try to find by ID first, then by symbol as fallback
    return dashboardData.currentTraders.find(t => 
      t.id === traderId || t.symbol === traderId
    );
  }, [traderId, dashboardData.currentTraders]);

  // Extract key values to track changes individually
  const currentPrice = trader?.currentPrice;
  const realTimeTotalProfit = trader?.realTimeTotalProfit;
  const profitPercentage = trader?.profitPercentage;
  const takeProfitPrice = trader?.takeProfitPrice;
  const takeProfitDistance = trader?.takeProfitDistance;
  const averagePrice = trader?.averagePrice;
  const totalPosition = trader?.totalPosition;
  
  React.useEffect(() => {
    if (trader && isOpen) {
      console.log('📊 TraderModal LIVE UPDATE:', {
        symbol: trader.symbol,
        profit: realTimeTotalProfit,
        price: currentPrice,
        profitPercentage: profitPercentage,
        timestamp: new Date().toLocaleTimeString()
      });
    }
  }, [currentPrice, realTimeTotalProfit, profitPercentage, trader?.symbol]);

  if (!isOpen || !trader) return null;

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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
      <div className="bg-trading-card rounded-lg border border-trading-border shadow-2xl w-full max-w-4xl max-h-[90vh] overflow-y-auto m-4">
        {/* Header */}
        <div className="flex justify-between items-center p-6 border-b border-trading-border">
          <div className="flex items-center space-x-3">
            <div className="bg-trading-blue p-2 rounded-lg">
              <BarChart3 className="w-6 h-6 text-white" />
            </div>
            <div>
              <h2 className="text-2xl font-bold text-trading-text">{trader.symbol}</h2>
              <p className="text-trading-text-muted">
                {trader.testingMode ? 'Testing Mode' : 'Live Trading'} • {trader.tradeDirection || 'LONG'} Trader
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-trading-text-muted hover:text-trading-text transition-colors"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        {/* Stats Grid */}
        <div className="p-6 grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-trading-dark p-4 rounded-lg border border-trading-border">
            <div className="flex items-center space-x-2 mb-2">
              <DollarSign className="w-5 h-5 text-trading-green" />
              <span className="text-sm text-trading-text-muted">Current Price</span>
            </div>
            <p className="text-xl font-mono font-bold text-trading-text">
              {formatCurrency(currentPrice)}
            </p>
          </div>

          <div className="bg-trading-dark p-4 rounded-lg border border-trading-border">
            <div className="flex items-center space-x-2 mb-2">
              <TrendingUp className="w-5 h-5 text-trading-blue" />
              <span className="text-sm text-trading-text-muted">Total Profit</span>
            </div>
            <p className="text-xl font-mono font-bold">
              {formatPercentage(profitPercentage)}
            </p>
            <p className="text-sm text-trading-text-muted">
              {formatCurrency(realTimeTotalProfit)}
            </p>
          </div>

          <div className="bg-trading-dark p-4 rounded-lg border border-trading-border">
            <div className="flex items-center space-x-2 mb-2">
              <Target className="w-5 h-5 text-trading-red" />
              <span className="text-sm text-trading-text-muted">Take Profit</span>
            </div>
            <p className="text-xl font-mono font-bold text-trading-text">
              {formatCurrency(takeProfitPrice)}
            </p>
            <p className="text-sm text-trading-text-muted">
              {formatPercentage(takeProfitDistance)} to target
            </p>
          </div>

          <div className="bg-trading-dark p-4 rounded-lg border border-trading-border">
            <div className="flex items-center space-x-2 mb-2">
              <Activity className="w-5 h-5 text-trading-text-muted" />
              <span className="text-sm text-trading-text-muted">Average Price</span>
            </div>
            <p className="text-lg font-mono font-bold text-trading-text">
              {formatCurrency(averagePrice)}
            </p>
          </div>

          <div className="bg-trading-dark p-4 rounded-lg border border-trading-border">
            <div className="flex items-center space-x-2 mb-2">
              <BarChart3 className="w-5 h-5 text-trading-text-muted" />
              <span className="text-sm text-trading-text-muted">Position Size</span>
            </div>
            <p className="text-lg font-mono font-bold text-trading-text">
              {(Number(totalPosition) || 0).toFixed(4)}
            </p>
          </div>

          <div className="bg-trading-dark p-4 rounded-lg border border-trading-border">
            <div className="flex items-center space-x-2 mb-2">
              <Clock className="w-5 h-5 text-trading-text-muted" />
              <span className="text-sm text-trading-text-muted">Price Range</span>
            </div>
            <p className="text-lg font-bold text-trading-text">
              {(Number(trader?.startPercentage) || 0).toFixed(1)}% → {(Number(trader?.highestPercentage) || 0).toFixed(1)}%
            </p>
            <p className="text-xs text-trading-text-muted">
              24h Change: {formatPercentage(trader?.current24hChange || 0)}
            </p>
          </div>
        </div>

        {/* Price Levels */}
        <div className="px-6 pb-4">
          <h3 className="text-lg font-semibold text-trading-text mb-3">
            Price Levels ({(trader?.currentLevelIndex || 0) + 1}/{trader?.priceLevels?.length || 0})
          </h3>
          <div className="flex flex-wrap gap-2">
            {trader?.priceLevels?.map((priceLevel, index) => {
              const isExecuted = trader?.executedLevels?.some(executed => 
                executed.includes(priceLevel.toFixed(4)) || Math.abs(parseFloat(executed.replace('$', '')) - priceLevel) < 0.0001
              );
              const isCurrent = index === (trader?.currentLevelIndex || 0);
              
              return (
                <span
                  key={index}
                  className={`px-3 py-1 rounded-full text-sm font-mono ${
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
          </div>
        </div>

        {/* Transactions Table */}
        <div className="px-6 pb-6">
          <h3 className="text-lg font-semibold text-trading-text mb-4">Transactions</h3>
          <div className="bg-trading-dark rounded-lg border border-trading-border overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-trading-card">
                  <tr>
                    <th className="px-4 py-3 text-left text-sm font-medium text-trading-text-muted">Level</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-trading-text-muted">Side</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-trading-text-muted">Amount</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-trading-text-muted">Price</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-trading-text-muted">Current P&L</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-trading-text-muted">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {trader.transactions.map((transaction, index) => (
                    <tr key={transaction.id || index} className="border-t border-trading-border">
                      <td className="px-4 py-3 text-sm text-trading-text font-mono">
                        {transaction.percentageLevel}$
                      </td>
                      <td className="px-4 py-3 text-sm">
                        <span className={`px-2 py-1 rounded text-xs font-medium ${
                          transaction.side === 'BUY' 
                            ? 'bg-trading-green/20 text-trading-green'
                            : 'bg-trading-red/20 text-trading-red'
                        }`}>
                          {transaction.side}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm text-trading-text font-mono">
                        {transaction.executedAmount || transaction.amount}
                      </td>
                      <td className="px-4 py-3 text-sm text-trading-text font-mono">
                        {formatCurrency(transaction.executedPrice || transaction.price)}
                      </td>
                      <td className="px-4 py-3 text-sm font-mono">
                        <span className={transaction.currentProfit >= 0 ? 'text-trading-green' : 'text-trading-red'}>
                          {formatCurrency(transaction.currentProfit)}
                        </span>
                        <div className="text-xs text-trading-text-muted">
                          {formatPercentage(transaction.currentProfitPercentage)}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-sm">
                        <span className={`px-2 py-1 rounded text-xs font-medium ${
                          transaction.status === 'FILLED' 
                            ? 'bg-trading-green/20 text-trading-green'
                            : transaction.status === 'CLOSED'
                            ? 'bg-trading-text-muted/20 text-trading-text-muted'
                            : 'bg-trading-blue/20 text-trading-blue'
                        }`}>
                          {transaction.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TraderModal;