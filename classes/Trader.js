const { v4: uuidv4 } = require('uuid');

class Trader {
    constructor(controller, config) {
        // Link to controller
        this.controller = controller;
        this.id = uuidv4();
        
        // Store configuration data
        this.symbol = config.symbol;
        this.startPercentage = parseFloat(config.percentage) || 0;  // Starting 24h change percentage when trader was created
        this.startPrice = parseFloat(config.price) || 0;      // Starting price when trader was created (ensure it's a number)
        this.priceChange = parseFloat(config.priceChange) || 0;
        this.volume = parseFloat(config.volume) || 0;
        this.contractAge = parseInt(config.contractAge) || 0;
        
        // Trading configuration
        this.usdtAmount = config.usdtAmount || 5;  // USDT amount per order (not base asset)
        this.levelPercentage = this.controller.levelPercentage;  // Percentage gap between levels
        this.levelPercentages = this.controller.levelPercentages; // Array of percentages for custom gaps
        this.useArrayGaps = this.controller.useArrayGaps; // Whether to use array-based gaps
        this.maxLevels = this.controller.maxLevels;  // Maximum number of levels
        this.takeProfit = config.takeProfit || 10;  // Take profit percentage
        this.testingMode = config.testingMode !== undefined ? config.testingMode : true;
        this.tradeDirection = config.tradeDirection || 'SHORT';  // 'LONG' or 'SHORT'
        this.orderValidation = config.orderValidation; // Store validation results for precision
        
        // Trading state - Price-based levels
        this.transactions = [];              // All transactions for this trader
        this.executedLevels = new Set();     // Track which price levels have been executed
        this.priceLevels = [];              // Array of price levels to trade at
        this.currentLevelIndex = 0;         // Current level index
        this.averagePrice = 0;               // Average position price
        this.totalPosition = 0;              // Total position size
        this.takeProfitPrice = 0;            // Calculated take profit price
        this.pendingLimitOrders = new Map(); // Track pending LIMIT orders (priceLevel -> orderInfo)
        this.activeOrders = new Map();        // Track all active orders (orderId -> orderInfo)
        this.orderSyncInterval = null;        // Interval for order synchronization
        
        // Trading properties
        this.status = 'ACTIVE';
        this.createdAt = new Date();
        this.updatedAt = new Date();
        
        // Performance tracking
        this.profit = 0;
        this.totalTrades = 0;
        this.successfulTrades = 0;
        
        // Initialize price levels
        this.initializePriceLevels();
        
        // Initialize first level as executed
        this.executedLevels.add(this.priceLevels[0]);
        
        console.log(`Trader created for ${this.symbol} starting at $${this.startPrice} (${this.startPercentage}% 24h change) with $${this.usdtAmount} USDT per level (${this.tradeDirection} trader, ${this.testingMode ? 'TESTING' : 'LIVE'} mode)`);
        console.log(`Price levels: ${this.priceLevels.map(p => '$' + p.toFixed(4)).join(', ')}`);
        
        // Create initial transaction at starting price
        this.createTransaction(this.priceLevels[0]);
        
        // Start real-time order synchronization
        if (!this.testingMode) {
            this.startOrderMonitoring();
        }
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

    initializePriceLevels() {
        this.priceLevels = [];
        let currentPrice = parseFloat(this.startPrice) || 0;
        
        if (currentPrice <= 0) {
            console.log(`❌ Invalid start price for ${this.symbol}: ${this.startPrice}`);
            return;
        }

        // Validate array gaps if using them
        if (this.useArrayGaps) {
            if (!this.levelPercentages || this.levelPercentages.length === 0) {
                console.log(`❌ ${this.symbol}: useArrayGaps is true but levelPercentages array is empty, falling back to fixed percentage`);
                this.useArrayGaps = false;
            } else if (this.levelPercentages.length < this.maxLevels - 1) {
                console.log(`❌ ${this.symbol}: levelPercentages array too short (${this.levelPercentages.length}) for maxLevels (${this.maxLevels}), need ${this.maxLevels - 1} gaps`);
                return;
            }
        }
        
        // First level is always the starting price (market order)
        this.priceLevels.push(currentPrice);
        
        // Generate remaining price levels
        for (let i = 1; i < this.maxLevels; i++) {
            let multiplier;
            
            if (this.useArrayGaps) {
                // Use array-based gaps - get percentage for this gap (i-1 because first level has no gap)
                const gapPercentage = this.levelPercentages[i - 1];
                multiplier = this.tradeDirection === 'SHORT' 
                    ? (1 + gapPercentage / 100)  // SHORT: increase price by gap%
                    : (1 - gapPercentage / 100); // LONG: decrease price by gap%
            } else {
                // Use fixed percentage gap
                multiplier = this.tradeDirection === 'SHORT' 
                    ? (1 + this.levelPercentage / 100)  // 1.1 for SHORT (10% increase - sell at higher prices)
                    : (1 - this.levelPercentage / 100); // 0.9 for LONG (10% decrease - buy at lower prices)
            }
            
            currentPrice = currentPrice * multiplier;
            this.priceLevels.push(currentPrice);
        }
        
        const gapType = this.useArrayGaps ? `array gaps [${this.levelPercentages.slice(0, Math.min(5, this.levelPercentages.length)).join(', ')}${this.levelPercentages.length > 5 ? '...' : ''}]` : `fixed ${this.levelPercentage}%`;
        console.log(`Generated ${this.maxLevels} price levels for ${this.tradeDirection} trader using ${gapType}:`, 
            this.priceLevels.map(p => '$' + parseFloat(p).toFixed(4)));
    }

    // Create a new transaction
    createTransaction(priceLevel) {
        console.log(`🚨 TRADER DEBUG: createTransaction called for ${this.symbol} at price ${priceLevel}`);
        console.log(`🚨 TRADER DEBUG: testingMode: ${this.testingMode}, transactions.length: ${this.transactions.length}`);
        
        try {
            const { Transaction } = require('./Transaction');
            console.log(`🚨 TRADER DEBUG: Transaction class loaded successfully`);
            
            // Use the provided price level instead of current market price
            const transactionPrice = priceLevel;
            
            // Calculate base asset amount from USDT amount
            const baseAssetAmount = this.usdtAmount / transactionPrice;
            console.log(`💰 ${this.symbol}: Transaction calculation - usdtAmount: ${this.usdtAmount}, price: ${transactionPrice}, baseAssetAmount: ${baseAssetAmount}`);
            
            // Determine transaction side based on trade direction
            const transactionSide = this.tradeDirection === 'SHORT' ? 'SELL' : 'BUY';

            // Find the level index for this price
            const levelIndex = this.priceLevels.findIndex(p => Math.abs(p - priceLevel) < 0.0001);

            // Determine order type: MARKET for first entry, LIMIT for subsequent levels
            const isFirstTransaction = this.transactions.length === 0;
            const orderType = isFirstTransaction ? 'MARKET' : 'LIMIT';
            
            const transaction = new Transaction(this, {
                symbol: this.symbol,
                amount: baseAssetAmount,  // Base asset amount calculated from USDT
                usdtAmount: this.usdtAmount,  // Store original USDT amount
                price: transactionPrice,
                priceLevel: priceLevel,   // Store the price level instead of percentage
                levelIndex: levelIndex,   // Store the level index
                startPrice: this.startPrice, // Add starting price for percentage calculation
                side: transactionSide,  // BUY for LONG, SELL for SHORT
                orderType: orderType,    // MARKET for immediate entry, LIMIT for price levels
                orderValidation: this.orderValidation, // Pass validation results for precision
                testingMode: this.testingMode
            });

            this.transactions.push(transaction);
            this.totalTrades++;
            
            // Update position tracking
            this.calculateAveragePrice();
            this.calculateTakeProfitPrice();
            
            // If this is the first transaction (MARKET order), pre-place LIMIT orders for all other levels
            if (isFirstTransaction && !this.testingMode) {
                this.placeLimitOrdersForRemainingLevels();
            }
            
            console.log(`${this.symbol}: Created transaction at level ${levelIndex} (Price: $${priceLevel.toFixed(4)})`);
            return transaction;
            
        } catch (error) {
            console.log(`Error creating transaction for ${this.symbol}:`, error.message);
            return null;
        }
    }

    // Pre-place LIMIT orders for all remaining price levels (called after first MARKET order)
    async placeLimitOrdersForRemainingLevels() {
        if (this.testingMode) return; // Skip in testing mode
        
        try {
            console.log(`${this.symbol}: Pre-placing LIMIT orders for remaining ${this.priceLevels.length - 1} levels...`);
            
            // Get precision requirements for this symbol
            let requirements = this.orderValidation?.requirements;
            if (!requirements) {
                // Fallback: get requirements from API if not available
                const apiService = this.getApiService();
                requirements = await apiService.getMinimumOrderRequirements(this.symbol);
                if (!requirements) {
                    console.log(`${this.symbol}: Unable to get precision requirements for LIMIT orders`);
                    return;
                }
            }
            
            // Create pending limit orders for all price levels except the first one (already executed)
            for (let i = 1; i < this.priceLevels.length; i++) {
                const priceLevel = this.priceLevels[i];
                
                // Calculate base asset amount for this level
                const baseAssetAmount = this.usdtAmount / priceLevel;
                const transactionSide = this.tradeDirection === 'SHORT' ? 'SELL' : 'BUY';
                
                try {
                    const apiService = this.getApiService();
                    
                    // Use API service's proper step size rounding method (same as in validateMinimumOrderSize)
                    let roundedQuantity = apiService.roundToStepSize(baseAssetAmount, requirements.stepSize, requirements.quantityPrecision);
                    let roundedPrice = apiService.roundToStepSize(priceLevel, requirements.tickSize, requirements.pricePrecision);
                    
                    // Validate and adjust order size to meet Binance minimum requirements
                    // For limit orders, validate with the actual level amount, not the full usdtAmount
                    const levelUsdtAmount = this.usdtAmount; // Each level uses the same USDT amount
                    const validation = await apiService.validateMinimumOrderSize(this.symbol, levelUsdtAmount, roundedPrice, requirements);
                    if (!validation || !validation.valid) {
                        console.log(`${this.symbol}: Level ${i} validation failed, but proceeding with minimum adjustment...`);
                        
                        // Instead of skipping, calculate exact minimum quantity needed
                        const minNotional = 5.10; // Target $5.10 to ensure we're above $5 after rounding
                        let requiredQuantity = minNotional / roundedPrice;
                        
                        // Round up to ensure we meet minimum even after rounding
                        roundedQuantity = apiService.roundToStepSize(requiredQuantity, requirements.stepSize, requirements.quantityPrecision);
                        
                        // Check if the rounded result still meets minimum, if not, add one step
                        let finalNotional = roundedQuantity * roundedPrice;
                        let attempts = 0;
                        while (finalNotional < 5.05 && attempts < 10) {
                            roundedQuantity += parseFloat(requirements.stepSize);
                            roundedQuantity = apiService.roundToStepSize(roundedQuantity, requirements.stepSize, requirements.quantityPrecision);
                            finalNotional = roundedQuantity * roundedPrice;
                            attempts++;
                        }
                        
                        // If we still can't meet minimum after 10 attempts, skip this level
                        if (finalNotional < 5.05) {
                            console.log(`${this.symbol}: Level ${i} skipped - Cannot meet minimum even after multiple adjustments: $${finalNotional.toFixed(2)}`);
                            continue;
                        }
                        
                        console.log(`${this.symbol}: Level ${i} forced to minimum - ${roundedQuantity} tokens = $${finalNotional.toFixed(2)}`);
                    } else {
                        // Use validated/adjusted values from the validation
                        roundedQuantity = validation.baseAssetAmount;
                        roundedPrice = validation.price;
                        
                        console.log(`${this.symbol}: Level ${i} validated - Notional: $${validation.notionalValue.toFixed(2)} USDT`);
                        if (validation.adjustedForMinimum) {
                            console.log(`${this.symbol}: Level ${i} quantity adjusted to meet minimum notional requirement`);
                        }
                    }
                    
                    console.log(`📏 ${this.symbol}: Level ${i} precision - Quantity: ${baseAssetAmount} → ${roundedQuantity} (stepSize: ${requirements.stepSize}), Price: ${priceLevel} → ${roundedPrice} (tickSize: ${requirements.tickSize})`);
                    
                    const limitOrder = await apiService.order({
                        symbol: this.symbol,
                        side: transactionSide,
                        type: 'LIMIT',
                        quantity: roundedQuantity.toString(),
                        price: roundedPrice.toString(),
                        timeInForce: 'GTC'  // Good Till Cancelled
                    });
                    
                    if (limitOrder && limitOrder.orderId) {
                        // Store the pending order info for tracking
                        if (!this.pendingLimitOrders) {
                            this.pendingLimitOrders = new Map();
                        }
                        const orderInfo = {
                            orderId: limitOrder.orderId,
                            levelIndex: i,
                            price: priceLevel,
                            priceLevel: priceLevel,
                            amount: baseAssetAmount,
                            side: transactionSide,
                            orderType: 'LIMIT',
                            usdtAmount: this.usdtAmount
                        };
                        
                        this.pendingLimitOrders.set(priceLevel, orderInfo);
                        
                        // Track in real-time monitoring system
                        this.trackOrder(limitOrder.orderId, orderInfo);
                        
                        console.log(`${this.symbol}: Placed LIMIT order ${limitOrder.orderId} at $${priceLevel.toFixed(4)} (Level ${i})`);
                    }
                } catch (orderError) {
                    console.log(`${this.symbol}: Failed to place LIMIT order at level ${i} ($${priceLevel.toFixed(4)}):`, orderError.message);
                }
            }
            
            console.log(`${this.symbol}: Finished placing LIMIT orders. Total pending: ${this.pendingLimitOrders?.size || 0}`);
        } catch (error) {
            console.log(`${this.symbol}: Error placing LIMIT orders:`, error.message);
        }
    }

    // Calculate average price of all open positions (local calculation)
    calculateAveragePrice() {
        // Only count FILLED transactions, not PENDING or CREATED ones
        const openTransactions = this.transactions.filter(t => t.status === 'FILLED');
        
        console.log(`📊 ${this.symbol}: Calculating average price - Total transactions: ${this.transactions.length}, FILLED transactions: ${openTransactions.length}`);
        
        // Debug: Show all transaction statuses
        if (this.transactions.length > 0) {
            console.log(`📊 ${this.symbol}: Transaction statuses:`);
            this.transactions.forEach((t, index) => {
              console.log(`  ${index + 1}. ${t.symbol} ${t.side} ${t.amount} - Status: ${t.status}, ExecutedAmount: ${t.executedAmount}, Price: ${t.executedPrice}`);
            });
        }
        
        if (openTransactions.length === 0) {
            this.averagePrice = 0;
            this.totalPosition = 0;
            console.log(`⚠️ ${this.symbol}: No FILLED transactions found - averagePrice set to 0`);
            return;
        }

        let totalValue = 0;
        let totalAmount = 0;

        openTransactions.forEach((transaction, index) => {
            const value = transaction.executedPrice * transaction.executedAmount;
            totalValue += value;
            totalAmount += transaction.executedAmount;
            console.log(`  ${index + 1}. ${transaction.symbol}: ${transaction.executedAmount} × $${transaction.executedPrice} = $${value.toFixed(2)}`);
        });

        this.averagePrice = totalValue / totalAmount;
        this.totalPosition = totalAmount;
        
        console.log(`✅ ${this.symbol}: Average price calculated - $${this.averagePrice.toFixed(6)} (Position: ${this.totalPosition})`);
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
            await this.destroy();
            return true;
        }
        
        return false;
    }

