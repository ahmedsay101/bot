const { Service } = require("./API");
const { v4: uuidv4 } = require('uuid');
const { Transactions } = require("../schema/transaction.schema");
const { Ticker } = require("./Ticker");
const { Transaction } = require("./Transaction");
const { Traders } = require("../schema/trader.schema");
const { DB } = require("./DB");
const { hoursPassed } = require("../lib/utils");

class Trader extends DB {
    constructor(controller, symbol) {
        super(Traders);
        this.id = uuidv4();
        this._id = null;
        this._symbol = symbol;
        this.controller = controller;
        this.controller.addTrader(this);
        this.service = this.controller.service;
        this.ticker = this.controller.tickers.find(one => one.symbol === this._symbol);
        this.ticker.addTrader(this);
        this._moneyIn = 0;
        this._prices = [];
        this.transactions = [];
        this._baseAmountIn = 0;
        this._quoteAmountIn = 0;
        this._aim = 1;
        this._profit = 0;
        this._totalProfit = 0;
        this._leverage = 0;
        this._fee = 0.001;
        this._stepSize = 200;
        this._takeProfit = 200;
        this._stopLoss = 400;
        this._profitTaken = 0;
        this._mode = "TESTING";
        this._status = "ACTIVE";
        this.busy = false;
        this._createdAt = new Date();
        this._updatedAt = new Date();
    }

    async generatePrices() {
        try {
            if(this._prices.length < 1 && this.ticker.avgSpeed > 0) {
                this._prices = [...new Set([this.ticker.currentPrice + this._stepSize, this.ticker.currentPrice - this._stepSize].sort((a, b) => b - a))];
            }
            /*if(this._prices.length < 1) {
                this._prices = [...new Set([this.ticker.currentPrice + this._stepSize, this.ticker.currentPrice, this.ticker.currentPrice - this._stepSize].sort((a, b) => b - a))];
            }
            else {
                const highestPrice = this._prices.sort((a, b) => b - a)[0];
                const lowestPrice = this._prices.sort((a, b) => a - b)[0];
                if(this.ticker.currentPrice >= highestPrice) this._prices = [...new Set([...this._prices, highestPrice + this._stepSize].sort((a, b) => b - a))]; 
                else if(this.ticker.currentPrice <= lowestPrice) this._prices = [...new Set([...this._prices, lowestPrice - this._stepSize].sort((a, b) => b - a))]; 
            }*/
        }
        catch(error) {
            console.log(error);
        }
    }

    async sync() {
        try {
            await this.dbSync();
            if(this.transactions.length < 1) {
                const transactions = await Transactions.aggregate([
                    {$match: {traderId: this._id, status: {$ne: "CLOSED"}}},
                    {$project: {_id: 1}}
                ]).exec();

                for(let obj of transactions) {
                    const transaction = new Transaction(this);
                    await transaction.fromId(obj._id);
                }
            }
        } 
        catch(error) {
          console.log(error);
        }
    }

    async updateTransactions() {
        try {
            if(this._status === "ACTIVE") {
                for(let transaction of this.transactions) {
                    await transaction.tick();
                }
            }
        } 
        catch(error) {
          console.log(error);
        }
    }

    addTransaction(transaction) {
        if(this.transactions.filter(one => one.id === transaction.id).length < 1) {
            this.transactions = [...this.transactions, transaction];
        }
    }

    removeTransaction(transaction) {
        try {
            this.transactions = this.transactions.filter(obj => obj.id !== transaction.id);
        }
        catch(error) {
            console.log(error);
        }

    }

    async newTransaction({side, price = null}) {
        try {
            const count = await Transaction.getLevelCount(this._id, price);
            if(count >= 2 || this._status !== "ACTIVE") return false;
            const transaction = new Transaction(this);
            transaction._side = side;
            transaction._price = price ? price : this.ticker.currentPrice;
            await transaction.sync();
            return transaction;
        }
        catch(error) {
            console.log(error);
        }
    }

    async setLeverage(leverage = 1) {
        try {
            if(!this.symbol || this.mode === "TESTING") return;
            this.leverage = leverage;
            await this.service.leverage(this.symbol, this.leverage);
            console.log(`Leverage set for ${this.symbol}: ${this.leverage}`);
        }
        catch(error) {
            console.log(error);
        }
    }

    hold() {
        this.busy = true;
    }

    release() {
        this.busy = false;
    }

