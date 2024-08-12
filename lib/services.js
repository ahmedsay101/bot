require("dotenv").config();
const { default: axios } = require("axios");
const { createHmac } = require("crypto");

const instance = axios.create({
    baseURL: process.env.BASE_URL,
    headers: {
        'X-MBX-APIKEY': process.env.API_KEY,
        "SecretKey": process.env.SECRET_KEY,
        "Content-Type": "application/x-www-form-urlencoded",
    }
});

const buildQuery = (query) => `${query && query.length > 0 ? "?" : ""}${query && query.length > 0 ? query.map(obj => `${Object.keys(obj)[0]}=${obj[Object.keys(obj)[0]]}`).join("&") : ""}`;

const buildSignature = (data) => {
    return createHmac('sha256', process.env.SECRET_KEY).update(data).digest('hex');
};

const getQueryString = async(query) => {
    let queryString = buildQuery([...query, {recvWindow: 5000}]);
    const timestamp = await this.getTimeStamp();
    queryString+=`&timestamp=${timestamp}`;
    const signature = buildSignature(queryString.replace(/\?/g, ""));
    queryString+= `&signature=${signature}`;
    return queryString;
}

const getPayload = async(body) => {
    const payload = {...body};
    const timestamp = await this.getTimeStamp();
    payload["timestamp"] = timestamp;

    const signaturePayload = buildQuery(Object.keys(payload).map(key => {
        const pair = {};
        pair[key] = payload[key];
        return pair;
    })).replace(/\?/g, "");

    const signature = buildSignature(signaturePayload);    
    payload["signature"] = signature;
    return payload;
}


exports.getTimeStamp = async() => {
    try {
        const timestampResponse = await instance.get("/time");
        const timestamp = timestampResponse.data.serverTime;
        return timestamp;
    }
    catch(error) {
        console.log(error);
        throw error;
    }
}

exports.authenticatedGet = async(url, query = []) => {
    try {
        const queryString = await getQueryString(query);
        const link = `${url}${queryString}`;
        const response = await instance.get(link);
        return response.data;
    }
    catch(error) {
        console.log(error);
        throw(error);
    }
}

exports.get = async(url, query = []) => {
    try {
        const queryString = buildQuery(query);
        const link = `${url}${queryString}`;
        const response = await instance.get(link);
        return response.data;
    }
    catch(error) {
        console.log(error);
        throw(error);
    }
}

exports.authenticatedPost = async(url, body, query = []) => {
    try {
        const payload = await getPayload(body);
        const response = await instance.post(url, payload);
        return response.data;
    }
    catch(error) {
        console.log(error);
        throw(error);
    }
}

exports.post = async(url, body, query = []) => {
    try {
        const response = await instance.post(url, body);
        return response.data;
    }
    catch(error) {
        console.log(error);
        throw(error);
    }
}

exports.getInfo = async() => {
    try {
        return this.get("/exchangeInfo");
    }
    catch(error) {
        console.log(error);
        throw(error);
    }
}

exports.getOrderLimits = async() => {
    try {
        return this.authenticatedGet("/rateLimit/order");
    }
    catch(error) {
        console.log(error);
        throw(error);
    }
}


exports.getPrice = async(symbols) => {
    try {
        const query = Array.isArray(symbols) && symbols.length > 0 ? {symbols: JSON.stringify(symbols)} : {symbol: symbols};
        return this.get("/ticker/price", [query]);
    }
    catch(error) {
        throw error;
    }
}

exports.getOrderBook = async(symbols, limit = 10) => {
    try {
        const query = Array.isArray(symbols) && symbols.length > 0 ? {symbols: JSON.stringify(symbols)} : {symbol: symbols};
        if(limit) query["limit"] = limit;
        return this.get("/depth", [query]);
    }
    catch(error) {
        throw error;
    }
}

exports.getQuantity = async(symbol, amountIn) => {
    try {
        const {price} = await this.get("/ticker/price", [{symbol}]);
        let quantity = amountIn / price;
        const market = findMarketBySymbol(symbol);
        quantity = market.getQuantity(quantity);
        return quantity;
    }
    catch(error) {
        throw error;
    }
}

exports.getAccount = async() => {
    try {
        return this.authenticatedGet("/account", [{omitZeroBalances: true}]);
    }
    catch(error) {
        throw error;
    }
}

exports.order = async(data) => {
    try {
        const payload = {
            ...data
        }
        return this.authenticatedPost("/order", payload);
    }
    catch(error) {
        throw error;
    }
}

exports.buy = async({symbol, type = "MARKET", quantity}) => {
    try {
        const payload = {
            symbol, 
            side: "BUY",
            type,
            quantity,
        }
        return this.authenticatedPost("/order", payload);
    }
    catch(error) {
        throw error;
    }
}

exports.sell = async({symbol, type = "MARKET", quantity}) => {
    try {
        const payload = {
            symbol, 
            side: "SELL",
            type,
            quantity,
        }
        return this.authenticatedPost("/order", payload);
    }
    catch(error) {
        throw error;
    }
}