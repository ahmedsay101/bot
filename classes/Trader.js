const { Service } = require("./API");
const { v4: uuidv4 } = require('uuid');
const { Transactions } = require("../schema/transaction.schema");
const { Ticker } = require("./Ticker");
const { Transaction } = require("./Transaction");
const { Traders } = require("../schema/trader.schema");
const { hoursPassed } = require("../lib/utils");

class Trader {
    constructor({
        symbol = null, 
        controller = null,
        baseAmountIn = 1, 
        quoteAmountIn = 0, 
        mode = "TESTING", 
        leverage = 10,
        maxTransactions = 10, 
        maxShifts = 0
    }) {
        this._id = null;
        this.id = uuidv4();
        this.mode = mode;
        this.service = new Service("futures");
        this.controller = controller;
        if(this.controller) this.controller.addTrader(this);
        this.symbol = symbol;
        this.leverage = leverage;
        this.baseAmountIn = baseAmountIn;
        this.quoteAmountIn = quoteAmountIn; 
        this.transactions = [];
        this.moneyIn = 0;
        this.totalProfit = 0;
        this.profit = 0;
        this.shifts = 0;
        this.maxShifts = maxShifts;
        this.fee = 0.001;
        this.acceptableProfit = 0;
        this.acceptableLoss = 0;
        this.profitMultiplier = 5;
        this.ttl = Math.floor(this.profitMultiplier / 2);
        this.maxTransactions = maxTransactions;
        this.status = "ACTIVE";
        this.startedAt = new Date();
        this.updatedAt = new Date();

        this.offGrid = false;

        if(this.mode === "LIVE") this.setLeverage();
        this.ticker = new Ticker(this);
    }

    async fromId(_id) {
        this._id = _id;
        await this.get();
    }

    async save() {
        try {
            if(this._id) {
                const data = {};
                if(this.symbol) data["symbol"] = this.symbol;
                if(this.baseAmountIn) data["baseAmountIn"] = this.baseAmountIn;
                if(this.quoteAmountIn) data["quoteAmountIn"] = this.quoteAmountIn;
                if(this.mode) data["mode"] = this.mode;
                if(this.leverage) data["leverage"] = this.leverage;
                if(this.maxTransactions) data["maxTransactions"] = this.maxTransactions;
                if(this.fee) data["fee"] = this.fee;
                if(this.ttl) data["ttl"] = this.ttl;
                if(this.profit) data["profit"] = this.profit;
                if(this.shifts) data["shifts"] = this.shifts;
                if(this.maxShifts) data["maxShifts"] = this.maxShifts;
                if(this.profitMultiplier) data["profitMultiplier"] = this.profitMultiplier;
                if(this.status) data["status"] = this.status;

                if(Object.keys(data).length > 0) {
                    const trader = await Traders.findByIdAndUpdate(this._id, data);
                    return trader;
                }
                    return false;
                }
            else {
            let dbData = {
                symbol: this.symbol, 
                baseAmountIn: this.baseAmountIn, 
                mode: this.mode, 
                leverage: this.leverage,
                maxTransactions: this.maxTransactions,
                shifts: this.shifts,
                fee: this.fee,
                profit: this.profit ? this.profit : 0, 
                status: this.status,
                ttl: this.ttl,
                createdAt: this.createdAt,
                updatedAt: this.updatedAt,
            };

            const trader = await Traders.create(dbData);
            if(trader) this._id = trader._id;
            return trader;
            }
        } catch (err) {
            console.log(err);
            throw err;
        }
    }
    
