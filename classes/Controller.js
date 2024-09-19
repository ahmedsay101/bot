const { v4: uuidv4 } = require('uuid');
const { Trader } = require("./Trader");
const { Traders } = require('../schema/trader.schema');
const cron = require('node-cron');
const { Ticker } = require('./Ticker');
const { Service } = require('./API');

class Controller {
    constructor(data) {
        this.id = uuidv4();
        this.baseData = data;
        this.traders = [];
        this.tickers = [];
        this.profit = 0;
        this.service = new Service("futures");
        this.sync();
        this.task = cron.schedule(`0 */30 * * * *`, async() => {
            await this.run();
        });
    }

    async createTrader(data) {
        let ticker = this.tickers.find(one => one.symbol === data.symbol);
        if(!ticker) ticker = new Ticker(this, data.symbol);
        const trader = new Trader(this, data.symbol);
        trader._symbol = data.symbol;
        if(data.baseAmountIn) trader._baseAmountIn = data.baseAmountIn;
        if(data.quoteAmountIn) trader._quoteAmountIn = data.quoteAmountIn;
        trader._takeProfit = data.takeProfit;
        trader._stepSize = data.stepSize;
        trader._stopLoss = data.stopLoss;
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
                {$project: {_id: 1}}
            ]);

            for(let obj of traderIds) {
                const trader = new Trader(this);
                await trader.fromId(obj._id);
            }

            if(this.traders.length < 1) {
                await this.run();
            }
        } 
        catch(error) {
            console.log(error);
        }
    }

    async run() {
        try {
            for(let trader of this.baseData) {
                await this.createTrader(trader);
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
