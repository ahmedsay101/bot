const { Service } = require('./API');
const { Trader } = require('./Trader');
const WebSocket = require('ws');

class Controller {
    constructor(maxTraders = 1, testingMode = false) {
        this.service = new Service("futures");
        this.traders = [];
        this.maxTraders = maxTraders;
        this.maxLevels = 10; // Maximum number of price levels per trader
        this.levelPercentage = 20; // Percentage gap between levels (10% = 1.1x for LONG, 0.9x for SHORT)
        this.minContractPrice = 0.01;
        this.minContractDays = 5;
        this.minPercentage = 30; // Minimum percentage change required for trader creation        this.skipValidationFilters = false; // Skip momentum and order size validation when true        this.testingMode = testingMode;
        this.tickerData = new Map();
        this.hasLoggedTickerData = false;
        this.testingMode = testingMode;
        this.skipValidationFilters = true; // Skip momentum and order size validation when true
        // Pass controller reference to service for WebSocket data access
        this.service.controller = this;
        
        console.log(`Controller initialized in ${this.testingMode ? 'TESTING' : 'LIVE'} mode`);
        console.log(`Using Binance FUTURES market for data`);
        
        this.connectWebSocket();
        this.startPeriodicUpdates();
    }

    connectWebSocket() {
        try {
            // Connect to Binance Futures WebSocket for all tickers stream
            this.ws = new WebSocket('wss://fstream.binance.com/ws/!ticker@arr');
            
            this.ws.on('open', () => {
                console.log('WebSocket connected for live ticker updates');
            });

            this.ws.on('message', (data) => {
                try {
                    const tickers = JSON.parse(data);
                    // Update ticker data in memory
                    tickers.forEach(ticker => {
                        this.tickerData.set(ticker.s, {
                            symbol: ticker.s,
                            price: ticker.c,
                            priceChange: ticker.p,
                            priceChangePercent: ticker.P,
                            volume: ticker.v,
                            quoteVolume: ticker.q
                        });
                    });
                    
                    // Log first time we get data
                    if (this.tickerData.size > 0 && !this.hasLoggedTickerData) {
                        console.log(`📊 Ticker WebSocket data loaded: ${this.tickerData.size} symbols`);
                        this.hasLoggedTickerData = true;
                    }
                    this.processTickerUpdates();
                } catch (error) {
                    console.log('WebSocket message parse error:', error.message);
                }
            });

            this.ws.on('close', () => {
                console.log('WebSocket disconnected, attempting to reconnect...');
                setTimeout(() => this.connectWebSocket(), 5000);
            });

            this.ws.on('error', (error) => {
                console.log('WebSocket error:', error.message);
            });
        } catch (error) {
            console.log('WebSocket connection error:', error.message);
        }
    }

    processTickerUpdates() {
        if (this.tickerData.size === 0) return;

        const tickers = Array.from(this.tickerData.values());
        
        const topGainers = tickers
            .filter(ticker => parseFloat(ticker.priceChangePercent) > 0)
            .sort((a, b) => parseFloat(b.priceChangePercent) - parseFloat(a.priceChangePercent))
            .slice(0, 5);

        const topLosers = tickers
            .filter(ticker => parseFloat(ticker.priceChangePercent) < 0)
            .sort((a, b) => parseFloat(a.priceChangePercent) - parseFloat(b.priceChangePercent))
            .slice(0, 5);

        // Update all traders with real-time data
        this.updateAllTraders();

        // Check for new trader opportunities (throttled to avoid spam)
        if (this.traders.length < this.maxTraders && Math.random() < 0.005) { // 0.5% chance to check for new traders
            console.log('🔍 Checking for new trader opportunities from WebSocket data...');
            this.checkWebSocketOpportunities();
        }

        // Only log if we have significant changes (throttle output)
        if (Math.random() < 0.01) { // Log ~1% of updates to avoid spam
            console.log('=== LIVE TOP GAINERS ===');
            topGainers.forEach((gainer, index) => {
                console.log(`${index + 1}. ${gainer.symbol}: ${gainer.priceChangePercent}% (${gainer.price})`);
            });

            console.log('\n=== LIVE TOP LOSERS ===');
            topLosers.forEach((loser, index) => {
                console.log(`${index + 1}. ${loser.symbol}: ${loser.priceChangePercent}% (${loser.price})`);
            });
            console.log('========================\n');
        }
    }

