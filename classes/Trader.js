const { v4: uuidv4 } = require('uuid');

class Trader {
    constructor(controller, config) {
        // Link to controller
        this.controller = controller;
        this.id = uuidv4();
        
        // Store configuration data
        this.symbol = config.symbol;
        this.startPercentage = config.percentage;  // Starting percentage when trader was created
        this.price = config.price;
        this.priceChange = config.priceChange;
        this.volume = config.volume;
        this.contractAge = config.contractAge;
        
        // Trading configuration
        this.usdtAmount = config.usdtAmount || 10;  // USDT amount per order (not base asset)
        this.percentageStep = 10;            // Percentage step for new orders
        this.takeProfit = config.takeProfit || 10;  // Take profit percentage
        this.testingMode = config.testingMode !== undefined ? config.testingMode : true;
        this.tradeDirection = config.tradeDirection || 'SHORT';  // 'LONG' or 'SHORT'
        
        // Trading state
        this.transactions = [];              // All transactions for this trader
        this.executedLevels = new Set();     // Track which percentage levels have been executed
        this.highestPercentage = this.startPercentage;  // Track highest percentage reached
        this.averagePrice = 0;               // Average position price
        this.totalPosition = 0;              // Total position size
        this.takeProfitPrice = 0;            // Calculated take profit price
        
        // Trading properties
        this.status = 'ACTIVE';
        this.createdAt = new Date();
        this.updatedAt = new Date();
        
        // Performance tracking
        this.profit = 0;
        this.totalTrades = 0;
        this.successfulTrades = 0;
        
        // Initialize first level as executed (starting percentage)
        this.executedLevels.add(Math.floor(this.startPercentage / this.percentageStep) * this.percentageStep);
        
        console.log(`Trader created for ${this.symbol} starting at ${this.startPercentage}% with $${this.usdtAmount} USDT per level (${this.tradeDirection} trader, ${this.testingMode ? 'TESTING' : 'LIVE'} mode)`);
        
        // Create initial transaction at starting percentage
        this.createTransaction(this.startPercentage);
    }

    // Get live price data from controller's WebSocket feed
    getCurrentPrice() {
        if (this.controller.tickerData.has(this.symbol)) {
            return this.controller.tickerData.get(this.symbol);
        }
        return null;
    }

    // Get current market data from controller
    getMarketData() {
        return {
            topGainers: this.controller.tickerData.size > 0 ? 
                Array.from(this.controller.tickerData.values())
                    .filter(ticker => parseFloat(ticker.priceChangePercent) > 0)
                    .sort((a, b) => parseFloat(b.priceChangePercent) - parseFloat(a.priceChangePercent))
                    .slice(0, 10) : [],
            currentPrice: this.getCurrentPrice(),
            totalActiveTraders: this.controller.getActiveTraders().length
        };
    }

    // Access controller's API service
    getApiService() {
        return this.controller.service;
    }

    // Get other traders from controller
    getOtherTraders() {
        return this.controller.traders.filter(trader => trader.id !== this.id);
    }

    // Get controller settings
    getControllerSettings() {
        return {
            maxTraders: this.controller.maxTraders,
            minContractPrice: this.controller.minContractPrice,
            minContractDays: this.controller.minContractDays
        };
    }

    // Check if this trader should be active based on current market conditions
    shouldBeActive() {
        const currentData = this.getCurrentPrice();
        if (!currentData) return false;
        
        const currentPercentage = parseFloat(currentData.priceChangePercent);
        const settings = this.getControllerSettings();
        
        // Stay active if still gaining and above minimum price
        return currentPercentage > 0 && 
               parseFloat(currentData.price) >= settings.minContractPrice;
    }

    // Update trader status
    updateStatus() {
        if (!this.shouldBeActive() && this.status === 'ACTIVE') {
            this.status = 'INACTIVE';
            this.updatedAt = new Date();
            console.log(`Trader ${this.symbol} set to inactive`);
        } else if (this.shouldBeActive() && this.status === 'INACTIVE') {
            this.status = 'ACTIVE';
            this.updatedAt = new Date();
            console.log(`Trader ${this.symbol} reactivated`);
        }
    }

    // Create a new transaction
    createTransaction(percentageLevel) {
        try {
            const { Transaction } = require('./Transaction');
            const currentPrice = this.getCurrentPrice();
            
            if (!currentPrice) {
                console.log(`Cannot create transaction for ${this.symbol}: No current price data`);
                return null;
            }

            const price = parseFloat(currentPrice.price);
            // Calculate base asset amount from USDT amount
            const baseAssetAmount = this.usdtAmount / price;
            
            // Determine transaction side based on trade direction
            const transactionSide = this.tradeDirection === 'SHORT' ? 'SELL' : 'BUY';

            const transaction = new Transaction(this, {
                symbol: this.symbol,
                amount: baseAssetAmount,  // Base asset amount calculated from USDT
                usdtAmount: this.usdtAmount,  // Store original USDT amount
                price: price,
                percentageLevel: percentageLevel,
                side: transactionSide,  // BUY for LONG, SELL for SHORT
                testingMode: this.testingMode
            });

            this.transactions.push(transaction);
            this.totalTrades++;
            
            // Update position tracking
            this.calculateAveragePrice();
            this.calculateTakeProfitPrice();
            
            console.log(`${this.symbol}: Created transaction at ${percentageLevel}% (Price: $${currentPrice.price})`);
            return transaction;
            
        } catch (error) {
            console.log(`Error creating transaction for ${this.symbol}:`, error.message);
            return null;
        }
    }

