require("dotenv").config();
const { default: axios } = require("axios");
const { createHmac } = require("crypto");

class API {
    constructor(api = "spot") {
        this.BASE_URL_DEFAULT = process.env.BASE_URL;
        this.BASE_URL = 
            api === "spot" ? process.env.BASE_URL 
            : api === "futures" ? process.env.FUTURES_BASE_URL 
            : api === "futures-testnet" ? process.env.FUTURES_TESTNET_BASE_URL 
            : api === "convert" ? process.env.CONVERT_BASE_URL
            : process.env.BASE_URL;

        this.apiKey = process.env.API_KEY;
        this.secretKey = process.env.SECRET_KEY;
        this.contentType = "application/x-www-form-urlencoded";
        this.headers = {
            'X-MBX-APIKEY': this.apiKey,
            "SecretKey": this.secretKey,
            "Content-Type": this.contentType,     
        }

        this.urls = {
            info: "/exchangeInfo",
            orderLimits: "/rateLimit/order",
            priceTicker: "/ticker/price",
            bookTicker: "/ticker/bookTicker",
            depth: "/depth",
            tradeList: "/trades",
            account: api === "futures" ? "/../v2/account" : "/account",
            order: "/order",
            batchOrders: "/batchOrders",
            leverage: "/leverage",
            openOrders: "/openOrders",
            allOrders: "/allOrders",
            getQuote: "/getQuote",
            klines: "/klines",
            ticker24hr: "/ticker/24hr",
            positionRisk: "/../v2/positionRisk", // v2 endpoint for position risk
        }

        this.createInstance();
    }

    createInstance(headers = null) {
        this.instance = axios.create({
            baseURL: this.BASE_URL,
            headers: headers ? headers : this.headers
        });
        this.defaultInstance = axios.create({
            baseURL: this.BASE_URL_DEFAULT,
            headers: headers ? headers : this.headers
        });
    }

    buildQuery = (query) => `${query && query.length > 0 ? "?" : ""}${query && query.length > 0 ? query.map(obj => `${Object.keys(obj)[0]}=${obj[Object.keys(obj)[0]]}`).join("&") : ""}`;

    buildSignature = (data) => {
        return createHmac('sha256', this.secretKey).update(data).digest('hex');
    };

    async getTimeStamp() {
        try {
            const timestampResponse = await this.defaultInstance.get("/time");
            const timestamp = timestampResponse.data.serverTime;
            return timestamp;
        }
        catch(error) {
            console.log(error);
            throw error;
        }
    }

    async getQueryString(query) {
        let queryString = this.buildQuery([...query, {recvWindow: 5000}]);
        const timestamp = await this.getTimeStamp();
        queryString+=`&timestamp=${timestamp}`;
        const signature = this.buildSignature(queryString.replace(/\?/g, ""));
        queryString+= `&signature=${signature}`;
        return queryString;
    }

    async getPayload(body) {
        const payload = {...body};
        const timestamp = await this.getTimeStamp();
        payload["timestamp"] = timestamp;
    
        const signaturePayload = this.buildQuery(Object.keys(payload).map(key => {
            const pair = {};
            pair[key] = payload[key];
            return pair;
        })).replace(/\?/g, "");
    
        const signature = this.buildSignature(signaturePayload);    
        payload["signature"] = signature;
        return payload;
    }

    async authenticatedGet(url, query = []) {
        try {
            const queryString = await this.getQueryString(query);
            const link = `${url}${queryString}`;
            const response = await this.instance.get(link);
            return response.data;
        }
        catch(error) {
            console.log(error);
            throw(error);
        }
    }

    
    async get(url, query = []) {
        try {
            const queryString = this.buildQuery(query);
            const link = `${url}${queryString}`;
            const response = await this.instance.get(link);
            return response.data;
        }
        catch(error) {
            console.log(error);
            throw(error);
        }
    }
    
    async authenticatedPost(url, body, query = []) {
        try {
            const payload = await this.getPayload(body);
            const response = await this.instance.post(url, payload);
            return response.data;
        }
        catch(error) {
            console.log(error);
            throw(error);
        }
    }