    updateAllTraders() {
        // Call tick() on all active traders
        this.traders.forEach(trader => {
            if (trader && trader.status === 'ACTIVE') {
                trader.tick();
            }
        });
    }

    async checkWebSocketOpportunities() {
        try {
            if (this.tickerData.size === 0) return;
            
            const tickers = Array.from(this.tickerData.values());
            
            // Log analysis of top performers to understand rejection reasons
            const topPerformers = tickers
                .filter(ticker => Math.abs(parseFloat(ticker.priceChangePercent)) >= 20) // 20% minimum for analysis
                .sort((a, b) => Math.abs(parseFloat(b.priceChangePercent)) - Math.abs(parseFloat(a.priceChangePercent)))
                .slice(0, 10);
            
            console.log(`🔍 Analyzing top ${topPerformers.length} performers (>20% change):`);
            topPerformers.forEach((ticker, index) => {
                const percentage = parseFloat(ticker.priceChangePercent);
                const price = parseFloat(ticker.price);
                const existingTrader = this.traders.find(t => t.symbol === ticker.symbol);
                
                let rejectionReason = '';
                if (Math.abs(percentage) < this.minPercentage) {
                    rejectionReason = `Below ${this.minPercentage}% threshold`;
                } else if (price < this.minContractPrice) {
                    rejectionReason = `Price $${price} below min $${this.minContractPrice}`;
                } else if (existingTrader) {
                    rejectionReason = 'Already trading this symbol';
                } else {
                    rejectionReason = '✅ Passed initial filters';
                }
                
                console.log(`  ${index + 1}. ${ticker.symbol}: ${percentage.toFixed(2)}% ($${price}) - ${rejectionReason}`);
            });
            
            // Filter for potential trading opportunities directly from WebSocket data
            const candidates = tickers
                .filter(ticker => {
                    const percentage = parseFloat(ticker.priceChangePercent);
                    const price = parseFloat(ticker.price);
                    
                    return percentage >= this.minPercentage && // Configurable minimum change
                           price >= this.minContractPrice && // Minimum price
                           !this.traders.find(t => t.symbol === ticker.symbol); // Not already trading
                })
                .sort((a, b) => parseFloat(b.priceChangePercent) - parseFloat(a.priceChangePercent))
                .slice(0, 3); // Top 3 candidates
            
            console.log(`📊 Found ${candidates.length} WebSocket candidates meeting ${this.minPercentage}% criteria`);
            
            if (candidates.length > 0) {
                console.log(`🏁 Processing ${candidates.length} WebSocket candidates that passed initial filters`);
                
                for (const candidate of candidates) {
                    if (this.traders.length >= this.maxTraders) break;
                    
                    console.log(`\n🎯 Evaluating ${candidate.symbol}: ${candidate.priceChangePercent}% change`);
                    
                    const tradeDirection = 'SHORT'; // Default for gainers
                    const usdtAmount = 5; // Default USDT amount per trade
                    
                    // Use refactored validation function
                    const validationResult = await this.validateTraderCandidate(candidate, usdtAmount, tradeDirection);
                    
                    if (!validationResult) {
                        continue; // Validation failed, skip to next candidate
                    }
                    
                    // Use refactored trader creation function
                    const trader = this.createTraderFromValidatedCandidate(candidate, usdtAmount, tradeDirection);
                    
                    if (!trader) {
                        console.log(`❌ ${candidate.symbol}: FAILED - Trader creation failed`);
                    }
                }
            } else {
                console.log(`🚨 No WebSocket candidates found. Top movers analysis:`);
                const topMovers = tickers
                    .sort((a, b) => Math.abs(parseFloat(b.priceChangePercent)) - Math.abs(parseFloat(a.priceChangePercent)))
                    .slice(0, 5);
                    
                topMovers.forEach((ticker, index) => {
                    const percentage = parseFloat(ticker.priceChangePercent);
                    const price = parseFloat(ticker.price);
                    const existingTrader = this.traders.find(t => t.symbol === ticker.symbol);
                    
                    let reason = '';
                    if (Math.abs(percentage) < this.minPercentage) reason = `Below ${this.minPercentage}% threshold`;
                    else if (price < this.minContractPrice) reason = `Price too low ($${price})`;
                    else if (existingTrader) reason = 'Already have trader';
                    else reason = 'Would need further validation';
                    
                    console.log(`  ${index + 1}. ${ticker.symbol}: ${percentage.toFixed(2)}% - ${reason}`);
                });
            }
        } catch (error) {
            console.log('❌ Error checking WebSocket opportunities:', error.message);
        }
    }