    // Calculate average price of all open positions (local calculation)
    calculateAveragePrice() {
        const openTransactions = this.transactions.filter(t => t.status === 'FILLED' || t.status === 'OPEN');
        
        if (openTransactions.length === 0) {
            this.averagePrice = 0;
            this.totalPosition = 0;
            return;
        }

        let totalValue = 0;
        let totalAmount = 0;

        openTransactions.forEach(transaction => {
            totalValue += transaction.executedPrice * transaction.executedAmount;
            totalAmount += transaction.executedAmount;
        });

        this.averagePrice = totalValue / totalAmount;
        this.totalPosition = totalAmount;
    }

    // Get average price from Binance positionRisk endpoint
    async getBinanceAveragePrice() {
        try {
            const apiService = this.getApiService();
            const positionInfo = await apiService.getPositionInfo(this.symbol);
            
            const binanceAverage = parseFloat(positionInfo.entryPrice);
            const binancePosition = parseFloat(positionInfo.positionAmt);
            const unrealizedProfit = parseFloat(positionInfo.unRealizedProfit);
            
            return {
                entryPrice: binanceAverage,
                positionSize: Math.abs(binancePosition),
                unrealizedProfit: unrealizedProfit,
                markPrice: parseFloat(positionInfo.markPrice)
            };
        } catch (error) {
            console.log(`Error getting Binance position for ${this.symbol}:`, error.message);
            return null;
        }
    }

    // Verify local calculation with Binance data
    async verifyAveragePrice() {
        const binanceData = await this.getBinanceAveragePrice();
        
        if (!binanceData) return false;

        const localAverage = this.averagePrice;
        const binanceAverage = binanceData.entryPrice;
        
        const difference = Math.abs(localAverage - binanceAverage);
        const percentageDiff = binanceAverage > 0 ? (difference / binanceAverage) * 100 : 0;

        console.log(`${this.symbol} Price Verification:`);
        console.log(`  Local Average: $${localAverage.toFixed(6)}`);
        console.log(`  Binance Average: $${binanceAverage.toFixed(6)}`);
        console.log(`  Difference: ${percentageDiff.toFixed(4)}%`);
        console.log(`  Position Size - Local: ${this.totalPosition}, Binance: ${binanceData.positionSize}`);
        
        // If there's a significant difference (>0.1%), use Binance data
        if (percentageDiff > 0.1 && binanceAverage > 0) {
            console.log(`${this.symbol}: Using Binance average price due to significant difference`);
            this.averagePrice = binanceAverage;
            this.totalPosition = binanceData.positionSize;
            return false; // Indicates correction was needed
        }

        return true; // Indicates local calculation is accurate
    }

    // Calculate take profit price based on average position and trade direction
    calculateTakeProfitPrice() {
        if (this.averagePrice > 0) {
            if (this.tradeDirection === 'SHORT') {
                // For SHORT positions, take profit BELOW average price
                this.takeProfitPrice = this.averagePrice * (1 - (this.takeProfit / 100));
            } else {
                // For LONG positions, take profit ABOVE average price
                this.takeProfitPrice = this.averagePrice * (1 + (this.takeProfit / 100));
            }
        }
    }

    // Check if current price hits take profit
    async checkTakeProfit() {
        const currentPrice = this.getCurrentPrice();
        if (!currentPrice || this.takeProfitPrice === 0) return false;

        const currentPriceValue = parseFloat(currentPrice.price);
        
        let takeProfitHit = false;
        
        if (this.tradeDirection === 'SHORT') {
            // For SHORT positions, take profit when price goes BELOW target
            takeProfitHit = currentPriceValue <= this.takeProfitPrice;
        } else {
            // For LONG positions, take profit when price goes ABOVE target
            takeProfitHit = currentPriceValue >= this.takeProfitPrice;
        }
        
        if (takeProfitHit) {
            console.log(`${this.symbol}: ${this.tradeDirection} Take profit hit! Current: $${currentPriceValue}, Target: $${this.takeProfitPrice.toFixed(6)}`);
            await this.closeAllPositions();
            this.destroy();
            return true;
        }
        
        return false;
    }

    // Close all open positions
    async closeAllPositions() {
        console.log(`${this.symbol}: Closing all positions for take profit`);
        
        const openTransactions = this.transactions.filter(t => t.status === 'FILLED' || t.status === 'OPEN');
        
        // Close all positions concurrently
        const closePromises = openTransactions.map(async (transaction) => {
            const success = await transaction.close();
            if (success) {
                this.successfulTrades++;
            }
            return success;
        });

        await Promise.all(closePromises);

        // Calculate final profit
        this.calculateProfit();
        console.log(`${this.symbol}: Final profit: ${this.profit.toFixed(2)}`);
    }