    async authenticatedDelete(url, params = {}) {
        try {
            // Convert params object to query array format
            const query = Object.keys(params).map(key => {
                const obj = {};
                obj[key] = params[key];
                return obj;
            });
            
            const queryString = await this.getQueryString(query);
            const link = `${url}${queryString}`;
            const response = await this.instance.delete(link);
            return response.data;
        }
        catch(error) {
            console.log(error);
            throw(error);
        }
    }

    async post(url, body, query = []) {
        try {
            const response = await this.instance.post(url, body);
            return response.data;
        }
        catch(error) {
            console.log(error);
            throw(error);
        }
    }
}

class Service extends API {
    constructor(api = "spot") {
        super(api);
    }

    async getInfo() {
        try {
            return this.get(this.urls.info);
        }
        catch(error) {
            console.log(error);
            throw(error);
        }
    }

    // Get minimum order requirements for a specific symbol
    async getMinimumOrderRequirements(symbol) {
        try {
            const exchangeInfo = await this.getInfo();
            
            if (!exchangeInfo || !exchangeInfo.symbols) {
                throw new Error('Unable to fetch exchange info');
            }
            
            const symbolInfo = exchangeInfo.symbols.find(s => s.symbol === symbol);
            if (!symbolInfo) {
                throw new Error(`Symbol ${symbol} not found in exchange info`);
            }
            
            // Extract minimum order requirements
            const minQtyFilter = symbolInfo.filters.find(f => f.filterType === 'LOT_SIZE');
            const minNotionalFilter = symbolInfo.filters.find(f => f.filterType === 'MIN_NOTIONAL');
            const marketLotSizeFilter = symbolInfo.filters.find(f => f.filterType === 'MARKET_LOT_SIZE');
            const priceFilter = symbolInfo.filters.find(f => f.filterType === 'PRICE_FILTER');
            
            // Calculate precision from step sizes
            const quantityPrecision = minQtyFilter ? this.getPrecisionFromStepSize(minQtyFilter.stepSize) : 8;
            const pricePrecision = priceFilter ? this.getPrecisionFromStepSize(priceFilter.tickSize) : 8;
            
            return {
                symbol: symbol,
                baseAsset: symbolInfo.baseAsset,
                quoteAsset: symbolInfo.quoteAsset,
                minQty: minQtyFilter ? parseFloat(minQtyFilter.minQty) : 0,
                maxQty: minQtyFilter ? parseFloat(minQtyFilter.maxQty) : 0,
                stepSize: minQtyFilter ? parseFloat(minQtyFilter.stepSize) : 0,
                minNotional: minNotionalFilter ? parseFloat(minNotionalFilter.minNotional || minNotionalFilter.notional) : 0,
                marketMinQty: marketLotSizeFilter ? parseFloat(marketLotSizeFilter.minQty) : 0,
                tickSize: priceFilter ? parseFloat(priceFilter.tickSize) : 0,
                quantityPrecision: quantityPrecision,
                pricePrecision: pricePrecision,
                status: symbolInfo.status
            };
        } catch (error) {
            console.log(`Error getting minimum order requirements for ${symbol}:`, error.message);
            return null;
        }
    }
    
