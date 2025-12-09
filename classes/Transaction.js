const { v4: uuidv4 } = require('uuid');

class Transaction {
  constructor(trader, config) {
    // Link to trader
    this.trader = trader;
    this.id = uuidv4();
    
    // Transaction data
    this.symbol = config.symbol;
    this.amount = config.amount;
    this.price = config.price;
    this.percentageLevel = config.percentageLevel;
    this.side = config.side;
    this.testingMode = config.testingMode !== undefined ? config.testingMode : true;
    
    // Transaction state
    this.status = 'CREATED';  // CREATED -> FILLED -> CLOSED
    this.orderId = null;
    this.executedPrice = 0;
    this.executedAmount = 0;
    this.profit = 0;
    
    // Timestamps
    this.createdAt = new Date();
    this.filledAt = null;
    this.closedAt = null;
    
    console.log(`Transaction created: ${this.symbol} ${this.side} ${this.amount} at ${this.percentageLevel}% (${this.testingMode ? 'TESTING' : 'LIVE'} mode)`);
    
    // Automatically execute the transaction (simulate immediate fill for momentum trading)
    this.executeTransaction();
  }

  // Execute the transaction (simulate or real Binance order execution)
  async executeTransaction() {
    try {
      if (this.testingMode) {
        // Testing mode: simulate immediate execution locally
        this.status = 'FILLED';
        this.executedPrice = this.price;
        this.executedAmount = this.amount;
        this.filledAt = new Date();
        
        // Generate a mock order ID for testing
        this.orderId = `TEST_${this.symbol}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        console.log(`${this.symbol}: [TESTING] Transaction SIMULATED - ${this.side} ${this.executedAmount} at $${this.executedPrice}`);
      } else {
        // Live mode: execute real Binance order
        const apiService = this.trader.getApiService();
        const order = await apiService.order({
          symbol: this.symbol,
          side: this.side,
          type: 'MARKET',
          quantity: this.amount
        });
        
        if (order && order.orderId) {
          this.status = 'FILLED';
          this.executedPrice = parseFloat(order.fills?.[0]?.price || this.price);
          this.executedAmount = parseFloat(order.executedQty || this.amount);
          this.orderId = order.orderId;
          this.filledAt = new Date();
          
          console.log(`${this.symbol}: [LIVE] Transaction FILLED - ${this.side} ${this.executedAmount} at $${this.executedPrice}`);
        } else {
          throw new Error('Order execution failed');
        }
      }
    } catch (error) {
      console.log(`Error executing transaction for ${this.symbol}:`, error.message);
      this.status = 'FAILED';
    }
  }

  // Close the transaction (sell position)
  async close() {
    try {
      if (this.status !== 'FILLED') {
        console.log(`Cannot close transaction ${this.id}: Status is ${this.status}`);
        return false;
      }

      // Get current price for profit calculation
      const currentData = this.trader.getCurrentPrice();
      if (!currentData) {
        console.log(`Cannot close transaction ${this.id}: No current price data`);
        return false;
      }

      const currentPrice = parseFloat(currentData.price);
      
      // Calculate profit
      if (this.side === 'BUY') {
        this.profit = (currentPrice - this.executedPrice) * this.executedAmount;
      } else {
        this.profit = (this.executedPrice - currentPrice) * this.executedAmount;
      }

      this.status = 'CLOSED';
      this.closedAt = new Date();

      if (this.testingMode) {
        console.log(`${this.symbol}: [TESTING] Transaction SIMULATED CLOSE - Profit: ${this.profit.toFixed(2)} (${this.percentageLevel}% level)`);
      } else {
        // Live mode: place actual sell order
        const apiService = this.trader.getApiService();
        const closeOrder = await apiService.order({
          symbol: this.symbol,
          side: this.side === 'BUY' ? 'SELL' : 'BUY',
          type: 'MARKET',
          quantity: this.executedAmount
        });
        
        console.log(`${this.symbol}: [LIVE] Transaction CLOSED - Profit: ${this.profit.toFixed(2)} (${this.percentageLevel}% level)`);
      }

      return true;
    } catch (error) {
      console.log(`Error closing transaction ${this.id}:`, error.message);
      return false;
    }
  }

  // Get transaction summary
  getSummary() {
    return {
      id: this.id,
      symbol: this.symbol,
      side: this.side,
      amount: this.amount,
      price: this.price,
      executedPrice: this.executedPrice,
      executedAmount: this.executedAmount,
      percentageLevel: this.percentageLevel,
      status: this.status,
      profit: this.profit,
      orderId: this.orderId,
      createdAt: this.createdAt,
      filledAt: this.filledAt,
      closedAt: this.closedAt
    };
  }

  // Get current market price for this transaction
  getCurrentPrice() {
    const currentData = this.trader.getCurrentPrice();
    return currentData ? parseFloat(currentData.price) : 0;
  }

  // Calculate current profit/loss in real-time
  getCurrentProfit() {
    const currentPrice = this.getCurrentPrice();
    if (!currentPrice || this.status !== 'FILLED') return 0;

    if (this.side === 'BUY') {
      return (currentPrice - this.executedPrice) * this.executedAmount;
    } else {
      return (this.executedPrice - currentPrice) * this.executedAmount;
    }
  }

  // Calculate percentage gain/loss from entry price
  getCurrentProfitPercentage() {
    const currentPrice = this.getCurrentPrice();
    if (!currentPrice || this.status !== 'FILLED' || this.executedPrice === 0) return 0;

    if (this.side === 'BUY') {
      return ((currentPrice - this.executedPrice) / this.executedPrice) * 100;
    } else {
      return ((this.executedPrice - currentPrice) / this.executedPrice) * 100;
    }
  }

  // Get real-time transaction status with current market data
  getRealTimeStatus() {
    const currentPrice = this.getCurrentPrice();
    const currentProfit = this.getCurrentProfit();
    const profitPercentage = this.getCurrentProfitPercentage();

    return {
      ...this.getSummary(),
      currentPrice: currentPrice,
      currentProfit: currentProfit,
      currentProfitPercentage: profitPercentage,
      priceChange: currentPrice - this.executedPrice,
      priceChangePercentage: profitPercentage,
      isInProfit: currentProfit > 0
    };
  }

  // Update transaction every second (called from trader tick)
  updateRealTime() {
    if (this.status !== 'FILLED') return;

    const realTimeStatus = this.getRealTimeStatus();
    
    // Log significant price movements (optional, for monitoring)
    if (Math.abs(realTimeStatus.currentProfitPercentage) > 5) { // Log if >5% change
      console.log(`${this.symbol} [${this.percentageLevel}%]: ${realTimeStatus.currentProfitPercentage.toFixed(2)}% (${realTimeStatus.currentProfit.toFixed(2)})`);
    }

    return realTimeStatus;
  }
};

module.exports = { Transaction };