    async tick() {
        try {
            if(!this._id || !this._symbol || !this.ticker || !this.ticker.currentPrice || this._status !== "ACTIVE" || this.busy) return;
            this.hold();
            if(this._mode === "LIVE" && !this._leverage) await this.setLeverage();
            if(this._baseAmountIn === 0 || !this._baseAmountIn) this._baseAmountIn = this._quoteAmountIn / this.ticker.currentPrice;
            if(this._quoteAmountIn === 0 || !this._quoteAmountIn) this._quoteAmountIn = this._baseAmountIn * this.ticker.currentPrice;
            await this.sync();
            await this.generatePrices();
            for(let price of this._prices) {
                const levelTransactions = await Transaction.getLevel(this._id, price);
                console.log("LEVEL TRANSACTIONS", levelTransactions);
                if(levelTransactions.length < 2) {
                    const long = levelTransactions.find(transaction => transaction.side === "LONG") || null;
                    const short = levelTransactions.find(transaction => transaction.side === "SHORT") || null;

                    if(this.ticker.currentPrice > price && !short && Math.abs(this.ticker.currentPrice - price) >= this.ticker.avgSpeed && this.ticker.avgSpeed > 0) {
                        await this.newTransaction({side: "SHORT", price});
                    }
                    else if(this.ticker.currentPrice < price && !long && Math.abs(this.ticker.currentPrice - price) >= this.ticker.avgSpeed && this.ticker.avgSpeed > 0) {
                        await this.newTransaction({side: "LONG", price});
                    }        
                }       
            }
            await this.updateTransactions();
            await this.calculateProfit();
            await this.calculateTotalProfit();
            await this.calculateProfitTaken();
            await this.calculateMoneyIn();
            console.log(`--------------------${this._symbol}-----------------------`);
            console.log("CURRENT PRICE", this.ticker.currentPrice);
            console.log("PRICES", this._prices.sort((a, b) => b - a));
            console.log("TRANSACTIONS", this.transactions.map(obj => ({price: obj._price, profit: obj._profit, side: obj._side, status: obj._status})).sort((a, b) => b.price - a.price));
            console.log("PROFIT", this._profit);
            console.log("PROFIT TAKEN", this._profitTaken);
            console.log("MONEY IN", this._moneyIn);
            console.log("AVG SPEED", this.ticker.avgSpeed);
            console.log("TICKERS", this.controller.tickers.map(obj => ({symbol: obj.symbol, traders: obj.traders.length})));
            await this.sync();
            if(Number(this._profit) >= Number(this._aim)) await this.destroy();
            this.release();
        }
        catch(error) {
            console.log(error);
        }
    }

    async destroy() {
        try {
            this._status = "STOPPED";
            await this.sync();
            for(let transaction of this.transactions) {
                await transaction.close();
            }
        }
        catch(error) {
            console.log(error);
        }
    }

    async calculateProfit() {
        try {
            const results = await Transactions.aggregate([
                {$match: {traderId: this._id}},
                {$group: {
                  _id: null,
                  totalProfit: { $sum: "$profit" },
                }}
            ]).exec();
            this._profit = results && results.length > 0 ? Number(results[0].totalProfit) : 0;
        }
        catch(error) {
            console.log(error);
        }
    }

    async calculateTotalProfit() {
        try {
            const results = await Transactions.aggregate([
                {$match: {symbol: this._symbol}},
                {$group: {
                  _id: null,
                  totalProfit: { $sum: "$profit" },
                }}
            ]).exec();
            this._totalProfit = results && results.length > 0 ? Number(results[0].totalProfit) : 0;
        }
        catch(error) {
            console.log(error);
        }
    }
    async calculateProfitTaken() {
        try {
            const results = await Transactions.aggregate([
                {$match: {traderId: this._id, status: "CLOSED"}},
                {$group: {
                  _id: null,
                  totalProfit: { $sum: "$profit" },
                }}
            ]).exec();
            this._profitTaken = results && results.length > 0 ? Number(results[0].totalProfit) : 0;
        }
        catch(error) {
            console.log(error);
        }
    }

    async calculateMoneyIn() {
        try {
            const results = await Transactions.aggregate([
                {$match: {traderId: this._id, status: "FILLED"}},
                {$group: {
                  _id: null,
                  moneyIn: { $sum: "$quoteAmountIn" },
                }}
            ]).exec();
            const money = results && results.length > 0 ? Number(results[0].moneyIn) : 0;
            this._moneyIn = Number(money);
        }
        catch(error) {
            console.log(error);
        }
    }
}

module.exports = { Trader };