    // Validate if USDT amount can meet minimum trading requirements
    async validateMinimumOrderSize(symbol, usdtAmount, currentPrice) {
        try {
            const requirements = await this.getMinimumOrderRequirements(symbol);
            
            if (!requirements) {
                console.log(`${symbol}: Unable to get minimum order requirements`);
                return false;
            }
            
            // Check if symbol is active for trading
            if (requirements.status !== 'TRADING') {
                console.log(`${symbol}: Symbol status is ${requirements.status}, not TRADING`);
                return false;
            }
            
            // Calculate base asset amount we can buy with our USDT
            let baseAssetAmount = usdtAmount / currentPrice;
            
            // Round values to correct precision
            let roundedQuantity = this.roundToStepSize(baseAssetAmount, requirements.stepSize, requirements.quantityPrecision);
            const roundedPrice = this.roundToStepSize(currentPrice, requirements.tickSize, requirements.pricePrecision);
            
            // Calculate actual notional value (quantity * price)
            let actualNotional = roundedQuantity * roundedPrice;
            
            // Binance requires minimum $5 USDT notional value
            const binanceMinNotional = 5;
            const effectiveMinNotional = Math.max(requirements.minNotional, binanceMinNotional);
            
            // If notional is below minimum, calculate required quantity to meet minimum with small buffer
            if (actualNotional < effectiveMinNotional) {
                // Add 2% buffer to ensure we're comfortably above minimum but not too much higher
                const bufferMultiplier = 1.02;
                const targetNotional = effectiveMinNotional * bufferMultiplier;
                const requiredQuantity = targetNotional / roundedPrice;
                roundedQuantity = this.roundToStepSize(requiredQuantity, requirements.stepSize, requirements.quantityPrecision);
                actualNotional = roundedQuantity * roundedPrice;
                
                console.log(`${symbol}: ⬆️ Adjusting quantity to meet minimum notional:`);
                console.log(`  Original: ${baseAssetAmount.toFixed(requirements.quantityPrecision)} tokens = $${(baseAssetAmount * roundedPrice).toFixed(2)}`);
                console.log(`  Adjusted: ${roundedQuantity.toFixed(requirements.quantityPrecision)} tokens = $${actualNotional.toFixed(2)}`);
                console.log(`  Required minimum: $${effectiveMinNotional.toFixed(2)} USDT (with 2% buffer: $${targetNotional.toFixed(2)})`);
            }
            
            // Check minimum quantity requirement
            if (roundedQuantity < requirements.minQty) {
                console.log(`${symbol}: Order too small even after adjustment - Need ${requirements.minQty} ${requirements.baseAsset}, calculated ${roundedQuantity.toFixed(requirements.quantityPrecision)}`);
                return false;
            }
            
            // Check market minimum quantity (for MARKET orders)
            if (roundedQuantity < requirements.marketMinQty) {
                console.log(`${symbol}: Market order too small even after adjustment - Need ${requirements.marketMinQty} ${requirements.baseAsset}, calculated ${roundedQuantity.toFixed(requirements.quantityPrecision)}`);
                return false;
            }
            
            // Final check that we still meet minimum notional
            if (actualNotional < effectiveMinNotional) {
                console.log(`${symbol}: Unable to meet minimum notional even after adjustment: $${actualNotional.toFixed(2)} < $${effectiveMinNotional.toFixed(2)}`);
                return false;
            }
            
            console.log(`${symbol}: ✅ Order size validation passed`);
            console.log(`  Order details: ${roundedQuantity.toFixed(requirements.quantityPrecision)} ${requirements.baseAsset} @ $${roundedPrice.toFixed(requirements.pricePrecision)}`);
            console.log(`  Notional value: $${actualNotional.toFixed(2)} USDT (min required: $${effectiveMinNotional.toFixed(2)})`);
            
            return {
                valid: true,
                baseAssetAmount: roundedQuantity,
                price: roundedPrice,
                notionalValue: actualNotional,
                adjustedForMinimum: actualNotional > (usdtAmount * 1.01), // Flag if we increased significantly
                requirements
            };
            
        } catch (error) {
            console.log(`${symbol}: Error validating minimum order size:`, error.message);
            return false;
        }
    }

    // Calculate precision (decimal places) from step size
    getPrecisionFromStepSize(stepSize) {
        const stepStr = stepSize.toString();
        if (stepStr.indexOf('.') === -1) return 0;
        const decimalPart = stepStr.split('.')[1];
        // Count trailing zeros and total length
        const trailingZeros = decimalPart.match(/0*$/)[0].length;
        return decimalPart.length - trailingZeros;
    }
    
    // Round value to correct precision based on step size
    roundToStepSize(value, stepSize, precision) {
        if (stepSize <= 0) return parseFloat(value.toFixed(precision));
        
        // Use proper floating point math to avoid precision issues
        const factor = 1 / stepSize;
        const rounded = Math.floor(value * factor) / factor;
        
        // Ensure the result respects the precision by using toFixed and parseFloat
        return parseFloat(rounded.toFixed(precision));
    }

    async getOrderLimits() {
        try {
            return this.authenticatedGet(this.urls.orderLimits);
        }
        catch(error) {
            console.log(error);
            throw(error);
        }
    }

