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
            account: "/account",
            order: "/order",
            batchOrders: "/batchOrders",
            leverage: "/leverage",
            openOrders: "/openOrders",
            allOrders: "/allOrders",
            getQuote: "/getQuote",
            klines: "/klines",
            ticker24hr: "/ticker/24hr",
            positionRisk: "/positionRisk",
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

    async authenticatedDelete(url, body, query = []) {
        try {
            const payload = await this.getPayload(body);
            const response = await this.instance.delete(url, {data: payload});
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

    async getAccount() {
        try {
            return this.authenticatedGet(this.urls.account, [{omitZeroBalances: true}]);
        }
        catch(error) {
            throw error;
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