    // Close all open positions
    async closeAllPositions() {
        try {
            console.log(`${this.symbol}: Closing all positions for take profit`);
            
            // Step 1: Cancel all pending LIMIT orders on Binance
            console.log(`${this.symbol}: Step 1 - Cancelling all pending orders...`);
            try {
                await this.cancelAllOrders();
            } catch (cancelError) {
                console.error(`${this.symbol}: Error cancelling orders:`, cancelError.message);
                // Continue even if cancel fails
            }
            
            // Step 2: Close the entire position on Binance with a single MARKET order
            console.log(`${this.symbol}: Step 2 - Closing position on Binance...`);
            let binanceClosedSuccess = false;
            try {
                binanceClosedSuccess = await this.closePositionOnBinance();
            } catch (closeError) {
                console.error(`${this.symbol}: Error closing position:`, closeError.message);
                // Continue to mark local transactions as closed
            }
            
            if (binanceClosedSuccess || this.testingMode) {
                // Step 3: Mark all local transactions as CLOSED
                console.log(`${this.symbol}: Step 3 - Marking local transactions as CLOSED...`);
                const openTransactions = this.transactions.filter(t => t.status === 'FILLED' || t.status === 'OPEN');
                
                openTransactions.forEach(transaction => {
                    transaction.status = 'CLOSED';
                    transaction.closedAt = new Date();
                    console.log(`${this.symbol}: Transaction ${transaction.id} marked as CLOSED`);
                });
                
                this.successfulTrades += openTransactions.length;
            } else {
                console.log(`⚠️ ${this.symbol}: Failed to close position on Binance - keeping local transactions as FILLED`);
            }

            // Calculate final profit
            this.calculateProfit();
            console.log(`${this.symbol}: Final profit: ${this.profit.toFixed(2)}`);
        } catch (error) {
            console.error(`${this.symbol}: Error in closeAllPositions:`, error);
            throw error;
        }
    }