    displayTraderSummaries() {
        if (this.traders.length === 0) return;

        console.log(`\n=== REAL-TIME TRADER SUMMARIES (${this.testingMode ? 'TESTING' : 'LIVE'} MODE) ===`);
        this.traders.forEach((trader, index) => {
            try {
                const summary = trader.getTradingSummary();
                if (!summary) return;
                
                const currentPrice = summary.currentPrice || 0;
                const highestPercentage = summary.highestPercentage || 0;
                const realTimeTotalProfit = summary.realTimeTotalProfit || 0;
                const profitPercentage = summary.profitPercentage || 0;
                const averagePrice = summary.averagePrice || 0;
                const takeProfitPrice = summary.takeProfitPrice || 0;
                const takeProfitDistance = summary.takeProfitDistance || 0;
                
                console.log(`${index + 1}. ${summary.symbol}: ${summary.startPercentage}% → ${highestPercentage.toFixed(1)}% | Current: $${currentPrice.toFixed(6)}`);
                console.log(`   Transactions: ${summary.currentTransactions || 0} | RT Profit: ${realTimeTotalProfit.toFixed(2)} | Profit %: ${profitPercentage.toFixed(2)}% | Status: ${summary.status || 'UNKNOWN'}`);
                
                if (summary.executedLevels && summary.executedLevels.length > 0) {
                    console.log(`   Levels: [${summary.executedLevels.join('%, ')}%] | Avg: $${averagePrice.toFixed(6)} | TP: $${takeProfitPrice.toFixed(6)} | TP Distance: ${takeProfitDistance.toFixed(2)}%`);
                }

                // Show individual transaction performance (only if there are transactions)
                if (summary.transactions && summary.transactions.length > 0) {
                    const profitableCount = summary.transactions.filter(t => t && t.currentProfit > 0).length;
                    console.log(`   Transaction P&L: ${profitableCount}/${summary.transactions.length} profitable`);
                }
            } catch (error) {
                console.log(`${index + 1}. Error displaying summary for trader ${trader?.symbol || 'UNKNOWN'}:`, error.message);
            }
        });
    }

    startPeriodicUpdates() {
        // Initial scan on startup
        setTimeout(() => {
            console.log('=== INITIAL TRADER SCAN ===');
            this.tick();
        }, 5000); // Wait 5 seconds for WebSocket to connect
        
        // Periodic REST API backup every 5 minutes (to avoid rate limits)
        this.tickInterval = setInterval(() => {
            this.tick();
        }, 300000); // 5 minutes
    }

    stopTicking() {
        if (this.tickInterval) {
            clearInterval(this.tickInterval);
            this.tickInterval = null;
        }
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }

    addTrader(traderConfig) {
        if (this.traders.length >= this.maxTraders) {
            console.log(`Cannot add trader: Maximum of ${this.maxTraders} traders reached`);
            return null;
        }

        try {
            console.log(`🔧 Creating trader for ${traderConfig.symbol} with price: ${traderConfig.price} (type: ${typeof traderConfig.price})`);
            
            const trader = new Trader(this, traderConfig);
            this.traders.push(trader);
            console.log(`✅ Trader added. Total traders: ${this.traders.length}/${this.maxTraders}`);
            return trader;
        } catch (error) {
            console.log(`❌ Error creating trader for ${traderConfig.symbol}:`, error.message);
            console.log(`📊 Trader config:`, traderConfig);
            return null;
        }
    }

    removeTrader(trader) {
        const index = this.traders.findIndex(t => t.id === trader.id);
        if (index !== -1) {
            // Properly cleanup trader resources before removal
            if (trader.cleanup) {
                trader.cleanup();
            }
            this.traders.splice(index, 1);
            console.log(`Trader removed and cleaned up. Total traders: ${this.traders.length}/${this.maxTraders}`);
            return true;
        }
        return false;
    }

    // Cleanup all traders (useful for shutdown)
    cleanupAllTraders() {
        console.log(`Cleaning up ${this.traders.length} traders...`);
        this.traders.forEach(trader => {
            if (trader.cleanup) {
                trader.cleanup();
            }
        });
        console.log('All traders cleaned up');
    }

    getActiveTraders() {
        return this.traders.filter(trader => trader.status === 'ACTIVE');
    }

    getAllTraders() {
        return this.traders;
    }

    setMaxTraders(newMax) {
        if (newMax < this.traders.length) {
            console.log(`Cannot set max traders to ${newMax}: Currently have ${this.traders.length} active traders`);
            return false;
        }
        this.maxTraders = newMax;
        console.log(`Max traders updated to: ${this.maxTraders}`);
        return true;
    }

    setMinPercentage(newMinPercentage) {
        if (newMinPercentage < 0 || newMinPercentage > 100) {
            console.log(`Invalid minimum percentage: ${newMinPercentage}%. Must be between 0 and 100.`);
            return false;
        }
        this.minPercentage = newMinPercentage;
        console.log(`Minimum percentage updated to: ${this.minPercentage}%`);
        return true;
    }
    
    setSkipValidationFilters(skipFilters) {
        this.skipValidationFilters = skipFilters;
        console.log(`Validation filters ${skipFilters ? 'DISABLED' : 'ENABLED'}. ${skipFilters ? '⚠️ All momentum and order size validations will be skipped!' : '✅ Normal validation process restored.'}`);
        return true;
    }

    /**
     * Validates a trading candidate based on momentum and order requirements
     * @param {Object} candidate - Trading candidate object
     * @param {number} usdtAmount - USDT amount for the trade
     * @param {string} tradeDirection - 'LONG' or 'SHORT'
     * @returns {Object|null} Returns validation results or null if validation fails
     */
    async validateTraderCandidate(candidate, usdtAmount, tradeDirection) {
        try {
            const candidateInfo = `${candidate.symbol}: ${candidate.priceChangePercent || candidate.percentage}%`;
            const currentPrice = parseFloat(candidate.price || candidate.lastPrice) || 0;
            
            // Normal validation process
            console.log(`🔍 ${candidateInfo}: Starting validation checks`);
            
            // Validate momentum
            const momentumValid = await this.service.validateMomentum(candidate.symbol, currentPrice, tradeDirection);
            if (!momentumValid && !this.skipValidationFilters) {
                console.log(`❌ ${candidateInfo}: REJECTED - Failed momentum validation (not at new ${tradeDirection === 'SHORT' ? 'high' : 'low'})`);
                return null;
            }
            
            console.log(`✅ ${candidateInfo}: Momentum validation passed - checking order requirements`);
            
            // Validate minimum order requirements
            const orderValidation = await this.service.validateMinimumOrderSize(candidate.symbol, usdtAmount, currentPrice);
            if (!orderValidation) {
                console.log(`❌ ${candidateInfo}: REJECTED - Failed minimum order validation (need more than $${usdtAmount} USDT)`);
                return null;
            }
            
            console.log(`✅ ${candidateInfo}: All validations passed`);
            candidate.orderValidation = orderValidation;
            
            return { passed: true, orderValidation, reason: 'All validations passed' };
        } catch (error) {
            console.log(`❌ ${candidate.symbol}: Validation error:`, error.message);
            return null;
        }
    }

