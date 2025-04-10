const { v4: uuidv4 } = require('uuid');
const { Trader } = require("./Trader");
const { Traders } = require('../schema/trader.schema');
const { Ticker } = require('./Ticker');
const { Service } = require('./API');
const { Transactions } = require('../schema/transaction.schema');

class Controller {
    constructor() {
        this.id = uuidv4();
        this.traders = [];
        this.tickers = [];
        this.profit = 0;
        this.service = new Service("futures");
        this.sync();
    }

    async createTrader(data) {
        let ticker = this.tickers.find(one => one.symbol === data.symbol);
        if(!ticker) ticker = new Ticker(this, data.symbol);
        const traderData = {
            symbol: data.symbol,
            takeProfit: data.takeProfit,
            stepSize: data.stepSize,
            stopLoss: data.stopLoss,
            mode: data.mode,
            leverage: data.leverage,
            levels: data.levels,
            type: data.type,
            direction: data.direction,
            coverage: data.coverage,
            hours: data.hours,
            takeProfitStep: data.takeProfitStep
        };
        if(data.starts) traderData["starts"] = data.starts;
        if(data.accumulatedProfit) traderData["accumulatedProfit"] = data.accumulatedProfit;
        if(data.maxMoneyIn) traderData["maxMoneyIn"] = data.maxMoneyIn;
        if(data.baseAmountIn) traderData["baseAmountIn"] = data.baseAmountIn;
        if(data.maxBaseAmountIn) traderData["maxBaseAmountIn"] = data.maxBaseAmountIn;
        if(data.peakBaseAmountIn) traderData["peakBaseAmountIn"] = data.peakBaseAmountIn;
        if(data.quoteAmountIn) traderData["quoteAmountIn"] = data.quoteAmountIn;
        if(data.type !== "UNLIMITED") {
            traderData["type"] = data.type;
            traderData["lives"] = data.lives;
        }
        if(data.type === "LIMITED") traderData["aim"] = data.aim;
        if(data.type === "TIMED" || data.type === "TIMEDAVERAGE") traderData["hours"] = data.hours;
        const trader = new Trader(this, traderData);
        await trader.sync();
        return trader;
    }

    addTicker(ticker) {
        if(this.tickers.filter(one => one.symbol === ticker.symbol).length < 1) {
            this.tickers = [...this.tickers, ticker];
        }
    }

    addTrader(trader) {
        if(this.traders.filter(one => one.id === trader.id).length < 1) {
            this.traders = [...this.traders, trader];
        }
    }

    removeTrader(trader) {
        this.traders = this.traders.filter(one => one.id !== trader.id);
    }

    async sync() {
        try {
            const traderIds = await Traders.aggregate([
                {$match: {status: "ACTIVE"}}
            ]);

            for(let obj of traderIds) {
                let ticker = this.tickers.find(one => one.symbol === obj.symbol);
                if(!ticker) ticker = new Ticker(this, obj.symbol);
                const trader = new Trader(this, obj);
                await trader.fromId(obj._id);
            }
        } 
        catch(error) {
            console.log(error);
        }
    }

    async tick() {
        try {
            await this.calculateProfit();
        }
        catch(error) {
            console.log(error);
        }
    }

    async calculateProfit() {
        try {
            const results = await Transactions.aggregate([
                {$group: {
                  _id: null,
                  totalProfit: { $sum: "$profit" },
                }}
            ]).exec();
            this.profit = results && results.length > 0 ? Number(results[0].totalProfit) : 0;
        }
        catch(error) {
            console.log(error);
        }
    }
}

module.exports = { Controller };