    // Cancel all active orders on Binance
    async cancelAllOrders() {
        if (this.testingMode) {
            console.log(`${this.symbol}: Testing mode - skipping order cancellation`);
            return;
        }

        if (this.activeOrders.size === 0) {
            console.log(`${this.symbol}: No active orders to cancel`);
            return;
        }

        try {
            const apiService = this.getApiService();
            const orderIds = Array.from(this.activeOrders.keys());
            
            console.log(`${this.symbol}: Attempting to cancel ${orderIds.length} active orders on Binance...`);
            console.log(`${this.symbol}: Order IDs:`, orderIds);
            
            if (orderIds.length > 0) {
                try {
                    // Try batch cancel first
                    const result = await apiService.cancelOrders({
                        symbol: this.symbol,
                        orderIds: orderIds
                    });
                    
                    console.log(`✅ ${this.symbol}: Successfully cancelled ${orderIds.length} orders in batch`);
                } catch (batchError) {
                    console.log(`⚠️ ${this.symbol}: Batch cancel failed (${batchError.message}), trying individual cancellations...`);
                    
                    // If batch fails, try cancelling orders individually
                    let successCount = 0;
                    let failCount = 0;
                    
                    for (const orderId of orderIds) {
                        try {
                            await apiService.cancelOrder({
                                symbol: this.symbol,
                                orderId: orderId
                            });
                            successCount++;
                            console.log(`✅ ${this.symbol}: Cancelled order ${orderId}`);
                        } catch (individualError) {
                            failCount++;
                            // Order might already be filled or cancelled
                            console.log(`⚠️ ${this.symbol}: Failed to cancel order ${orderId}: ${individualError.message}`);
                        }
                    }
                    
                    console.log(`${this.symbol}: Individual cancellation results - Success: ${successCount}, Failed: ${failCount}`);
                }
                
                // Clear tracking maps
                this.activeOrders.clear();
                this.pendingLimitOrders.clear();
            }
        } catch (error) {
            console.error(`❌ ${this.symbol}: Error in cancelAllOrders:`, error.message);
            // Don't throw - we want to continue with closing positions even if cancel fails
        }
    }