    async getPrice(symbols) {
        try {
            const query = Array.isArray(symbols) && symbols.length > 0 ? {symbols: JSON.stringify(symbols)} : {symbol: symbols};
            return this.get(this.urls.priceTicker, [query]);
        }
        catch(error) {
            throw error;
        }
    }

    async getQuote(data) {
        try {
            return this.authenticatedPost(this.urls.getQuote, data);
        }
        catch(error) {
            throw error;
        }
    }

    async getOrderBook(symbols, limit = 20) {
        try {
            const query = Array.isArray(symbols) && symbols.length > 0 ? 
            [{symbols: JSON.stringify(symbols)}, {limit}] : 
            [{symbol: symbols}, {limit}];
            return this.get(this.urls.depth, query);
        }
        catch(error) {
            throw error;
        }
    } 

    async tradeList(symbol, limit = 999) {
        try {
            const query = [{symbol}, {limit}];
            return this.get(this.urls.tradeList, query);
        }
        catch(error) {
            throw error;
        }
    } 

    async getKlines(symbol, limit = 999, interval = "1h") {
        try {
            const query = [{symbol}, {interval}, {limit}];
            return this.get(this.urls.klines, query);
        }
        catch(error) {
            throw error;
        }
    }

    // Get last 5 days of daily candles for momentum validation
    async getRecentCandles(symbol, days = 5) {
        try {
            const query = [{symbol}, {interval: '1d'}, {limit: days}];
            const klines = await this.get(this.urls.klines, query);
            
            if (!klines || klines.length === 0) {
                return null;
            }
            
            // Parse candle data: [openTime, open, high, low, close, volume, closeTime, quoteVolume, trades, buyBaseVolume, buyQuoteVolume, ignored]
            return klines.map(candle => ({
                openTime: parseInt(candle[0]),
                open: parseFloat(candle[1]),
                high: parseFloat(candle[2]),
                low: parseFloat(candle[3]),
                close: parseFloat(candle[4]),
                volume: parseFloat(candle[5]),
                closeTime: parseInt(candle[6])
            }));
        }
        catch(error) {
            console.log(`Error getting recent candles for ${symbol}:`, error.message);
            return null;
        }
    }

    async getAccount() {
        try {
            return this.authenticatedGet(this.urls.account, [{omitZeroBalances: true}]);
        }
        catch(error) {
            throw error;
        }
    }  

    async getBalance() {
        try {
            console.log('📊 Fetching balance from Binance Futures...');
            const accountInfo = await this.authenticatedGet(this.urls.account);
            
            if (!accountInfo || !accountInfo.assets) {
                console.log('❌ Invalid account response from Binance');
                return { success: false, balance: 0, error: 'Invalid account response' };
            }

            // Find USDT balance in futures account
            const usdtAsset = accountInfo.assets.find(asset => asset.asset === 'USDT');
            
            if (!usdtAsset) {
                console.log('❌ USDT asset not found in account');
                return { success: false, balance: 0, error: 'USDT asset not found' };
            }

            const availableBalance = parseFloat(usdtAsset.availableBalance) || 0;
            const totalBalance = parseFloat(usdtAsset.walletBalance) || 0;
            const marginBalance = parseFloat(usdtAsset.marginBalance) || 0;
            
            console.log('💰 BINANCE FUTURES BALANCE RETRIEVED:');
            console.log(`   📋 Available Balance: $${availableBalance.toFixed(2)} USDT`);
            console.log(`   📊 Total Balance: $${totalBalance.toFixed(2)} USDT`);
            console.log(`   🔒 Margin Balance: $${marginBalance.toFixed(2)} USDT`);
            console.log(`   ⏰ Retrieved at: ${new Date().toISOString()}`);
            
            return { 
                success: true, 
                balance: availableBalance, 
                totalBalance: totalBalance,
                marginBalance: marginBalance
            };
        }
        catch(error) {
            console.log('❌ Error fetching balance from Binance:', error.message);
            return { success: false, balance: 0, error: error.message };
        }
    }  

    async order(data) {
        try {
            const payload = {
                ...data
            }
            return this.authenticatedPost(this.urls.order, payload);
        }
        catch(error) {
            throw error;
        }
    }

    async cancelOrder(data) {
        try {
            return this.authenticatedDelete(this.urls.order, {symbol: data.symbol, orderId: data.orderId});
        }
        catch(error) {
            throw error;
        }
    }

