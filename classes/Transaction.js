const { v4: uuidv4 } = require('uuid');

class Transaction {
  constructor(trader, config) {
    // Link to trader
    this.trader = trader;
    this.id = uuidv4();
    
    // Transaction data
    this.symbol = config.symbol;
    this.amount = config.amount;  // Base asset amount (calculated from USDT)
    this.usdtAmount = config.usdtAmount || (config.amount * config.price);  // USDT amount
    this.price = config.price;
    this.priceLevel = config.priceLevel || config.price;  // Store the actual price level
    this.levelIndex = config.levelIndex || 0;  // Store the level index
    
    // Ensure percentageLevel is always defined with multiple fallbacks
    if (config.percentageLevel !== undefined && !isNaN(config.percentageLevel)) {
      this.percentageLevel = config.percentageLevel;
    } else {
      // Try to calculate from price data
      const calculated = this.calculatePercentageFromPrice(config.price, config.startPrice);
      if (calculated !== undefined && !isNaN(calculated)) {
        this.percentageLevel = calculated;
      } else {
        // Final fallback - use level index or default to 0
        this.percentageLevel = config.levelIndex || 0;
        console.log(`⚠️ ${this.symbol}: Using levelIndex as percentageLevel fallback: ${this.percentageLevel}`);
      }
    }
    this.side = config.side;
    this.orderType = config.orderType || 'MARKET';  // MARKET or LIMIT
    this.orderValidation = config.orderValidation; // Store validation result with precision info
    this.testingMode = config.testingMode !== undefined ? config.testingMode : true;
    this.skipExecution = config.skipExecution || false; // Skip auto-execution for pre-filled transactions
    
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
    
    console.log(`Transaction created: ${this.symbol} ${this.side} ${this.amount} (≈$${this.usdtAmount.toFixed(2)} USDT) at ${this.percentageLevel}% (${this.testingMode ? 'TESTING' : 'LIVE'} mode)`);
    console.log(`🔍 ${this.symbol}: Transaction amount debug - amount: ${this.amount}, usdtAmount: ${this.usdtAmount}, price: ${this.price}`);
    console.log(`🚨 ${this.symbol}: CRITICAL DEBUG - testingMode: ${this.testingMode}, skipExecution: ${this.skipExecution}`);
    
    // Automatically execute the transaction (simulate immediate fill for momentum trading)
    if (!this.skipExecution) {
      if (this.testingMode) {
        // For testing mode, execute synchronously
        console.log(`🎯 ${this.symbol}: Using synchronous TESTING execution`);
        this.executeTesting();
      } else {
        // For live mode, execute asynchronously
        console.log(`🎯 ${this.symbol}: Using asynchronous LIVE execution`);
        this.executeTransaction().then(() => {
          console.log(`🎯 ${this.symbol}: Async execution completed - status: ${this.status}, executedAmount: ${this.executedAmount}, executedPrice: ${this.executedPrice}`);
        }).catch(error => {
          console.log(`❌ ${this.symbol}: Async execution failed:`, error.message);
          this.status = 'FAILED';
        });
        
        // Add a small delay and check the state
        setTimeout(() => {
          console.log(`⏰ ${this.symbol}: Transaction state after 100ms - status: ${this.status}, executedAmount: ${this.executedAmount}, executedPrice: ${this.executedPrice}`);
        }, 100);
      }
    } else {
      console.log(`⏭️ ${this.symbol}: Skipping auto-execution (skipExecution=true)`);
    }
  }

  // Helper method to calculate percentage level from price
  calculatePercentageFromPrice(currentPrice, startPrice) {
    // Validate inputs
    if (!currentPrice || isNaN(currentPrice)) {
      console.log(`⚠️ ${this.symbol}: Invalid currentPrice for percentage calculation`);
      return null;
    }
    
    if (!startPrice || startPrice === 0 || isNaN(startPrice)) {
      console.log(`⚠️ ${this.symbol}: No valid start price for percentage calculation`);
      return null;
    }
    
    const percentage = ((currentPrice - startPrice) / startPrice) * 100;
    const result = parseFloat(percentage.toFixed(2));
    
    if (isNaN(result)) {
      console.log(`⚠️ ${this.symbol}: Percentage calculation resulted in NaN`);
      return null;
    }
    
    return result;
  }

