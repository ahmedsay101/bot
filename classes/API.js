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
            leverage: "/leverage",
            openOrders: "/openOrders",
            allOrders: "/allOrders",
            getQuote: "/getQuote",
            klines: "/klines",
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

    async leverage(symbol, leverage) {
        try {
            const payload = {
                symbol, leverage
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
}

module.exports = { API, Service };