    async cancelOrders(data) {
        try {
            return this.authenticatedDelete(this.urls.batchOrders, {symbol: data.symbol, orderIdList: JSON.stringify(data.orderIds)});
        }
        catch(error) {
            throw error;
        }
    }

    async leverage(symbol, leverage) {
        try {
            const payload = {
                symbol, 
                leverage
            }
            return this.authenticatedPost(this.urls.leverage, payload);
        }
        catch(error) {
            throw error;
        }
    }


    async getOpenOrders(symbol = null) {
        try {
            const query = symbol ? {symbol} : null;
            return this.authenticatedGet(this.urls.openOrders, query ? [query] : []);
        }
        catch(error) {
            throw error;
        }
    }

    async getOrderByOrderId(symbol, orderId) {
        try {
            const query = [{symbol}, {orderId}];
            return this.authenticatedGet(this.urls.order, query);
        }
        catch(error) {
            throw error;
        }
    }

    async getAllOrders(symbol = null) {
        try {
            const query = symbol ? {symbol} : null;
            return this.authenticatedGet(this.urls.allOrders, query ? [query] : []);
        }
        catch(error) {
            throw error;
        }
    }

    async get24hrTicker(symbol = null) {
        try {
            const query = symbol ? [{symbol}] : [];
            return this.get(this.urls.ticker24hr, query);
        }
        catch(error) {
            throw error;
        }
    }

    async getTopGainers(limit = 10) {
        try {
            // Use WebSocket data instead of REST API to avoid rate limits
            console.log('🔍 getTopGainers - Controller exists:', !!this.controller, 'TickerData size:', this.controller?.tickerData?.size || 0);
            if (this.controller && this.controller.tickerData && this.controller.tickerData.size > 0) {
                const tickers = Array.from(this.controller.tickerData.values());
                const gainers = tickers
                    .filter(ticker => parseFloat(ticker.priceChangePercent) > 0)
                    .sort((a, b) => parseFloat(b.priceChangePercent) - parseFloat(a.priceChangePercent))
                    .slice(0, limit)
                    .map(ticker => ({
                        symbol: ticker.symbol,
                        price: ticker.price,
                        priceChange: ticker.priceChange,
                        priceChangePercent: ticker.priceChangePercent,
                        volume: ticker.volume,
                        quoteVolume: ticker.quoteVolume
                    }));
                
                console.log('Top 5 Gainers from WebSocket data:');
                gainers.slice(0, 5).forEach((ticker, index) => {
                    console.log(`${index + 1}. ${ticker.symbol}: ${ticker.priceChangePercent}%`);
                });
                
                return gainers;
            } else {
                // Fallback to REST API if WebSocket data not available
                console.log('⚠️  Using REST API fallback for getTopGainers');
                const tickers = await this.get24hrTicker();
                const gainers = tickers
                    .filter(ticker => parseFloat(ticker.priceChangePercent) > 0)
                    .sort((a, b) => parseFloat(b.priceChangePercent) - parseFloat(a.priceChangePercent))
                    .slice(0, limit)
                    .map(ticker => ({
                        symbol: ticker.symbol,
                        price: ticker.lastPrice,
                        priceChange: ticker.priceChange,
                        priceChangePercent: ticker.priceChangePercent,
                        volume: ticker.volume,
                        quoteVolume: ticker.quoteVolume
                    }));
                
                return gainers;
            }
        }
        catch(error) {
            throw error;
        }
    }