  // Synchronous testing execution (no async issues)
  executeTesting() {
    console.log(`🧪 ${this.symbol}: TESTING mode execution (synchronous) - amount: ${this.amount}`);
    this.status = 'FILLED';
    this.executedPrice = this.price;
    this.executedAmount = this.amount;
    this.filledAt = new Date();
    
    // Generate a mock order ID for testing
    this.orderId = `TEST_${this.symbol}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    console.log(`✅ ${this.symbol}: [TESTING] Transaction SIMULATED - ${this.side} ${this.executedAmount} (≈$${this.usdtAmount.toFixed(2)} USDT) at $${this.executedPrice}`);
    console.log(`✅ ${this.symbol}: Testing execution completed immediately - status: ${this.status}, executedAmount: ${this.executedAmount}, executedPrice: ${this.executedPrice}`);
  }

  // Execute the transaction (simulate or real Binance order execution)
  async executeTransaction() {
    console.log(`🔄 ${this.symbol}: Starting executeTransaction - testingMode: ${this.testingMode}, amount: ${this.amount}`);
    
    try {
      if (this.testingMode) {
        // Testing mode: simulate immediate execution locally
        console.log(`🧪 ${this.symbol}: TESTING mode execution - setting executedAmount to ${this.amount}`);
        this.status = 'FILLED';
        this.executedPrice = this.price;
        this.executedAmount = this.amount;
        this.filledAt = new Date();
        
        // Generate a mock order ID for testing
        this.orderId = `TEST_${this.symbol}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        console.log(`${this.symbol}: [TESTING] Transaction SIMULATED - ${this.side} ${this.executedAmount} (≈$${this.usdtAmount.toFixed(2)} USDT) at $${this.executedPrice}`);
        console.log(`✅ ${this.symbol}: After testing execution - status: ${this.status}, executedAmount: ${this.executedAmount}`);
      } else {
        // Live mode: execute real Binance order
        console.log(`🚀 ${this.symbol}: LIVE mode execution starting...`);
        const apiService = this.trader.getApiService();
        
        let orderConfig;
        
        // Use proper step size rounding from API service for precision
        const requirements = this.orderValidation?.requirements;
        if (requirements) {
          // Use API service's proper rounding method
          const finalQuantity = apiService.roundToStepSize(this.amount, requirements.stepSize, requirements.quantityPrecision);
          const finalPrice = apiService.roundToStepSize(this.price, requirements.tickSize, requirements.pricePrecision);
          
          console.log(`📏 ${this.symbol}: Transaction precision - Quantity: ${this.amount} → ${finalQuantity}, Price: ${this.price} → ${finalPrice}`);
          
          orderConfig = {
            symbol: this.symbol,
            side: this.side,
            type: this.orderType,
            quantity: finalQuantity.toString()  // Use string, no additional precision
          };
          
          // Add price for LIMIT orders
          if (this.orderType === 'LIMIT') {
            orderConfig.price = finalPrice.toString();
            orderConfig.timeInForce = 'GTC';  // Good Till Cancelled
          }
        } else {
          console.log(`⚠️ ${this.symbol}: No precision requirements available, using defaults`);
          
          orderConfig = {
            symbol: this.symbol,
            side: this.side,
            type: this.orderType,
            quantity: this.amount.toFixed(8)  // Fallback precision
          };
          
          if (this.orderType === 'LIMIT') {
            orderConfig.price = this.price.toFixed(8);
            orderConfig.timeInForce = 'GTC';
          }
        }
        
        console.log(`🔄 ${this.symbol}: Executing ${this.orderType} order:`, orderConfig);
        
        try {
          const order = await apiService.order(orderConfig);
          console.log(`📨 ${this.symbol}: Binance order response:`, JSON.stringify(order, null, 2));
          
          // Track this order in trader's monitoring system
          if (order && order.orderId && this.trader && this.trader.trackOrder) {
            this.trader.trackOrder(order.orderId, {
              symbol: this.symbol,
              side: this.side,
              orderType: this.orderType,
              amount: this.amount,
              price: this.price,
              usdtAmount: this.usdtAmount,
              priceLevel: this.priceLevel,
              levelIndex: this.levelIndex
            });
          }
          
          if (order && order.orderId) {
            // Parse executed amount more carefully
            let executedQty = 0;
            if (order.executedQty !== undefined) {
              executedQty = parseFloat(order.executedQty);
              console.log(`📊 ${this.symbol}: Order executedQty from Binance: ${order.executedQty} → parsed: ${executedQty}`);
            } else if (order.fills && order.fills.length > 0) {
              // For MARKET orders, sum up all fills
              executedQty = order.fills.reduce((total, fill) => total + parseFloat(fill.qty || 0), 0);
              console.log(`📊 ${this.symbol}: Calculated from fills: ${executedQty}`);
            } else {
              executedQty = 0;
              console.log(`📊 ${this.symbol}: No execution data found, executedQty: 0`);
            }
            
            // Only mark as FILLED if the order actually executed
            if (executedQty > 0) {
              this.status = 'FILLED';
              this.executedPrice = parseFloat(order.fills?.[0]?.price || order.price || this.price);
              this.executedAmount = executedQty;
              this.orderId = order.orderId;
              this.filledAt = new Date();
              
              console.log(`✅ ${this.symbol}: LIVE order EXECUTED - Final executedAmount: ${this.executedAmount}, executedPrice: ${this.executedPrice}`);
              console.log(`✅ ${this.symbol}: [LIVE] Transaction FILLED - ${this.side} ${this.executedAmount} at $${this.executedPrice} (Status: ${this.status})`);
            } else {
              // Order was placed but not executed yet - let order monitoring handle it
              this.status = 'PENDING';
              this.orderId = order.orderId;
              this.executedAmount = 0;
              this.executedPrice = 0;
              
              console.log(`⏳ ${this.symbol}: LIVE order PLACED but not executed - orderId: ${order.orderId}, status: ${order.status}`);
              console.log(`⏳ ${this.symbol}: Transaction status set to PENDING - will be updated by order monitoring`);
            }
            
            // For orders with immediate fills, update the tracked order as filled
            if (this.status === 'FILLED' && this.trader && this.trader.activeOrders && this.trader.activeOrders.has(order.orderId)) {
              const orderInfo = this.trader.activeOrders.get(order.orderId);
              orderInfo.lastStatus = 'FILLED';
              // Remove from active tracking since it's immediately filled
              this.trader.activeOrders.delete(order.orderId);
            }
            console.log(`❌ ${this.symbol}: Order execution failed - no orderId returned. Status: ${this.status}`);
            throw new Error('Order execution failed - no orderId returned');
          }
        } catch (orderError) {
          console.log(`❌ ${this.symbol}: Order execution error:`, orderError.message);
          console.log(`📊 ${this.symbol}: Transaction status remains: ${this.status}`);
          throw orderError;
        }
      }
    } catch (error) {
      console.log(`❌ ${this.symbol}: Error executing transaction:`, error.message);
      console.log(`📊 ${this.symbol}: Transaction state after error - status: ${this.status}, executedAmount: ${this.executedAmount}`);
      this.status = 'FAILED';
    }
    
    console.log(`🏁 ${this.symbol}: executeTransaction completed - final status: ${this.status}, executedAmount: ${this.executedAmount}, testingMode: ${this.testingMode}`);
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
    // Use executedPrice if available, fallback to original price if not executed yet
    const displayPrice = this.executedPrice > 0 ? this.executedPrice : this.price;
    const displayAmount = this.executedAmount > 0 ? this.executedAmount : this.amount;
    
    return {
      id: this.id,
      symbol: this.symbol,
      side: this.side,
      amount: this.amount,
      price: displayPrice,  // Use display price instead of original price
      executedPrice: this.executedPrice,
      executedAmount: this.executedAmount,
      percentageLevel: displayPrice, // Change Level to show price instead of percentage
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
      const percentageDisplay = (this.percentageLevel !== undefined && !isNaN(this.percentageLevel)) ? 
        `${this.percentageLevel}%` : 'L?';
      console.log(`${this.symbol} [${percentageDisplay}]: ${realTimeStatus.currentProfitPercentage.toFixed(2)}% (${realTimeStatus.currentProfit.toFixed(2)})`);
    }

    return realTimeStatus;
  }
};

module.exports = { Transaction };