    /**
     * Creates a trader from a validated candidate
     * @param {Object} candidate - Validated trading candidate
     * @param {number} usdtAmount - USDT amount for the trade
     * @param {string} tradeDirection - 'LONG' or 'SHORT'
     * @returns {Object|null} Returns created trader or null if creation fails
     */
    createTraderFromValidatedCandidate(candidate, usdtAmount, tradeDirection) {
        try {
            const candidateInfo = `${candidate.symbol}: ${candidate.priceChangePercent || candidate.percentage}%`;
            
            // Create trader configuration
            const traderConfig = {
                symbol: candidate.symbol,
                percentage: parseFloat(candidate.priceChangePercent || candidate.percentage) || 0,
                price: parseFloat(candidate.price || candidate.lastPrice) || 0,
                priceChange: parseFloat(candidate.priceChange) || 0,
                volume: parseFloat(candidate.volume) || 0,
                contractAge: parseInt(candidate.contractAge) || 30, // Default age for WebSocket data
                usdtAmount: usdtAmount,
                takeProfit: 10, // 10% take profit target
                tradeDirection: tradeDirection,
                orderValidation: candidate.orderValidation, // Pass validation results
                testingMode: this.testingMode
            };
            
            const trader = this.addTrader(traderConfig);
            if (trader) {
                console.log(`✅ ${candidateInfo}: SUCCESS - Trader created with $${usdtAmount} USDT`);
                return trader;
            } else {
                console.log(`❌ ${candidateInfo}: FAILED - addTrader() returned null`);
                return null;
            }
        } catch (error) {
            console.log(`❌ ${candidate.symbol}: Error creating trader:`, error.message);
            return null;
        }
    }

    async getFilteredGainers() {
        try {
            console.log('🔍 Fetching and filtering gainers...');
            
            // Use the new API method with our controller settings
            const filteredGainers = await this.service.getFilteredGainersAdvanced(
                this.minPercentage, // minimum percentage
                this.minContractPrice,
                this.minContractDays,
                100 // limit for initial search
            );
            
            console.log(`✅ Found ${filteredGainers.length} gainers meeting criteria (>${this.minPercentage}%, >$${this.minContractPrice}, >${this.minContractDays} days old)`);
            
            // Log the top gainers that meet criteria for debugging
            if (filteredGainers.length > 0) {
                console.log('📊 Top filtered gainers:');
                filteredGainers.slice(0, 5).forEach((gainer, index) => {
                    console.log(`  ${index + 1}. ${gainer.symbol}: ${gainer.priceChangePercent}% (Price: $${gainer.price}, Age: ${gainer.contractAge} days)`);
                });
            } else {
                console.log('⚠️  No gainers found that meet the criteria. Checking if getFilteredGainersAdvanced method exists...');
            }

            return filteredGainers;
        } catch (error) {
            console.log('❌ Error filtering gainers:', error.message);
            console.log('📝 Method getFilteredGainersAdvanced may not exist. Falling back to manual filtering...');
            
            // Fallback to manual filtering if the advanced method doesn't exist
            try {
                const allGainers = await this.service.getTopGainers(100);
                console.log(`📈 Got ${allGainers.length} total gainers, now filtering...`);
                
                const manualFiltered = allGainers.filter(gainer => {
                    const percentage = parseFloat(gainer.priceChangePercent);
                    const price = parseFloat(gainer.price || gainer.lastPrice);
                    
                    const meetsPercentage = percentage >= this.minPercentage;
                    const meetsPrice = price >= this.minContractPrice;
                    // Skip contract age check for now as it may not be available
                    
                    if (meetsPercentage && meetsPrice) {
                        console.log(`✅ ${gainer.symbol}: ${percentage}% (Price: $${price}) - MEETS CRITERIA`);
                    }
                    
                    return meetsPercentage && meetsPrice;
                });
                
                console.log(`📊 Manual filtering result: ${manualFiltered.length} gainers meet criteria`);
                return manualFiltered;
                
            } catch (fallbackError) {
                console.log('❌ Fallback filtering also failed:', fallbackError.message);
                return [];
            }
        }
    }

