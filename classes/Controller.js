const { v4: uuidv4 } = require('uuid');
const { Trader } = require("./Trader");

class Controller {
    constructor() {
        this.id = uuidv4();
        this.traders = [];
    }

    async setTraders() {
        try {
            const data = await Trader.getOpenTraders();
            if(data.length > 0) {
                const traders = await Promise.all(data.map(async(obj) => {
                    const trader = new Trader({symbol: obj.symbol});
                    await trader.fromId(obj._id);
                    return trader;
                }));
    
                this.traders = traders;
            }

            console.log(this.traders.map(obj => obj._id));
            return;
        }
        catch(error) {
            console.log(error);
        }
    }

    createTrader(data) {
        return new Trader({controller: this, ...data});
    }

    addTrader(trader) {
        if(this.traders.filter(one => one.id === trader.id).length < 1 && trader.status !== "STOPPED") {
            this.traders = [...this.traders, trader];
        }
    }

    removeTrader(trader) {
        this.traders = this.traders.filter(one => one.id !== trader.id);
    }

    async revive(trader) {
        try {
            const {symbol, baseAmountIn, quoteAmountIn, leverage, maxTransactions, maxShifts, mode} = trader;
            await this.destroy(trader);
            return this.createTrader({
                symbol, 
                baseAmountIn, 
                quoteAmountIn, 
                leverage, 
                maxTransactions, 
                maxShifts, 
                mode
            });
        }
        catch(error) {
            console.log(error);
            throw error;
        }
    }

    async destroy(trader) {
        try {
            await trader.destroy();
            this.removeTrader(trader);
        }
        catch(error) {
            console.log(error);
            throw error;
        }
    }
}

module.exports = { Controller };