    async getTopLosers(limit = 10) {
        try {
            // Use WebSocket data instead of REST API to avoid rate limits
            console.log('🔍 getTopLosers - Controller exists:', !!this.controller, 'TickerData size:', this.controller?.tickerData?.size || 0);
            if (this.controller && this.controller.tickerData && this.controller.tickerData.size > 0) {
                const tickers = Array.from(this.controller.tickerData.values());
                const losers = tickers
                    .filter(ticker => parseFloat(ticker.priceChangePercent) < 0)
                    .sort((a, b) => parseFloat(a.priceChangePercent) - parseFloat(b.priceChangePercent))
                    .slice(0, limit)
                    .map(ticker => ({
                        symbol: ticker.symbol,
                        price: ticker.price,
                        priceChange: ticker.priceChange,
                        priceChangePercent: ticker.priceChangePercent,
                        volume: ticker.volume,
                        quoteVolume: ticker.quoteVolume
                    }));
                
                return losers;
            } else {
                // Fallback to REST API if WebSocket data not available
                console.log('⚠️  Using REST API fallback for getTopLosers');
                const tickers = await this.get24hrTicker();
                const losers = tickers
                    .filter(ticker => parseFloat(ticker.priceChangePercent) < 0)
                    .sort((a, b) => parseFloat(a.priceChangePercent) - parseFloat(b.priceChangePercent))
                    .slice(0, limit)
                    .map(ticker => ({
                        symbol: ticker.symbol,
                        price: ticker.lastPrice,
                        priceChange: ticker.priceChange,
                        priceChangePercent: ticker.priceChangePercent,
                        volume: ticker.volume,
                        quoteVolume: ticker.quoteVolume
                    }));
                
                return losers;
            }
        }
        catch(error) {
            throw error;
        }
    }

    async getContractAge(symbol, minDays = 30) {
        try {
            // Get klines data to determine contract age
            // Use daily candles and get maximum available data
            const klines = await this.getKlines(symbol, 1000, "1d");
            
            if (!klines || klines.length === 0) {
                return 0;
            }

            // Calculate the age in days
            const oldestTimestamp = parseInt(klines[0][0]); // First candle open time
            const newestTimestamp = parseInt(klines[klines.length - 1][0]); // Last candle open time
            const ageInMs = newestTimestamp - oldestTimestamp;
            const ageInDays = Math.floor(ageInMs / (1000 * 60 * 60 * 24));

            return ageInDays;
        }
        catch(error) {
            console.log(`Error getting contract age for ${symbol}:`, error.message);
            return 0; // Return 0 if we can't determine age (will be filtered out)
        }
    }
    // Validate if current price represents true momentum (new highs for SHORT, new lows for LONG)
    async validateMomentum(symbol, currentPrice, tradeDirection = 'SHORT', candles = 3) {
        try {
            const numOfCandles = candles;
            // Get one extra candle to exclude the current day's candle
            const recentCandles = await this.getRecentCandles(symbol, numOfCandles + 1);
            
            if (!recentCandles || recentCandles.length < numOfCandles + 1) {
                console.log(`${symbol}: Insufficient candle data for momentum validation`);
                return false; // Conservative approach - reject if no data
            }
            
            // Sort candles by time to ensure proper order (Binance returns oldest first)
            recentCandles.sort((a, b) => a.openTime - b.openTime);
            
            // Show all candles with dates for debugging
            console.log(`${symbol}: Raw candle data (${recentCandles.length} candles, oldest to newest):`);
            recentCandles.forEach((candle, index) => {
                const date = new Date(candle.openTime).toISOString().split('T')[0];
                console.log(`  ${index}: ${date} | High: $${candle.high.toFixed(6)} | Low: $${candle.low.toFixed(6)} | Close: $${candle.close.toFixed(6)}`);
            });
            
            // Exclude the last candle (most recent/current day) and use only previous candles
            const previousCandles = recentCandles.slice(0, -1);
            
            console.log(`${symbol}: Using ${previousCandles.length} previous candles for momentum validation (excluding current day)`);
            previousCandles.forEach((candle, index) => {
                const date = new Date(candle.openTime).toISOString().split('T')[0];
                console.log(`  Previous ${index}: ${date} | High: $${candle.high.toFixed(6)}`);
            });
            
            if (tradeDirection === 'SHORT') {
                // For SHORT traders: Current price should be higher than ALL highs of previous candles
                const maxHigh = Math.max(...previousCandles.map(candle => candle.high));
                const maxHighCandle = previousCandles.find(candle => candle.high === maxHigh);
                const maxHighDate = new Date(maxHighCandle.openTime).toISOString().split('T')[0];
                const isNewHigh = currentPrice > maxHigh;
                
                console.log(`${symbol} SHORT momentum detailed check:`);
                console.log(`  Current price: $${currentPrice.toFixed(6)}`);
                console.log(`  Previous max high: $${maxHigh.toFixed(6)} (from ${maxHighDate})`);
                console.log(`  Is new high: ${isNewHigh ? '✅ YES' : '❌ NO'}`);
                console.log(`  Difference: $${(currentPrice - maxHigh).toFixed(6)}`);
                
                return isNewHigh;
                
            } else if (tradeDirection === 'LONG') {
                // For LONG traders: Current price should be lower than ALL lows of previous candles
                const minLow = Math.min(...previousCandles.map(candle => candle.low));
                const minLowCandle = previousCandles.find(candle => candle.low === minLow);
                const minLowDate = new Date(minLowCandle.openTime).toISOString().split('T')[0];
                const isNewLow = currentPrice < minLow;
                
                console.log(`${symbol} LONG momentum detailed check:`);
                console.log(`  Current price: $${currentPrice.toFixed(6)}`);
                console.log(`  Previous min low: $${minLow.toFixed(6)} (from ${minLowDate})`);
                console.log(`  Is new low: ${isNewLow ? '✅ YES' : '❌ NO'}`);
                console.log(`  Difference: $${(currentPrice - minLow).toFixed(6)}`);
                
                return isNewLow;
            }
            
            return false;
        } catch (error) {
            console.log(`${symbol}: Error validating momentum:`, error.message);
            return false; // Conservative approach - reject on error
        }
    }
    async getFilteredGainersAdvanced(minPercentage = 50, minPrice = 0.01, minAge = 30, limit = 50) {
        try {
            console.log(`Filtering gainers: min ${minPercentage}%, min price $${minPrice}, min age ${minAge} days`);
            
            // Get top gainers first
            const allGainers = await this.getTopGainers(limit);
            
            // Filter by percentage
            const highPercentGainers = allGainers.filter(gainer => 
                parseFloat(gainer.priceChangePercent) >= minPercentage
            );

            // Filter by price
            const priceFilteredGainers = highPercentGainers.filter(gainer => 
                parseFloat(gainer.price) >= minPrice
            );

            // Check contract age for remaining candidates
            const finalGainers = [];
            for (const gainer of priceFilteredGainers) {
                const contractAge = await this.getContractAge(gainer.symbol, minAge);
                if (contractAge >= minAge) {
                    finalGainers.push({
                        ...gainer,
                        contractAge
                    });
                }
                
                // Add small delay to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 100));
            }

            // Sort by percentage change (highest to lowest)
            finalGainers.sort((a, b) => parseFloat(b.priceChangePercent) - parseFloat(a.priceChangePercent));

            console.log(`Found ${finalGainers.length} gainers meeting all criteria`);
            return finalGainers;
        }
        catch(error) {
            console.log('Error in advanced gainer filtering:', error.message);
            throw error;
        }
    }