    async createTradersFromGainers() {
        try {
            console.log('🚀 Starting trader creation process...');
            console.log(`📊 Current traders: ${this.traders.length}/${this.maxTraders}`);
            
            const filteredGainers = await this.getFilteredGainers();
            
            if (filteredGainers.length === 0) {
                console.log('⚠️  No gainers meet the criteria for trader creation');
                console.log(`🔍 Criteria: >${this.minPercentage}% gain, >$${this.minContractPrice}, >${this.minContractDays} days old`);
                return;
            }

            console.log(`🎯 Creating traders from ${filteredGainers.length} filtered gainers...`);
            
            let processedCount = 0;
            let rejectedReasons = {
                maxTradersReached: 0,
                alreadyExists: 0,
                momentumFailed: 0,
                minOrderFailed: 0,
                addTraderFailed: 0,
                success: 0
            };

            for (const gainer of filteredGainers) {
                processedCount++;
                console.log(`\n🔍 [${processedCount}/${filteredGainers.length}] Evaluating ${gainer.symbol}: ${gainer.priceChangePercent}% gain`);
                
                // Don't exceed max traders limit
                if (this.traders.length >= this.maxTraders) {
                    console.log(`❌ ${gainer.symbol}: REJECTED - Maximum traders limit reached (${this.maxTraders})`);
                    rejectedReasons.maxTradersReached++;
                    break;
                }

                // Check if we already have a trader for this symbol
                const existingTrader = this.traders.find(trader => trader.symbol === gainer.symbol);
                if (existingTrader) {
                    console.log(`❌ ${gainer.symbol}: REJECTED - Trader already exists (${gainer.priceChangePercent}%)`);
                    rejectedReasons.alreadyExists++;
                    continue;
                }
                
                console.log(`Attempting to create trader for ${gainer.symbol}: ${gainer.priceChangePercent}% gain, $${gainer.price}, ${gainer.contractAge} days old`);

                const tradeDirection = 'SHORT'; // For gainers, we use SHORT direction
                const usdtAmount = 10; // $10 USDT per transaction level
                
                // Use refactored validation function
                const validationResult = await this.validateTraderCandidate(gainer, usdtAmount, tradeDirection);
                
                if (!validationResult) {
                    // Determine which validation failed for statistics
                    if (!this.skipValidationFilters) {
                        // Check what specifically failed (this is approximate since we can't distinguish)
                        rejectedReasons.momentumFailed++;
                    }
                    continue;
                }
                
                console.log(`✅ ${gainer.symbol}: All validations passed - creating trader`);
                
                // Use refactored trader creation function
                const trader = this.createTraderFromValidatedCandidate(gainer, usdtAmount, tradeDirection);
                
                if (trader) {
                    console.log(`✅ ${gainer.symbol}: SUCCESS - Trader created (${gainer.priceChangePercent}% gain, $${gainer.price})`);
                    rejectedReasons.success++;
                } else {
                    console.log(`❌ ${gainer.symbol}: FAILED - Trader creation failed`);
                    rejectedReasons.addTraderFailed++;
                }
            }
            
            // Summary report
            console.log(`\n📊 TRADER CREATION SUMMARY:`);
            console.log(`  Processed: ${processedCount} candidates`);
            console.log(`  ✅ Success: ${rejectedReasons.success}`);
            console.log(`  ❌ Rejected breakdown:`);
            console.log(`    - Max traders reached: ${rejectedReasons.maxTradersReached}`);
            console.log(`    - Already exists: ${rejectedReasons.alreadyExists}`);
            console.log(`    - Failed momentum: ${rejectedReasons.momentumFailed}`);
            console.log(`    - Min order size: ${rejectedReasons.minOrderFailed}`);
            console.log(`    - addTrader failed: ${rejectedReasons.addTraderFailed}`);

            console.log(`Trader creation complete. Active traders: ${this.traders.length}/${this.maxTraders}`);
        } catch (error) {
            console.log('Error creating traders from gainers:', error.message);
        }
    }

