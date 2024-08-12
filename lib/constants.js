
exports.markets = [
    {
        symbol: "SOLUSDT",
        pairs: ["SOL", "USDT"],
        stepSize: 0.00100000,
        decimals: 8,
        getQuantity(qty) {
            let quantity = Math.floor(qty / this.stepSize);
            quantity = quantity * this.stepSize;
            return parseFloat(quantity).toFixed(this.decimals);
        }
    },
    {
        symbol: "UNIUSDT",
        pairs: ["UNI", "USDT"],
        stepSize: 0.01000000,
        decimals: 8,
        getQuantity(qty) {
            let quantity = Math.floor(qty / this.stepSize);
            quantity = quantity * this.stepSize;
            return parseFloat(quantity).toFixed(this.decimals);
        }
    },
    {
        symbol: "UNIUSDT",
        pairs: ["UNI", "USDT"],
        stepSize: 0.01000000,
        decimals: 8,
        getQuantity(qty) {
            let quantity = Math.floor(qty / this.stepSize);
            quantity = quantity * this.stepSize;
            return parseFloat(quantity).toFixed(this.decimals);
        }
    },
    {
        symbol: "NOTUSDT",
        pairs: ["NOT", "USDT"],
        stepSize: 1.00,
        baseDecimals: 2,
        quoteDecimals: 8,
        getQuoteQuantity(qty) {
            return parseFloat(qty).toFixed(this.quoteDecimals);
        },
        getBaseQuantity(qty) {
            let quantity = Math.floor(qty / this.stepSize);
            quantity = quantity * this.stepSize;
            return parseFloat(quantity).toFixed(this.baseDecimals);
        }
    },
    {
        symbol: "NOTBNB",
        pairs: ["NOT", "BNB"],
        stepSize: 1.00,
        baseDecimals: 2,
        quoteDecimals: 8,
        getQuoteQuantity(qty) {
            return parseFloat(qty).toFixed(this.quoteDecimals);
        },
        getBaseQuantity(qty) {
            let quantity = Math.floor(qty / this.stepSize);
            quantity = quantity * this.stepSize;
            return parseFloat(quantity).toFixed(this.baseDecimals);
        }
    },
    {
        symbol: "BNBUSDT",
        pairs: ["BNB", "USDT"],
        stepSize: 0.00100000,
        baseDecimals: 8,
        quoteDecimals: 8,
        getQuoteQuantity(qty) {
            return parseFloat(qty).toFixed(this.quoteDecimals);
        },
        getBaseQuantity(qty) {
            let quantity = Math.floor(qty / this.stepSize);
            quantity = quantity * this.stepSize;
            return parseFloat(quantity).toFixed(this.baseDecimals);
        }
    },
    {
        symbol: "RAYBNB",
        pairs: ["RAY", "BNB"],
        stepSize: 0.10000000,
        baseDecimals: 8,
        quoteDecimals: 8,
        getQuoteQuantity(qty) {
            return parseFloat(qty).toFixed(this.quoteDecimals);
        },
        getBaseQuantity(qty) {
            let quantity = Math.floor(qty / this.stepSize);
            quantity = quantity * this.stepSize;
            return parseFloat(quantity).toFixed(this.baseDecimals);
        }
    },
    {
        symbol: "RAYUSDT",
        pairs: ["RAY", "USDT"],
        stepSize: 0.10000000,
        baseDecimals: 8,
        quoteDecimals: 8,
        getQuoteQuantity(qty) {
            return parseFloat(qty).toFixed(this.quoteDecimals);
        },
        getBaseQuantity(qty) {
            let quantity = Math.floor(qty / this.stepSize);
            quantity = quantity * this.stepSize;
            return parseFloat(quantity).toFixed(this.baseDecimals);
        }
    },
    {
        symbol: "NOTTRY",
        pairs: ["NOT", "TRY"],
        stepSize: 1.00,
        baseDecimals: 2,
        quoteDecimals: 8,
        getQuoteQuantity(qty) {
            return parseFloat(qty).toFixed(this.quoteDecimals);
        },
        getBaseQuantity(qty) {
            let quantity = Math.floor(qty / this.stepSize);
            quantity = quantity * this.stepSize;
            return parseFloat(quantity).toFixed(this.baseDecimals);
        }
    },
    {
        symbol: "USDTTRY",
        pairs: ["USDT", "TRY"],
        stepSize: 1.00000000,
        baseDecimals: 8,
        quoteDecimals: 8,
        getQuoteQuantity(qty) {
            return parseFloat(qty).toFixed(this.quoteDecimals);
        },
        getBaseQuantity(qty) {
            let quantity = Math.floor(qty / this.stepSize);
            quantity = quantity * this.stepSize;
            return parseFloat(quantity).toFixed(this.baseDecimals);
        }
    },
]

exports.findMarketBySymbol = (symbol) => this.markets.find(one => one.symbol === symbol);