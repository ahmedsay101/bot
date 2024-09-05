const { v4: uuidv4 } = require('uuid');
const { Trader } = require("./Trader");
const { Traders } = require('../schema/trader.schema');

class Controller {
    constructor(data) {
        this.id = uuidv4();
        this.baseData = data;
        this.traders = [];
        this.run();
    }

    async createTrader(data) {
        const trader = new Trader(this);
        trader._symbol = data.symbol;
        if(data.baseAmountIn) trader._baseAmountIn = data.baseAmountIn;
        if(data.quoteAmountIn) trader._quoteAmountIn = data.quoteAmountIn;
        trader._takeProfit = data.takeProfit;
        trader._stepSize = data.takeProfit;
        trader._stopLoss = data.stopLoss;
        await trader.sync();
        return trader;
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
        } 
        catch(error) {
            console.log(error);
        }
    }

    async run() {
        try {
            await this.sync();
            if(this.traders.length < 1) {
                for(let trader of this.baseData) {
                    await this.createTrader(trader);
                }
            }
        } 
        catch(error) {
          console.log(error);
        }
    }
}

module.exports = { Controller };