    // Toggle between testing and live mode
    setTradingMode(testingMode) {
        const oldMode = this.testingMode;
        this.testingMode = testingMode;
        
        console.log(`Trading mode changed from ${oldMode ? 'TESTING' : 'LIVE'} to ${this.testingMode ? 'TESTING' : 'LIVE'}`);
        
        // Update existing traders
        this.traders.forEach(trader => {
            trader.testingMode = this.testingMode;
            trader.transactions.forEach(transaction => {
                transaction.testingMode = this.testingMode;
            });
        });
        
        return true;
    }

    // Get current trading mode
    getTradingMode() {
        return {
            testingMode: this.testingMode,
            modeString: this.testingMode ? 'TESTING' : 'LIVE'
        };
    }

    async scanForTradingOpportunities() {
        try {
            console.log('\n=== SCANNING FOR TRADING OPPORTUNITIES ===');
            
            // Only scan if we have available trader slots
            if (this.traders.length >= this.maxTraders) {
                console.log(`All trader slots occupied (${this.traders.length}/${this.maxTraders})`);
                return;
            }

            await this.createTradersFromGainers();
            console.log('=== SCANNING COMPLETE ===\n');
        } catch (error) {
            console.log('Error scanning for opportunities:', error.message);
        }
    }

    async tick() {
        try {
            console.log('📡 Fetching periodic REST API update...');
            console.log('🔄 Also triggering trader creation scan...');
            
            const [topGainers, topLosers] = await Promise.all([
                this.service.getTopGainers(5),
                this.service.getTopLosers(5)
            ]);
            
            // Trigger trader creation during periodic updates
            if (this.traders.length < this.maxTraders) {
                console.log('🎯 Available trader slots, checking for new opportunities...');
                await this.createTradersFromGainers();
            }

            console.log('=== PERIODIC TOP GAINERS (REST API) ===');
            topGainers.forEach((gainer, index) => {
                console.log(`${index + 1}. ${gainer.symbol}: ${gainer.priceChangePercent}% (${gainer.price})`);
            });

            console.log('\n=== PERIODIC TOP LOSERS (REST API) ===');
            topLosers.forEach((loser, index) => {
                console.log(`${index + 1}. ${loser.symbol}: ${loser.priceChangePercent}% (${loser.price})`);
            });
            
            console.log(`\nActive Traders: ${this.getActiveTraders().length}/${this.maxTraders}`);
            
            // Display trader summaries
            this.displayTraderSummaries();
            
            console.log('========================================\n');

            // Update all traders during periodic tick
            this.updateAllTraders();

            // Scan for new trading opportunities
            await this.scanForTradingOpportunities();
        } catch (error) {
            console.log('Error in periodic tick function:', error.message);
        }
    }
}

module.exports = { Controller };
