const cron = require('node-cron');
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
        stopLoss = 0,
        takeProfitStep = 1,
        stepSize = 0,
        aim = 0,
        leverage = 10,
        accumulatedProfit = 0,
        starts = "NOW",
        mode = "TESTING",
        levels = []
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
        this._levels = levels;
        this.transactions = [];
        this._baseAmountIn = baseAmountIn;
        this._quoteAmountIn = quoteAmountIn;
        this._aim = aim;
        this._profit = 0;
        this._totalProfit = 0;
        this._leverage = leverage;
        this._fee = 0.001;
        this._stepSize = stepSize;
        this._takeProfit = Number(takeProfit);
        this._stopLoss = Number(stopLoss);
        this._currentTakeProfit = Number(takeProfit);
        this._takeProfitStep = Number(takeProfitStep);
        this._readyToTakeProfit = false;
        this._profitTaken = 0;
        this._maxLevels = 1000;
        this._mode = mode;
        this._status = "ACTIVE";
        this._starts = starts;
        this._currentRounds = 0;
        this.busy = false;
        this._peak = 0;
        this._accumulatedProfit = accumulatedProfit;
        this._createdAt = new Date();
        this._updatedAt = new Date();
        this.overwrite = ["levels", "profit"];
    }

    async generateLevels() {
        try {
            if(this._levels.length < 1) {
                this._levels = [...new Set([
                    this.ticker.getQuoteQuantity(Number(this.ticker.currentPrice) + (Number(this._stepSize) * 5)),
                    this.ticker.getQuoteQuantity(Number(this.ticker.currentPrice) + (Number(this._stepSize) * 4)),
                    this.ticker.getQuoteQuantity(Number(this.ticker.currentPrice) + (Number(this._stepSize) * 3)),
                    this.ticker.getQuoteQuantity(Number(this.ticker.currentPrice) + (Number(this._stepSize) * 2)),
                    this.ticker.getQuoteQuantity(Number(this.ticker.currentPrice) + (Number(this._stepSize) * 1)),
                    this.ticker.getQuoteQuantity(Number(this.ticker.currentPrice)), 
                    this.ticker.getQuoteQuantity(Number(this.ticker.currentPrice) - (Number(this._stepSize) * 1)),
                    this.ticker.getQuoteQuantity(Number(this.ticker.currentPrice) - (Number(this._stepSize) * 2)),
                    this.ticker.getQuoteQuantity(Number(this.ticker.currentPrice) - (Number(this._stepSize) * 3)),
                    this.ticker.getQuoteQuantity(Number(this.ticker.currentPrice) - (Number(this._stepSize) * 4)),
                    this.ticker.getQuoteQuantity(Number(this.ticker.currentPrice) - (Number(this._stepSize) * 5)),
                ].sort((a, b) => b - a))];
            }
            else if(this._levels.length < this._maxLevels && this._levels.length > 1) {
                const highestPrice = this._levels.sort((a, b) => b - a)[1];
                const lowestPrice = this._levels.sort((a, b) => a - b)[1];
                if(this.ticker.currentPrice >= highestPrice) this._levels = [...new Set([
                    ...this._levels, 
                    this.ticker.getQuoteQuantity(Number(highestPrice) + Number(this._stepSize)),
                    this.ticker.getQuoteQuantity(Number(highestPrice) + (Number(this._stepSize) * 2)),
                    this.ticker.getQuoteQuantity(Number(highestPrice) + (Number(this._stepSize) * 3)),
                    this.ticker.getQuoteQuantity(Number(highestPrice) + (Number(this._stepSize) * 4)),
                    this.ticker.getQuoteQuantity(Number(highestPrice) + (Number(this._stepSize) * 5)),
                ].sort((a, b) => b - a))]; 
                else if(this.ticker.currentPrice <= lowestPrice) this._levels = [...new Set([
                    ...this._levels, 
                    this.ticker.getQuoteQuantity(Number(lowestPrice) - Number(this._stepSize)),
                    this.ticker.getQuoteQuantity(Number(lowestPrice) - (Number(this._stepSize) * 2)),
                    this.ticker.getQuoteQuantity(Number(lowestPrice) - (Number(this._stepSize) * 3)),
                    this.ticker.getQuoteQuantity(Number(lowestPrice) - (Number(this._stepSize) * 4)),
                    this.ticker.getQuoteQuantity(Number(lowestPrice) - (Number(this._stepSize) * 5)),
                ].sort((a, b) => b - a))];
            }
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

    async newTransaction({side, price = null, baseAmountIn = null, isFake = false}) {
        try {
            if(this._status !== "ACTIVE") return false;
            const transaction = new Transaction(this);
            transaction._isFake = isFake;
            transaction._side = side;
            transaction._price = price ? price : this.ticker.currentPrice;
            transaction._baseAmountIn = baseAmountIn ? baseAmountIn : this._baseAmountIn;
            await transaction.sync();
            return transaction;
        }
        catch(error) {
            console.log(error);
        }
    }

    async setLeverage() {
        try {
            if(!this._symbol || this._mode !== "LIVE") return;
            await this.service.leverage(this._symbol, this._leverage);
            console.log(`Leverage set for ${this._symbol}: ${this._leverage}`);
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

    canTick() {
        let can = this._id && this._symbol && this.ticker && this.ticker.currentPrice && this._status === "ACTIVE" && !this.busy;
        return can;
    }

    async tick() {
        try {
            if(!this.canTick()) return;
            this.hold();
            if(this._mode === "LIVE" && this.transactions.length < 1) await this.setLeverage();
            if(this._baseAmountIn === 0 || !this._baseAmountIn) this._baseAmountIn = this._quoteAmountIn / this.ticker.currentPrice;
            if(this._quoteAmountIn === 0 || !this._quoteAmountIn) this._quoteAmountIn = this.ticker.getQuoteQuantity(this._baseAmountIn * this.ticker.currentPrice);
            if(this._currentAmountIn === 0) this._currentAmountIn = this._baseAmountIn;
            await this.controller.tick();
            await this.generateLevels();
            await this.sync();
            await this.fill();
            await this.updateTransactions();
            await this.calculateProfit();
            await this.calculateTotalProfit();
            await this.calculateProfitTaken();
            await this.calculateMoneyIn();
            this.log();
            this.release();
        }
        catch(error) {
            console.log(error);
        }
    }

    async fill() {
        try {
            for(let price of this._levels) {
                const levelTransactions = await this.getLevel(price);
                if(levelTransactions.length < 2) {
                    const long = levelTransactions.find(transaction => transaction.side === "LONG") || null;
                    const short = levelTransactions.find(transaction => transaction.side === "SHORT") || null;
                    if(this.ticker.currentPrice <= (Number(price) - Number(this._stepSize)) && !long) {
                        await this.newTransaction({side: "LONG", price});
                    }
                    else if(this.ticker.currentPrice >= (Number(price) + Number(this._stepSize)) && !short) {
                        await this.newTransaction({side: "SHORT", price});
                    }    
                }       
            }
        }
        catch(error) {
            console.log(error);
        }
    }

    async destroy() {
        try {
            this._status = "STOPPED";
            await Promise.all(this.transactions.map(async (transaction) => {
                await transaction.close();
            }));
            this.transactions = [];
            this.levels = [];
            this.controller.removeTrader(this);
            this.ticker.removeTrader(this);
            await this.sync();
        }
        catch(error) {
            console.log(error);
        }
    }

    async revive() {
        try {
            if(this._status === "STOPPED") return;
            await this.destroy();
            await this.controller.createTrader({
                symbol: this._symbol,
                takeProfit: this._takeProfit,
                baseAmountIn: this._baseAmountIn,
                quoteAmountIn: this._quoteAmountIn,
                stepSize: this._stepSize,
                stopLoss: this._stopLoss,
                mode: this._mode,
                leverage: this._leverage,
                takeProfitStep: this._takeProfitStep,
            });
        }
        catch(error) {
            console.log(error);
        }
    }

    async calculateProfit() {
        try {
            const results = await Transactions.aggregate([
                {$match: {traderId: this._id, isFake: false}},
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
                {$match: {symbol: this._symbol, isFake: false}},
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
                {$match: {traderId: this._id, isFake: false, status: "CLOSED"}},
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
                {$match: {traderId: this._id, isFake: false, status: "FILLED"}},
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
