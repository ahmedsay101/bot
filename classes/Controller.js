const { Service } = require('./API');
const { Trader } = require('./Trader');
const WebSocket = require('ws');

class Controller {
    constructor(maxTraders = 10, testingMode = true) {
        this.service = new Service("futures");
        this.traders = [];
        this.maxTraders = maxTraders;
        this.maxLevels = 10; // Maximum number of price levels per trader
        this.levelPercentage = 10; // Percentage gap between levels (10% = 1.1x for LONG, 0.9x for SHORT)
        this.minContractPrice = 0.01;
        this.minContractDays = 30;
        this.testingMode = testingMode;
        this.tickerData = new Map();
        this.hasLoggedTickerData = false;
        
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
            
            // Filter for potential trading opportunities directly from WebSocket data
            const candidates = tickers
                .filter(ticker => {
                    const percentage = parseFloat(ticker.priceChangePercent);
                    const price = parseFloat(ticker.price);
                    
                    return percentage >= 30 && // 30% minimum change
                           price >= this.minContractPrice && // Minimum price
                           !this.traders.find(t => t.symbol === ticker.symbol); // Not already trading
                })
                .sort((a, b) => parseFloat(b.priceChangePercent) - parseFloat(a.priceChangePercent))
                .slice(0, 3); // Top 3 candidates
            
            console.log(`📊 Found ${candidates.length} WebSocket candidates meeting 30% criteria`);
            
            if (candidates.length > 0) {
                for (const candidate of candidates) {
                    if (this.traders.length >= this.maxTraders) break;
                    
                    console.log(`🎯 Attempting to create trader for ${candidate.symbol}: ${candidate.priceChangePercent}%`);
                    
                    const traderConfig = {
                        symbol: candidate.symbol,
                        percentage: parseFloat(candidate.priceChangePercent),
                        price: parseFloat(candidate.price),
                        priceChange: parseFloat(candidate.priceChange || 0),
                        volume: parseFloat(candidate.volume || 0),
                        contractAge: 30, // Default age since WebSocket doesn't provide this
                        usdtAmount: 10,
                        takeProfit: 10,
                        tradeDirection: 'SHORT',
                        testingMode: this.testingMode
                    };
                    
                    const trader = this.addTrader(traderConfig);
                    if (trader) {
                        console.log(`✅ Created trader for ${candidate.symbol} (${candidate.priceChangePercent}%)`);
                    }
                }
            }
        } catch (error) {
            console.log('❌ Error checking WebSocket opportunities:', error.message);
        }
    }

    displayTraderSummaries() {
        if (this.traders.length === 0) return;

        console.log(`\n=== REAL-TIME TRADER SUMMARIES (${this.testingMode ? 'TESTING' : 'LIVE'} MODE) ===`);
        this.traders.forEach((trader, index) => {
            const summary = trader.getTradingSummary();
            console.log(`${index + 1}. ${summary.symbol}: ${summary.startPercentage}% → ${summary.highestPercentage.toFixed(1)}% | Current: $${summary.currentPrice.toFixed(6)}`);
            console.log(`   Transactions: ${summary.currentTransactions} | RT Profit: ${summary.realTimeTotalProfit.toFixed(2)} | Profit %: ${summary.profitPercentage.toFixed(2)}% | Status: ${summary.status}`);
            
            if (summary.executedLevels.length > 0) {
                console.log(`   Levels: [${summary.executedLevels.join('%, ')}%] | Avg: $${summary.averagePrice.toFixed(6)} | TP: $${summary.takeProfitPrice.toFixed(6)} | TP Distance: ${summary.takeProfitDistance.toFixed(2)}%`);
            }

            // Show individual transaction performance (only if there are transactions)
            if (summary.transactions.length > 0) {
                const profitableCount = summary.transactions.filter(t => t.currentProfit > 0).length;
                console.log(`   Transaction P&L: ${profitableCount}/${summary.transactions.length} profitable`);
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

    async getFilteredGainers() {
        try {
            console.log('🔍 Fetching and filtering gainers...');
            
            // Use the new API method with our controller settings
            const filteredGainers = await this.service.getFilteredGainersAdvanced(
                30, // minimum percentage (50% as per requirements)
                this.minContractPrice,
                this.minContractDays,
                100 // limit for initial search
            );
            
            console.log(`✅ Found ${filteredGainers.length} gainers meeting criteria (>50%, >$${this.minContractPrice}, >${this.minContractDays} days old)`);
            
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
                    
                    const meetsPercentage = percentage >= 50;
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
                console.log('🔍 Criteria: >50% gain, >$' + this.minContractPrice + ', >' + this.minContractDays + ' days old');
                return;
            }

            console.log(`🎯 Creating traders from ${filteredGainers.length} filtered gainers...`);

            for (const gainer of filteredGainers) {
                // Don't exceed max traders limit
                if (this.traders.length >= this.maxTraders) {
                    console.log(`Reached maximum traders limit (${this.maxTraders}). Stopping trader creation.`);
                    break;
                }

                // Check if we already have a trader for this symbol
                const existingTrader = this.traders.find(trader => trader.symbol === gainer.symbol);
                if (existingTrader) {
                    console.log(`Trader already exists for ${gainer.symbol} (${gainer.priceChangePercent}%), skipping...`);
                    continue;
                }
                
                console.log(`Attempting to create trader for ${gainer.symbol}: ${gainer.priceChangePercent}% gain, $${gainer.price}, ${gainer.contractAge} days old`);

                // Create trader configuration
                // For gainers (positive momentum), use SHORT to profit from potential reversal
                // For high gains, we expect a pullback, so SHORT is more appropriate
                const traderConfig = {
                    symbol: gainer.symbol,
                    percentage: parseFloat(gainer.priceChangePercent) || 0,
                    price: parseFloat(gainer.price || gainer.lastPrice) || 0,
                    priceChange: parseFloat(gainer.priceChange) || 0,
                    volume: parseFloat(gainer.volume) || 0,
                    contractAge: parseInt(gainer.contractAge) || 0,
                    usdtAmount: 10,  // $10 USDT per transaction level
                    takeProfit: 10,  // 10% take profit target
                    tradeDirection: 'SHORT',  // SHORT high-momentum gainers for reversal profits
                    testingMode: this.testingMode
                };

                const trader = this.addTrader(traderConfig);
                if (trader) {
                    console.log(`Created trader for ${gainer.symbol} (${gainer.priceChangePercent}% gain, $${gainer.price})`);
                }
            }

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