    async get() {
        try {
            if(!this._id) return false;
            const trader = await Traders.findById(this._id);
            this._id = trader._id;
            this.symbol = trader.symbol;
            this.baseAmountIn = Number(trader.baseAmountIn);
            this.quoteAmountIn = Number(trader.quoteAmountIn);
            this.mode = trader.mode;
            this.leverage = Number(trader.leverage);
            this.maxTransactions = Number(trader.maxTransactions);
            this.profitMultiplier = Number(trader.profitMultiplier);
            this.fee = Number(trader.fee);
            this.profit = Number(trader.profit);
            this.shifts = Number(trader.shifts);
            this.ttl = Number(trader.ttl);
            this.maxShifts = trader.maxShifts;
            this.status = trader.status;
            this.createdAt = new Date(trader.createdAt);
            this.updatedAt = new Date(trader.updatedAt);
            this.tick();

            return trader;
        } catch (err) {
            throw err;
        }
    }

    async setLeverage() {
        try {
            if(this.status === "STOPPED") return;
            await this.service.leverage(this.symbol, this.leverage);
            console.log(`Leverage set for ${this.symbol}: ${this.leverage}`);
        }
        catch(error) {
            console.log(error);
        }
    }

    async setTransactions() {
        try {
            this.transactions = await Transaction.getOpenTransactionsBySymbol(this);
        }
        catch(error) {
            console.log(error);
        }
    }

    isFull() {
        return this.transactions.length === this.maxTransactions;
    }

    addTransaction(transaction) {
        if(this.transactions.filter(one => one.id === transaction.id).length < 1 && transaction.status !== "CLOSED") {
            this.transactions = [...this.transactions, transaction];
        }
    }

    orderByPrice() {
        return this.transactions.sort((a, b) => b.price - a.price);
    }

    orderByProfit() {
        return this.transactions.sort((a, b) => Math.abs(b.profit) -  Math.abs(a.profit));
    }

    getFirstTransaction(side) {
        const transaction = side === "LONG" ? this.transactions.filter(obj => obj.side === "LONG").sort((a, b) => b.price - a.price)[0] 
        : side === "SHORT" ? this.transactions.filter(obj => obj.side === "SHORT").sort((a, b) => a.price - b.price)[0] 
        : this.transactions.sort((a, b) => Math.abs(b.profit) - Math.abs(a.profit))[0];
        return transaction;
    }

    async removeTransaction(transaction) {
        try {
            let isFirstTransaction = this.getFirstTransaction(transaction.side).id === this.id; 
            this.transactions = this.transactions.filter(obj => obj.id !== transaction.id);
            if(!isFirstTransaction) await this.hedge();
        }
        catch(error) {
            console.log(error);
        }

    }

    async newTransaction(side = "LONG") {
        try {
            if(this.status === "STOPPED") return;
            const sameTransactionInRange = this.transactions.find(one => Math.abs(one.profit) <= Number((this.quoteAmountIn * this.fee)) && one.side === side);
            if(sameTransactionInRange || this.isFull()) return false;

            const data = {
                symbol: this.symbol,
                price: this.ticker.currentPrice,
                side,
                type: "MARKET",
                baseAmountIn: this.baseAmountIn,
                quoteAmountIn: this.baseAmountIn * this.ticker.currentPrice,
                mode: this.mode,
                status: "NEW",
            };

            const transaction = new Transaction(this, data);
            await transaction.save();
        }
        catch(error) {
            console.log(error);
            throw error;
        }
    }

    async hedge() {
        try {
            if(this.status === "STOPPED") return;
            if(this.maxTransactions - this.transactions.length < 2) return false;
            await this.newTransaction("LONG");
            await this.newTransaction("SHORT");
        }
        catch(error) {
            console.log(error);
            throw error;
        }
    }

    async destroy() {
        try {
            this.stop();
            for(let transaction of this.transactions) {
                await transaction.close();
            }
        }
        catch(error) {
            console.log(error);
            throw error;
        }
    }

    async calculateTotalProfit() {
        try {
            const results = await Transactions.aggregate([
                {$match: {symbol: this.symbol}},
                {$group: {
                  _id: null,
                  totalProfit: { $sum: "$profit" },
                }}
            ]).exec();
            const profit = results && results.length > 0 ? Number(results[0].totalProfit) : 0;
            this.totalProfit = profit;
        }
        catch(error) {
            console.log(error);
        }
    }

