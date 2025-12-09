const { Service } = require('./API');
const { Trader } = require('./Trader');
const WebSocket = require('ws');

class Controller {
    constructor(maxTraders = 10, testingMode = true) {
        this.service = new Service("futures");
        this.traders = [];
        this.maxTraders = maxTraders;
        this.minContractPrice = 0.01;
        this.minContractDays = 30;
        this.testingMode = testingMode;
        this.tickerData = new Map();
        
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
                            priceChange: ticker.P,
                            priceChangePercent: ticker.P,
                            volume: ticker.v,
                            quoteVolume: ticker.q
                        });
                    });
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

        const trader = new Trader(this, traderConfig);
        this.traders.push(trader);
        console.log(`Trader added. Total traders: ${this.traders.length}/${this.maxTraders}`);
        return trader;
    }

    removeTrader(trader) {
        const index = this.traders.findIndex(t => t.id === trader.id);
        if (index !== -1) {
            this.traders.splice(index, 1);
            console.log(`Trader removed. Total traders: ${this.traders.length}/${this.maxTraders}`);
            return true;
        }
        return false;
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
            console.log('Fetching and filtering gainers...');
            
            // Use the new API method with our controller settings
            const filteredGainers = await this.service.getFilteredGainersAdvanced(
                50, // minimum percentage (reduced from 50% to catch more opportunities)
                this.minContractPrice,
                this.minContractDays,
                100 // limit for initial search
            );
            
            console.log(`Found ${filteredGainers.length} gainers meeting criteria (>20%, >$${this.minContractPrice}, >${this.minContractDays} days old)`);

            return filteredGainers;
        } catch (error) {
            console.log('Error filtering gainers:', error.message);
            return [];
        }
    }

    async createTradersFromGainers() {
        try {
            const filteredGainers = await this.getFilteredGainers();
            
            if (filteredGainers.length === 0) {
                console.log('No gainers meet the criteria for trader creation');
                return;
            }

            console.log('Creating traders from filtered gainers...');

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
                const traderConfig = {
                    symbol: gainer.symbol,
                    percentage: gainer.priceChangePercent,
                    price: gainer.price,
                    priceChange: gainer.priceChange,
                    volume: gainer.volume,
                    contractAge: gainer.contractAge,
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
            console.log('Fetching periodic REST API update...');
            const [topGainers, topLosers] = await Promise.all([
                this.service.getTopGainers(5),
                this.service.getTopLosers(5)
            ]);

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
