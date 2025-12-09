import React, { useState } from 'react';
import { X, TrendingUp, DollarSign, Target, Clock, Activity, BarChart3 } from 'lucide-react';

const TraderModal = ({ trader, isOpen, onClose }) => {
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
                {trader.testingMode ? 'Testing Mode' : 'Live Trading'}
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
              {formatCurrency(trader.currentPrice)}
            </p>
          </div>

          <div className="bg-trading-dark p-4 rounded-lg border border-trading-border">
            <div className="flex items-center space-x-2 mb-2">
              <TrendingUp className="w-5 h-5 text-trading-blue" />
              <span className="text-sm text-trading-text-muted">Total Profit</span>
            </div>
            <p className="text-xl font-mono font-bold">
              {formatPercentage(trader.profitPercentage)}
            </p>
            <p className="text-sm text-trading-text-muted">
              {formatCurrency(trader.realTimeTotalProfit)}
            </p>
          </div>

          <div className="bg-trading-dark p-4 rounded-lg border border-trading-border">
            <div className="flex items-center space-x-2 mb-2">
              <Target className="w-5 h-5 text-trading-red" />
              <span className="text-sm text-trading-text-muted">Take Profit</span>
            </div>
            <p className="text-xl font-mono font-bold text-trading-text">
              {formatCurrency(trader.takeProfitPrice)}
            </p>
            <p className="text-sm text-trading-text-muted">
              {formatPercentage(trader.takeProfitDistance)} to target
            </p>
          </div>

          <div className="bg-trading-dark p-4 rounded-lg border border-trading-border">
            <div className="flex items-center space-x-2 mb-2">
              <Activity className="w-5 h-5 text-trading-text-muted" />
              <span className="text-sm text-trading-text-muted">Average Price</span>
            </div>
            <p className="text-lg font-mono font-bold text-trading-text">
              {formatCurrency(trader.averagePrice)}
            </p>
          </div>

          <div className="bg-trading-dark p-4 rounded-lg border border-trading-border">
            <div className="flex items-center space-x-2 mb-2">
              <BarChart3 className="w-5 h-5 text-trading-text-muted" />
              <span className="text-sm text-trading-text-muted">Position Size</span>
            </div>
            <p className="text-lg font-mono font-bold text-trading-text">
              {(Number(trader.totalPosition) || 0).toFixed(4)}
            </p>
          </div>

          <div className="bg-trading-dark p-4 rounded-lg border border-trading-border">
            <div className="flex items-center space-x-2 mb-2">
              <Clock className="w-5 h-5 text-trading-text-muted" />
              <span className="text-sm text-trading-text-muted">Performance</span>
            </div>
            <p className="text-lg font-bold text-trading-text">
              {trader.startPercentage || 0}% → {(Number(trader.highestPercentage) || 0).toFixed(1)}%
            </p>
          </div>
        </div>

        {/* Executed Levels */}
        <div className="px-6 pb-4">
          <h3 className="text-lg font-semibold text-trading-text mb-3">Executed Levels</h3>
          <div className="flex flex-wrap gap-2">
            {trader.executedLevels.map((level, index) => (
              <span
                key={index}
                className="px-3 py-1 bg-trading-blue/20 text-trading-blue rounded-full text-sm font-mono"
              >
                {level}%
              </span>
            ))}
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
                        {transaction.percentageLevel}%
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