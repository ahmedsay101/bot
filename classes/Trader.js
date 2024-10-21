const { v4: uuidv4 } = require('uuid');
const { Transactions } = require("../schema/transaction.schema");
const { Transaction } = require("./Transaction");
const { Traders } = require("../schema/trader.schema");
const { DB } = require("./DB");

class Trader extends DB {
    constructor(controller, {
        symbol,
        baseAmountIn = 0,
        quoteAmountIn = 0,
        takeProfit = 0,
        stepSize = 0,
        stopLoss = 0,
        type = "IMMORTAL",
        aim = 0,
        leverage = 10,
        lives = 0,
        accumulatedProfit = 0,
        maxMoneyIn = 0
    }) {
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
        this._levels = [];
        this.transactions = [];
        this._baseAmountIn = baseAmountIn;
        this._quoteAmountIn = quoteAmountIn;
        this._aim = aim;
        this._profit = 0;
        this._totalProfit = 0;
        this._leverage = leverage;
        this._fee = 0.001;
        this._stepSize = stepSize;
        this._takeProfit = takeProfit;
        this._stopLoss = stopLoss;
        this._profitTaken = 0;
        this._maxLevels = 1000;
        this._mode = "TESTING";
        this._status = "ACTIVE";
        this._type = type;
        this._lives = lives;
        this.busy = false;
        this._peak = 0;
        this._maxMoneyIn = maxMoneyIn;
        this._accumulatedProfit = accumulatedProfit;
        this._createdAt = new Date();
        this._updatedAt = new Date();
    }

    async generateLevels() {
        try {
            if(this._levels.length < 1) {
                this._levels = [...new Set([Number(this.ticker.currentPrice) + Number(this._stepSize), Number(this.ticker.currentPrice), Number(this.ticker.currentPrice) - Number(this._stepSize)].sort((a, b) => b - a))];
            }
            else if(this._levels.length < this._maxLevels && this._levels.length > 1) {
                const highestPrice = this._levels.sort((a, b) => b - a)[0];
                const lowestPrice = this._levels.sort((a, b) => a - b)[0];
                if(this.ticker.currentPrice >= highestPrice) this._levels = [...new Set([...this._levels, highestPrice + this._stepSize].sort((a, b) => b - a))]; 
                else if(this.ticker.currentPrice <= lowestPrice) this._levels = [...new Set([...this._levels, lowestPrice - this._stepSize].sort((a, b) => b - a))];
            }
        }
        catch(error) {
            console.log(error);
        }
    }

    async sync() {
        try {
            if(this._status !== "ACTIVE" || this.busy) return;
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
            const count = await this.getLevelCount(price);
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
            if(this._profit >= this._aim && this._type === "MORTAL") {
                await this.destroy();
                return;
            }
            await this.controller.tick();
            await this.sync();
            await this.generateLevels();
            await this.fill();
            await this.updateTransactions();
            await this.calculateProfit();
            await this.calculateTotalProfit();
            await this.calculateProfitTaken();
            await this.calculateMoneyIn();
            this.release();
            this.log();
        }
        catch(error) {
            console.log(error);
        }
    }

    log() {
        console.log(`--------------------${this._symbol}-----------------------`);
        console.log("CURRENT PRICE", this.ticker.currentPrice);
        console.log("PRICES", this._levels.sort((a, b) => b - a));
        console.log("TRANSACTIONS", this.transactions.map(obj => ({price: obj._price, profit: obj._profit, side: obj._side, status: obj._status})).sort((a, b) => b.price - a.price));
        console.log("PROFIT", this._profit);
        console.log("PROFIT TAKEN", this._profitTaken);
        console.log("MONEY IN", this._moneyIn);
        console.log("AVG SPEED", this.ticker.avgSpeed);
        console.log("TICKERS", this.controller.tickers.map(obj => ({symbol: obj.symbol, traders: obj.traders.length})));
    }

    async fill() {
        try {
            for(let price of this._levels) {
                const levelTransactions = await this.getLevel(price);
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
        }
        catch(error) {
            console.log(error);
        }
    }

    async destroy(hard = false) {
        try {
            this._status = "STOPPED";
            await this.sync();
            for(let transaction of this.transactions) {
                await transaction.close();
            }
            this.controller.removeTrader(this);
            this.ticker.removeTrader(this);
            if(this._type === "MORTAL" && this._lives > 1 && !hard) await this.revive();
        }
        catch(error) {
            console.log(error);
        }
    }

    async revive() {
        try {
            await this.controller.createTrader({
                symbol: this._symbol,
                baseAmountIn: this._baseAmountIn,
                quoteAmountIn: this._quoteAmountIn,
                accumulatedProfit: Number(this._accumulatedProfit) + Number(this._profit),
                maxMoneyIn: this._maxMoneyIn,
                takeProfit: this._takeProfit,
                stepSize: this._stepSize,
                stopLoss: this._stopLoss,
                mode: this._mode,
                type: this._type,
                leverage: this._leverage,
                aim: this._aim,
                lives: this._lives - 1
            });
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
            if(this._profit > this._peak) this._peak = this._profit;
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
            if(this._moneyIn > this._maxMoneyIn) this._maxMoneyIn = this._moneyIn;
        }
        catch(error) {
            console.log(error);
        }
    }

    async getLevel(price) {
        try {
            const transactions = await Transactions.aggregate([
            {$match: {traderId: this._id, price, status: {$ne: "CLOSED"}}},
            {$project: {_id: 1, price: 1, side: 1}}
            ]);
            return transactions;
        }  
        catch(error) {
            console.log(error);
        }
    } 

    async getTransactions() {
        try {
            const transactions = await Transactions.aggregate([
                {$match: {traderId: this._id}},
                {$project: {_id: 1, price: 1, side: 1, status: 1}}
            ]);
            return transactions;
        }  
        catch(error) {
            console.log(error);
        }
    } 

    async getClosedCount() {
        try {
            const count = await Transactions.countDocuments({traderId: this._id, status: "CLOSED"});
            return count;
        }  
        catch(error) {
            console.log(error);
        }
    } 

    async getLevelCount(price) {
        try {
            const count = await Transactions.countDocuments({traderId: this._id, price, status: {$ne: "CLOSED"}});
            return count;
        }  
        catch(error) {
            console.log(error);
        }
    }

    async getTransactionsCount() {
        try {
            const count = await Transactions.countDocuments({traderId: this._id, status: {$ne: "CLOSED"}});
            return count;
        }  
        catch(error) {
            console.log(error);
        }
    }
}

module.exports = { Trader };