    async calculateProfit() {
        try {
            const results = await Transactions.aggregate([
                {$match: {traderId: this._id, symbol: this.symbol}},
                {$group: {
                  _id: null,
                  totalProfit: { $sum: "$profit" },
                }}
            ]).exec();
            const profit = results && results.length > 0 ? Number(results[0].totalProfit) : 0;
            this.profit = profit;
        }
        catch(error) {
            console.log(error);
        }
    }

    async calculateMoneyIn() {
        try {
            const results = await Transactions.aggregate([
                {$match: {traderId: this._id, symbol: this.symbol, status: "FILLED"}},
                {$group: {
                  _id: null,
                  moneyIn: { $sum: "$quoteAmountIn" },
                }}
            ]).exec();
            const money = results && results.length > 0 ? Number(results[0].moneyIn) : 0;
            this.moneyIn = Number(money);
        }
        catch(error) {
            console.log(error);
        }
    }

    async calculateShifts() {
        try {
            const count = await Transactions.countDocuments({traderId: this._id, symbol: this.symbol, status: "CLOSED", profit: {$lt: 0}, shifted: true});
            this.shifts = count;
        }
        catch(error) {
            console.log(error);
        }
    }

    async updateTransactions() {
        if(this.status === "STOPPED") return;
        if(this.transactions.length > 0) {
            for(let trx of this.transactions) {
                await trx.tick();
            }
        }
    }

    async tick() {
        try {
            await this.save();
            if(this.status === "STOPPED") return;
            if(this.baseAmountIn === 0 || !this.baseAmountIn) this.baseAmountIn = this.quoteAmountIn / this.ticker.currentPrice;
            if(this.quoteAmountIn === 0 || !this.quoteAmountIn) this.quoteAmountIn = this.baseAmountIn * this.ticker.currentPrice;
            if(hoursPassed(this.startedAt) >= this.ttl) {
                this.stop();
                await this.controller.revive(this);
                return;
            }

            this.offGrid = this.transactions.every(one => one.price < this.ticker.currentPrice) ? "LONG" 
            : this.transactions.every(one => one.price > this.ticker.currentPrice) ? "SHORT" : false;
            
            this.acceptableProfit = (this.quoteAmountIn * this.fee) * (this.profitMultiplier);
            this.acceptableLoss = this.acceptableProfit;

            if(this.transactions.length < 1) await this.setTransactions(this);
            if(this.transactions.length < 1) await this.hedge();

            await this.updateTransactions();
            await this.calculateMoneyIn();
            await this.calculateShifts();
            await this.calculateProfit();
            await this.calculateTotalProfit();
            this.update();
        
            console.log(`-------------------------${this.symbol}------------------------------`);
            console.log("CURRENT_PRICE:", this.ticker.currentPrice);    
            console.log("ACCEPTABLE PROFIT:", this.acceptableProfit);    
            console.log("transactions:", this.transactions.map(obj => ({
                price: obj.price, 
                side: obj.side, 
                profit: obj.profit, 
                acceptableLoss: obj.acceptableLoss
            })));
            console.log("MONEY_IN:", this.moneyIn);            
            console.log("PROFIT:", this.profit);
        }
        catch(error) {
            console.log(error);
            throw(error);
        }
    }

    stop() {
        this.status = "STOPPED";
    }

    update() {
        this.updatedAt = new Date();
    }

    static async getOpenTraders() {
        try {
            const ids = await Traders.aggregate([
            { $match: {status: {$ne: "STOPPED"} } },
            { $project: {_id: 1, symbol: 1} },
            { $sort: {createdAt: -1} },
            { $limit: 100 }
            ]).exec();

            return ids;
        } catch (err) {
            console.log(err);
            throw err;
        }
    };
}

module.exports = { Trader };