    // Calculate total profit from all transactions
    calculateProfit() {
        const currentPrice = this.getCurrentPrice();
        if (!currentPrice) return;

        const currentPriceValue = parseFloat(currentPrice.price);
        let totalProfit = 0;

        this.transactions.forEach(transaction => {
            if (transaction.status === 'FILLED' || transaction.status === 'CLOSED') {
                const transactionProfit = (currentPriceValue - transaction.price) * transaction.amount;
                totalProfit += transactionProfit;
            }
        });

        this.profit = totalProfit;
    }

    // Update all transactions with real-time data
    updateAllTransactions() {
        this.transactions.forEach(transaction => {
            transaction.updateRealTime();
        });
    }

    // Main tick function for trader operations
    async tick() {
        try {
            this.updateStatus();
            
            if (this.status !== 'ACTIVE') return;
            
            // Update all transactions with real-time price data
            this.updateAllTransactions();
            
            // Check take profit first
            if (await this.checkTakeProfit()) return;
            
            const currentData = this.getCurrentPrice();
            if (!currentData) return;

            const currentPercentage = parseFloat(currentData.priceChangePercent);
            
            // Update highest percentage reached
            if (currentPercentage > this.highestPercentage) {
                this.highestPercentage = currentPercentage;
            }

            // Check if we need to create new transactions
            this.checkForNewTransactions(currentPercentage);
            
            // Calculate local average price
            this.calculateAveragePrice();
            
            // Verify with Binance only in live mode (every 10 ticks to avoid too many API calls)
            if (!this.testingMode && this.transactions.length > 0 && Math.random() < 0.1) {
                await this.verifyAveragePrice();
            }
            
            // Recalculate take profit based on (potentially corrected) average price
            this.calculateTakeProfitPrice();
            
            // Update profit calculation
            this.calculateProfit();
            
        } catch (error) {
            console.log(`Error in trader ${this.symbol} tick:`, error.message);
        }
    }

    // Check if we need to create new transactions based on current percentage
    checkForNewTransactions(currentPercentage) {
        // Calculate the next level we should execute
        const currentLevel = Math.floor(currentPercentage / this.percentageStep) * this.percentageStep;
        
        // Only create transactions for levels we haven't executed yet
        // and only if the current percentage is higher than our starting percentage
        if (currentPercentage >= this.startPercentage && 
            currentLevel > this.startPercentage && 
            !this.executedLevels.has(currentLevel)) {
            
            // Mark this level as executed
            this.executedLevels.add(currentLevel);
            
            // Create transaction for this level
            this.createTransaction(currentLevel);
            
            console.log(`${this.symbol}: New level ${currentLevel}% executed. Total levels: ${this.executedLevels.size}`);
        }
    }

    // Get detailed trading summary with real-time data
    getTradingSummary() {
        const currentData = this.getCurrentPrice();
        const currentPrice = currentData ? parseFloat(currentData.price) : 0;
        
        // Calculate real-time total profit from all transactions
        const realTimeTotalProfit = this.transactions.reduce((total, transaction) => {
            return total + transaction.getCurrentProfit();
        }, 0);

        // Get real-time transaction details
        const transactionDetails = this.transactions.map(transaction => 
            transaction.getRealTimeStatus()
        );

        // Get 24h percentage change from current data
        const current24hChange = currentData ? parseFloat(currentData.priceChangePercent) : 0;

        return {
            id: this.id,
            symbol: this.symbol,
            startPercentage: this.startPercentage,
            highestPercentage: this.highestPercentage,
            currentPrice: currentPrice,
            current24hChange: current24hChange,
            currentTransactions: this.transactions.length,
            executedLevels: Array.from(this.executedLevels).sort((a, b) => a - b),
            averagePrice: this.averagePrice,
            totalPosition: this.totalPosition,
            takeProfitPrice: this.takeProfitPrice,
            profit: this.profit,
            realTimeTotalProfit: realTimeTotalProfit,
            status: this.status,
            testingMode: this.testingMode,
            tradeDirection: this.tradeDirection,
            transactions: transactionDetails,
            profitPercentage: this.averagePrice > 0 ? 
                (this.tradeDirection === 'SHORT' ? 
                    ((this.averagePrice - currentPrice) / this.averagePrice) * 100 :
                    ((currentPrice - this.averagePrice) / this.averagePrice) * 100) : 0,
            takeProfitDistance: this.takeProfitPrice > 0 && currentPrice > 0 ? 
                (this.tradeDirection === 'SHORT' ? 
                    -Math.abs(((this.takeProfitPrice - currentPrice) / currentPrice) * 100) :
                    Math.abs(((this.takeProfitPrice - currentPrice) / currentPrice) * 100)) : 0
        };
    }

    // Cleanup when removing trader
    destroy() {
        this.status = 'DESTROYED';
        console.log(`Trader ${this.symbol} destroyed`);
    }
}

module.exports = { Trader };