    // Close the entire position on Binance with a single MARKET order
    async closePositionOnBinance() {
        if (this.testingMode || this.totalPosition === 0) {
            console.log(`${this.symbol}: No position to close on Binance (Testing: ${this.testingMode}, Position: ${this.totalPosition})`);
            return true;
        }

        try {
            const apiService = this.getApiService();
            
            // Determine the closing side (opposite of our position)
            // SHORT position needs BUY to close, LONG position needs SELL to close
            const closingSide = this.tradeDirection === 'SHORT' ? 'BUY' : 'SELL';
            
            // Get precision requirements
            let requirements = this.orderValidation?.requirements;
            if (!requirements) {
                requirements = await apiService.getMinimumOrderRequirements(this.symbol);
            }

            // Round position size to proper precision
            const roundedQuantity = apiService.roundToStepSize(
                this.totalPosition, 
                requirements.stepSize, 
                requirements.quantityPrecision
            );

            console.log(`${this.symbol}: Closing ${this.tradeDirection} position on Binance - ${closingSide} ${roundedQuantity} at MARKET price...`);
            
            const closeOrder = await apiService.order({
                symbol: this.symbol,
                side: closingSide,
                type: 'MARKET',
                quantity: roundedQuantity.toString()
            });

            if (closeOrder && closeOrder.orderId) {
                console.log(`✅ ${this.symbol}: Position closed on Binance - Order ID: ${closeOrder.orderId}`);
                return true;
            } else {
                console.log(`❌ ${this.symbol}: Failed to close position on Binance - no order ID returned`);
                return false;
            }
        } catch (error) {
            console.log(`❌ ${this.symbol}: Error closing position on Binance:`, error.message);
            return false;
        }
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

            const currentPrice = parseFloat(currentData.price);
            const currentPercentage = parseFloat(currentData.priceChangePercent);
            
            // Update highest percentage reached (still track for display purposes)
            if (currentPercentage > this.highestPercentage) {
                this.highestPercentage = currentPercentage;
            }

            // Check if we need to create new transactions based on price levels
            this.checkForNewTransactions(currentPrice);
            
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

    // Check if we need to create new transactions based on current price
    checkForNewTransactions(currentPrice) {
        if (!currentPrice || this.priceLevels.length === 0) return;
        
        if (this.testingMode) {
            // Testing mode: Use the old logic to simulate fills
            this.checkForNewTransactionsTestMode(currentPrice);
        } else {
            // Live mode: Check for filled LIMIT orders
            this.checkFilledLimitOrders();
        }
    }

    // Testing mode: Simulate transaction execution when price levels are reached
    checkForNewTransactionsTestMode(currentPrice) {
        // Check each price level to see if we should execute it
        for (let i = this.currentLevelIndex + 1; i < this.priceLevels.length; i++) {
            const targetPrice = this.priceLevels[i];
            let shouldExecute = false;
            
            if (this.tradeDirection === 'SHORT') {
                // For SHORT traders, execute when price goes UP to reach higher selling levels
                shouldExecute = currentPrice >= targetPrice;
            } else {
                // For LONG traders, execute when price goes DOWN to reach lower buying levels  
                shouldExecute = currentPrice <= targetPrice;
            }
            
            if (shouldExecute && !this.executedLevels.has(targetPrice)) {
                // Mark this level as executed
                this.executedLevels.add(targetPrice);
                this.currentLevelIndex = i;
                
                // Create transaction for this price level
                this.createTransaction(targetPrice);
                
                console.log(`${this.symbol}: New level ${i} executed at $${targetPrice.toFixed(4)} (current: $${currentPrice.toFixed(4)}). Total levels: ${this.executedLevels.size}`);
                
                // Only execute one level at a time
                break;
            }
        }
    }

    // Start continuous order monitoring for real-time synchronization
    startOrderMonitoring() {
        if (this.testingMode) return;
        
        // Check orders every 2 seconds for real-time sync
        this.orderSyncInterval = setInterval(() => {
            this.syncAllOrders();
        }, 2000);
        
        console.log(`${this.symbol}: Started real-time order monitoring (2s intervals)`);
    }
    
    // Stop order monitoring (cleanup)
    stopOrderMonitoring() {
        if (this.orderSyncInterval) {
            clearInterval(this.orderSyncInterval);
            this.orderSyncInterval = null;
            console.log(`${this.symbol}: Stopped order monitoring`);
        }
    }
    
    // Track a new order in our monitoring system
    trackOrder(orderId, orderInfo) {
        this.activeOrders.set(orderId, {
            ...orderInfo,
            lastChecked: new Date(),
            lastStatus: 'NEW'
        });
        console.log(`${this.symbol}: Now tracking order ${orderId}`);
    }
    
    // Comprehensive order synchronization - checks all active orders
    async syncAllOrders() {
        if (this.testingMode || this.activeOrders.size === 0) return;
        
        try {
            const apiService = this.getApiService();
            const orderPromises = [];
            
            // Check all active orders concurrently for efficiency
            for (const [orderId, orderInfo] of this.activeOrders) {
                orderPromises.push(this.checkSingleOrder(apiService, orderId, orderInfo));
            }
            
            await Promise.all(orderPromises);
        } catch (error) {
            console.log(`${this.symbol}: Error in order sync:`, error.message);
        }
    }
    
    // Check individual order status and sync with our system
    async checkSingleOrder(apiService, orderId, orderInfo) {
        try {
            const orderStatus = await apiService.getOrderByOrderId(this.symbol, orderId);
            
            if (!orderStatus) return;
            
            const currentStatus = orderStatus.status;
            const lastStatus = orderInfo.lastStatus;
            
            // Update tracking info
            orderInfo.lastChecked = new Date();
            orderInfo.lastStatus = currentStatus;
            
            // Handle status changes
            if (currentStatus !== lastStatus) {
                console.log(`${this.symbol}: Order ${orderId} status changed: ${lastStatus} → ${currentStatus}`);
                
                switch (currentStatus) {
                    case 'FILLED':
                        await this.handleOrderFilled(orderId, orderStatus, orderInfo);
                        break;
                    case 'PARTIALLY_FILLED':
                        await this.handleOrderPartiallyFilled(orderId, orderStatus, orderInfo);
                        break;
                    case 'CANCELED':
                    case 'REJECTED':
                    case 'EXPIRED':
                        await this.handleOrderCancelled(orderId, orderStatus, orderInfo);
                        break;
                }
            }
        } catch (error) {
            console.log(`${this.symbol}: Error checking order ${orderId}:`, error.message);
        }
    }
    
    // Handle filled orders - create transaction records
    async handleOrderFilled(orderId, orderStatus, orderInfo) {
        try {
            // Check if we already have a transaction for this orderId
            const existingTransaction = this.transactions.find(t => t.orderId === orderId);
            if (existingTransaction) {
                console.log(`⚠️ ${this.symbol}: Transaction for order ${orderId} already exists, updating instead of creating duplicate`);
                
                // Update existing transaction instead of creating duplicate
                if (existingTransaction.status !== 'FILLED') {
                    existingTransaction.status = 'FILLED';
                    existingTransaction.executedPrice = parseFloat(orderStatus.price || orderStatus.avgPrice);
                    existingTransaction.executedAmount = parseFloat(orderStatus.executedQty);
                    existingTransaction.filledAt = new Date(orderStatus.updateTime);
                    
                    console.log(`✅ ${this.symbol}: Updated existing transaction ${orderId} - ${existingTransaction.side} ${existingTransaction.executedAmount} at $${existingTransaction.executedPrice}`);
                    
                    // Update position tracking
                    this.calculateAveragePrice();
                    this.calculateTakeProfitPrice();
                }
                return;
            }

            const { Transaction } = require('./Transaction');
            
            // Create transaction record for filled order
            const transaction = new Transaction(this, {
                symbol: this.symbol,
                amount: parseFloat(orderStatus.executedQty),
                usdtAmount: orderInfo.usdtAmount || this.usdtAmount,
                price: parseFloat(orderStatus.price),
                priceLevel: orderInfo.priceLevel,
                levelIndex: orderInfo.levelIndex,
                startPrice: this.startPrice, // Add starting price for percentage calculation
                side: orderInfo.side,
                orderType: orderStatus.type,
                testingMode: false,
                skipExecution: true  // Skip auto-execution since this order is already filled
            });
            
            // Set as already filled (since Binance executed it)
            transaction.status = 'FILLED';
            transaction.executedPrice = parseFloat(orderStatus.price);
            transaction.executedAmount = parseFloat(orderStatus.executedQty);
            transaction.orderId = orderId;
            transaction.filledAt = new Date(orderStatus.updateTime);
            
            console.log(`📝 ${this.symbol}: Created transaction record for filled order - executedAmount: ${transaction.executedAmount}, status: ${transaction.status}`);
            
            // Add to our transaction list
            this.transactions.push(transaction);
            
            // Update level tracking
            if (orderInfo.priceLevel) {
                this.executedLevels.add(orderInfo.priceLevel);
                if (orderInfo.levelIndex !== undefined) {
                    this.currentLevelIndex = Math.max(this.currentLevelIndex, orderInfo.levelIndex);
                }
            }
            
            // Remove from tracking (order completed)
            this.activeOrders.delete(orderId);
            if (orderInfo.priceLevel && this.pendingLimitOrders.has(orderInfo.priceLevel)) {
                this.pendingLimitOrders.delete(orderInfo.priceLevel);
            }
            
            // Update position tracking
            this.calculateAveragePrice();
            this.calculateTakeProfitPrice();
            
            console.log(`${this.symbol}: ✅ Order ${orderId} FILLED - ${orderInfo.side} ${transaction.executedAmount} at $${transaction.executedPrice} (Level ${orderInfo.levelIndex})`);
            
        } catch (error) {
            console.log(`${this.symbol}: Error handling filled order ${orderId}:`, error.message);
        }
    }
    
    // Handle partially filled orders
    async handleOrderPartiallyFilled(orderId, orderStatus, orderInfo) {
        console.log(`${this.symbol}: Order ${orderId} partially filled: ${orderStatus.executedQty}/${orderStatus.origQty}`);
        // Keep monitoring - don't remove from active orders yet
    }
    
    // Handle cancelled/rejected orders
    async handleOrderCancelled(orderId, orderStatus, orderInfo) {
        console.log(`${this.symbol}: Order ${orderId} ${orderStatus.status}: ${orderStatus.status}`);
        
        // Remove from tracking
        this.activeOrders.delete(orderId);
        if (orderInfo.priceLevel && this.pendingLimitOrders.has(orderInfo.priceLevel)) {
            this.pendingLimitOrders.delete(orderInfo.priceLevel);
        }
        
        // For cancelled LIMIT orders, could optionally re-place them
        if (orderStatus.status === 'CANCELED' && orderInfo.orderType === 'LIMIT') {
            console.log(`${this.symbol}: LIMIT order cancelled, could re-place at level ${orderInfo.levelIndex}`);
        }
    }
    
    // Legacy method for backward compatibility
    async checkFilledLimitOrders() {
        // This is now handled by the continuous syncAllOrders system
        // Keep for compatibility but delegate to new system
        if (!this.testingMode && this.activeOrders.size > 0) {
            await this.syncAllOrders();
        }
    }

    // Cleanup trader resources (call when stopping trader)
    cleanup() {
        this.stopOrderMonitoring();
        this.status = 'STOPPED';
        console.log(`${this.symbol}: Trader cleanup completed`);
    }

    // Get order synchronization status
    getOrderSyncStatus() {
        return {
            activeOrdersCount: this.activeOrders.size,
            pendingLimitOrdersCount: this.pendingLimitOrders.size,
            monitoringActive: this.orderSyncInterval !== null,
            activeOrders: Array.from(this.activeOrders.entries()).map(([orderId, info]) => ({
                orderId,
                side: info.side,
                type: info.orderType,
                price: info.price,
                amount: info.amount,
                lastStatus: info.lastStatus,
                lastChecked: info.lastChecked
            })),
            pendingLimitOrders: Array.from(this.pendingLimitOrders.entries()).map(([priceLevel, info]) => ({
                orderId: info.orderId,
                priceLevel,
                levelIndex: info.levelIndex,
                side: info.side
            }))
        };
    }

    // Fix obvious transaction issues (synchronous)
    fixObviousTransactionIssues() {
        console.log(`🔧 ${this.symbol}: FIXING obvious transaction issues`);
        
        let fixed = false;
        
        // Remove duplicate transactions (same orderId)
        const orderIds = new Set();
        const uniqueTransactions = [];
        
        this.transactions.forEach((transaction, index) => {
            if (transaction.orderId) {
                if (orderIds.has(transaction.orderId)) {
                    console.log(`🔧 ${this.symbol}: Removing duplicate transaction ${index + 1} with orderId: ${transaction.orderId}`);
                    fixed = true;
                    return; // Skip this duplicate
                }
                orderIds.add(transaction.orderId);
            }
            uniqueTransactions.push(transaction);
        });
        
        if (uniqueTransactions.length !== this.transactions.length) {
            this.transactions = uniqueTransactions;
            console.log(`🔧 ${this.symbol}: Removed ${this.transactions.length - uniqueTransactions.length} duplicate transactions`);
            fixed = true;
        }
        
        this.transactions.forEach((transaction, index) => {
            // Fix FILLED transactions with 0 executedPrice
            if (transaction.status === 'FILLED' && transaction.executedPrice === 0 && transaction.price > 0) {
                console.log(`🔧 ${this.symbol}: Fixing FILLED transaction ${index + 1} - setting executedPrice from ${transaction.executedPrice} to ${transaction.price}`);
                transaction.executedPrice = transaction.price;
                fixed = true;
            }
            
            // Fix FILLED transactions with 0 executedAmount  
            if (transaction.status === 'FILLED' && transaction.executedAmount === 0 && transaction.amount > 0) {
                console.log(`🔧 ${this.symbol}: Fixing FILLED transaction ${index + 1} - setting executedAmount from ${transaction.executedAmount} to ${transaction.amount}`);
                transaction.executedAmount = transaction.amount;
                fixed = true;
            }
            
            // Convert FAILED transactions back to FILLED if they have valid data
            if (transaction.status === 'FAILED' && transaction.orderId && transaction.amount > 0) {
                console.log(`🔧 ${this.symbol}: Converting FAILED transaction ${index + 1} back to FILLED`);
                transaction.status = 'FILLED';
                transaction.executedPrice = transaction.executedPrice > 0 ? transaction.executedPrice : transaction.price;
                transaction.executedAmount = transaction.executedAmount > 0 ? transaction.executedAmount : transaction.amount;
                fixed = true;
            }
        });
        
        if (fixed) {
            console.log(`✅ ${this.symbol}: Fixed transaction issues, recalculating average price`);
            this.calculateAveragePrice();
        }
    }

    // Force sync transaction statuses with Binance (emergency fix)
    async forceSyncTransactions() {
        console.log(`🚨 ${this.symbol}: FORCE SYNC - Checking transaction statuses`);
        
        for (const transaction of this.transactions) {
            if (transaction.orderId && (transaction.status === 'PENDING' || transaction.status === 'FAILED' || (transaction.status === 'FILLED' && transaction.executedPrice === 0))) {
                try {
                    const apiService = this.getApiService();
                    const orderStatus = await apiService.getOrderByOrderId(this.symbol, transaction.orderId);
                    
                    if (orderStatus) {
                        console.log(`🔍 ${this.symbol}: Order ${transaction.orderId} status:`, orderStatus.status, `executedQty: ${orderStatus.executedQty}`);
                        
                        if (orderStatus.status === 'FILLED' && parseFloat(orderStatus.executedQty) > 0) {
                            // Update the transaction directly
                            transaction.status = 'FILLED';
                            transaction.executedPrice = parseFloat(orderStatus.price || orderStatus.avgPrice || transaction.price);
                            transaction.executedAmount = parseFloat(orderStatus.executedQty);
                            transaction.filledAt = new Date(orderStatus.updateTime);
                            
                            console.log(`✅ ${this.symbol}: FIXED transaction ${transaction.orderId} - price: ${transaction.executedPrice}, amount: ${transaction.executedAmount}`);
                        }
                    }
                } catch (error) {
                    console.log(`❌ ${this.symbol}: Error syncing transaction ${transaction.orderId}:`, error.message);
                }
            }
        }
        
        // Recalculate after sync
        this.calculateAveragePrice();
    }

    // Get detailed trading summary with real-time data
    getTradingSummary() {
        // Debug: Show current transaction states
        console.log(`🔍 ${this.symbol}: getTradingSummary - Transaction states:`);
        this.transactions.forEach((t, i) => {
            console.log(`  ${i + 1}. Status: ${t.status}, ExecutedAmount: ${t.executedAmount}, ExecutedPrice: ${t.executedPrice}, OrderId: ${t.orderId}`);
        });
        console.log(`🔍 ${this.symbol}: averagePrice: ${this.averagePrice}, totalPosition: ${this.totalPosition}`);

        const currentData = this.getCurrentPrice();
        const currentPrice = currentData ? parseFloat(currentData.price) : 0;
        
        // Force recalculate average price to ensure it's up to date
        this.calculateAveragePrice();
        
        // Force sync transaction statuses if needed
        this.fixObviousTransactionIssues();
        
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
            startPrice: this.startPrice,
            highestPercentage: this.highestPercentage,
            currentPrice: currentPrice,
            current24hChange: current24hChange,
            currentTransactions: this.transactions.length,
            priceLevels: this.priceLevels,
            executedLevels: Array.from(this.executedLevels).sort((a, b) => a - b).map(level => `$${level.toFixed(4)}`),
            currentLevelIndex: this.currentLevelIndex,
            averagePrice: this.averagePrice,
            totalPosition: this.totalPosition, // This should be the quantity, not dollar amount
            positionValue: this.totalPosition * this.averagePrice, // Add position value in dollars
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
    async destroy() {
        try {
            console.log(`${this.symbol}: Destroying trader...`);
            
            // Stop order monitoring
            try {
                this.stopOrderMonitoring();
            } catch (stopError) {
                console.error(`${this.symbol}: Error stopping order monitoring:`, stopError.message);
            }
            
            // Cancel any remaining orders (safety check)
            try {
                await this.cancelAllOrders();
            } catch (cancelError) {
                console.error(`${this.symbol}: Error in final cancelAllOrders:`, cancelError.message);
            }
            
            // Mark trader as destroyed
            this.status = 'DESTROYED';
            
            console.log(`✅ ${this.symbol}: Trader destroyed successfully`);
        } catch (error) {
            console.error(`${this.symbol}: Error in destroy:`, error);
            // Still mark as destroyed even if there are errors
            this.status = 'DESTROYED';
            throw error;
        }
    }
}

module.exports = { Trader };