    async getPositionRisk(symbol = null) {
        try {
            const query = symbol ? [{symbol}] : [];
            return this.authenticatedGet(this.urls.positionRisk, query);
        }
        catch(error) {
            console.log('Error getting position risk:', error.message);
            throw error;
        }
    }

    async getPositionInfo(symbol) {
        try {
            const positions = await this.getPositionRisk(symbol);
            
            if (!positions || positions.length === 0) {
                return {
                    symbol: symbol,
                    positionAmt: '0',
                    entryPrice: '0',
                    markPrice: '0',
                    unRealizedProfit: '0',
                    percentage: '0'
                };
            }

            // Find the position for the specified symbol
            const position = positions.find(pos => pos.symbol === symbol);
            
            if (!position) {
                return {
                    symbol: symbol,
                    positionAmt: '0',
                    entryPrice: '0',
                    markPrice: '0',
                    unRealizedProfit: '0',
                    percentage: '0'
                };
            }

            return {
                symbol: position.symbol,
                positionAmt: position.positionAmt,
                entryPrice: position.entryPrice,
                markPrice: position.markPrice,
                unRealizedProfit: position.unRealizedProfit,
                percentage: position.percentage
            };
        }
        catch(error) {
            console.log(`Error getting position info for ${symbol}:`, error.message);
            return {
                symbol: symbol,
                positionAmt: '0',
                entryPrice: '0',
                markPrice: '0',
                unRealizedProfit: '0',
                percentage: '0'
            };
        }
    }
}

module.exports = { API, Service };