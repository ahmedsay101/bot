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
        maxBaseAmountIn = 0,
        peakBaseAmountIn = 0,
        peakRounds = 0,
        doubles = 4,
        minDoubles = 2,
        startsAt = 0, 
        endsAt = 0,
        takeProfit = 0,
        stopLoss = 0,
        takeProfitStep = 1,
        stepSize = 0,
        type = "UNLIMITED",
        aim = 0,
        leverage = 10,
        lives = 0,
        accumulatedProfit = 0,
        maxMoneyIn = 0,
        requiredTransactions = 0,
        requiredBalance = 0,
        hours = 0,
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
        this._currentAmountIn = this._baseAmountIn;
        this._quoteAmountIn = quoteAmountIn;
        this._maxBaseAmountIn = maxBaseAmountIn;
        this._peakBaseAmountIn = peakBaseAmountIn;
        this._peakRounds = peakRounds;
        this._doubles = doubles;
        this._minDoubles = minDoubles;
        this._aim = aim;
        this._hours = hours;
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
        this._coverage = 0;
        this._requiredTransactions = requiredTransactions;
        this._requiredBalance = requiredBalance;
        this._mode = mode;
        this._status = "STOPPED";
        this._isMarketActive = false;
        this._starts = starts;
        this._currentRounds = 0;
        this._startsAt = startsAt;
        this._endsAt = endsAt;
        this._type = type;
        this._lives = lives;
        this.busy = false;
        this._peak = 0;
        this._timeLeft = 0;
        this._maxMoneyIn = maxMoneyIn;
        this._accumulatedProfit = accumulatedProfit;
        this._createdAt = new Date();
        this._updatedAt = new Date();
        this.overwrite = ["levels", "profit"];

        this.marketActiveTask = cron.schedule('* * * * *', async() => {
            if(this._starts === "MARKET_ACTIVE") await this.isMarketActive();
        });
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

    /*async isMarketActive() {
        try {
            const candles = await this.service.getKlines(this._symbol, 30, "5m");
            const threshold = 400;
        
            let ranges = [];
            let volumes = [];
        
            for (let candle of candles) {
                const high = parseFloat(candle[2]);
                const low = parseFloat(candle[3]);
                const volume = parseFloat(candle[5]);
                ranges.push(high - low);
                volumes.push(volume);
            }
        
            const avgRange = ranges.slice(0, -1).reduce((a, b) => a + b, 0) / (ranges.length - 1);
            const lastRange = ranges[ranges.length - 1];
        
            const avgVolume = volumes.slice(0, -1).reduce((a, b) => a + b, 0) / (volumes.length - 1);
            const lastVolume = volumes[volumes.length - 1];

            console.log("AVERAGE RANGE: ", avgRange);
            console.log("LAST RANGE: ", lastRange);

            console.log("AVERAGE VOLUME: ", avgVolume);
            console.log("LAST VOLUME: ", lastVolume);

            if ((lastRange >= threshold * 0.7 || avgRange >= threshold * 0.5) && lastVolume >= avgVolume * 2) {
                this._isMarketActive = true;
                console.log("MARKET ACTIVE", this._isMarketActive);
                return;
            }
        
            return false;
        } catch (error) {
            console.log(error);
            this._isMarketActive = false;
            return;
        }
    }*/

    async isMarketActive() {
        try {

            const 
            interval = "5m", 
            threshold = 400,
            limit = 30, 
            rangeMultiplier = 2,
            bodyMultiplier = 2,
            volumeMultiplier = 4;

            const candles = await this.service.getKlines(this._symbol, limit, interval);
        
            let highs = [], lows = [], volumes = [], bodies = [], ranges = [];
        
            for (let i = 0; i < candles.length; i++) {
                const open = parseFloat(candles[i][1]);
                const high = parseFloat(candles[i][2]);
                const low = parseFloat(candles[i][3]);
                const close = parseFloat(candles[i][4]);
                const volume = parseFloat(candles[i][5]);
            
                highs.push(high);
                lows.push(low);
                volumes.push(volume);
                bodies.push(Math.abs(close - open));
                ranges.push(high - low);
            }
        
            const avgVolume = volumes.slice(0, -1).reduce((a, b) => a + b, 0) / (volumes.length - 1);
            const avgBody = bodies.slice(0, -1).reduce((a, b) => a + b, 0) / (bodies.length - 1);
            const avgRange = ranges.slice(0, -1).reduce((a, b) => a + b, 0) / (ranges.length - 1);
        
            const newRange = avgRange * rangeMultiplier;
            const newVolume = avgVolume * volumeMultiplier;
            const newBody = avgBody * bodyMultiplier;

            const lastCandle = candles[candles.length - 1];
            const lastOpen = parseFloat(lastCandle[1]);
            const lastClose = parseFloat(lastCandle[4]);
            const lastHigh = parseFloat(lastCandle[2]);
            const lastLow = parseFloat(lastCandle[3]);
            const lastVolume = parseFloat(lastCandle[5]);
            const lastBody = Math.abs(lastClose - lastOpen);
            const lastRange = lastHigh - lastLow;

            console.log("AVERAGE BODY: ", avgBody);
            console.log("AVERAGE VOLUME: ", avgVolume);
            console.log("AVERAGE RANGE: ", avgRange);

            console.log("LAST BODY: ", lastBody);
            console.log("LAST VOLUME: ", lastVolume);
            console.log("LAST RANGE: ", lastRange);
        
            if (
                lastBody >= newBody 
                && lastVolume >= newVolume 
                && lastRange >= newRange
                && lastRange >= threshold
            ) {
                console.log("MARKET ACTIVE", this._isMarketActive);
                this._isMarketActive = true;
                return;
            }
            
            this._isMarketActive = false;
            return;
        }
        catch(error) {
            console.log(error);
            this._isMarketActive = false;
            return;
        }
    }

    start() {
        if(this._starts === "NOW") this._status = "ACTIVE";
        else if(this._starts === "ACTIVE_HOURS") {
            if(this.isActive()) this._status = "ACTIVE";
        }
        else if(this._starts === "MARKET_ACTIVE") {
            if(this._isMarketActive) this._status = "ACTIVE";
        }
    }

    isActive() {
        const now = new Date();
        const cairoHour = (now.getUTCHours() + 2) % 24;
        const cairoDay = now.getUTCDay(); // 0 = Sunday, 6 = Saturday

        const isWeekday = cairoDay >= 1 && cairoDay <= 5; // Monday to Friday
        const isWithinHours = cairoHour >= 11 && cairoHour <= 19; // 11 AM to 7:59 PM Cairo time

        return true;
        return isWeekday && isWithinHours;
    }

    async sync() {
        try {
            //if(this._status === "ACTIVE") await this.takeProfit();
            if(this._status === "ACTIVE") await this.shouldGetOut();
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

    async takeProfit() {
        try {
            if(this.transactions.length === 0 || this._levels.length === 0 || !this._takeProfit) return;
            const currentPrice = this.ticker.currentPrice;
            const longLevel = this._levels.sort((a, b) => b - a)[0];
            const shortLevel = this._levels.sort((a, b) => b - a)[1];
            const filledTransactions = this.transactions.filter(one => one._status === "FILLED").length;
            const fee = Number(this._moneyIn) * Number(this._fee);
            const currentAmount = this.transactions.filter((obj) => obj._status === "FILLED").length > 0 ? this.transactions.filter((obj) => obj._status === "FILLED").map(obj => obj._baseAmountIn).reduce((total, current) => total + current) : 0;
            if(
                (
                    ((Math.abs(currentPrice - longLevel) >= (filledTransactions === 1 ? (Number(this._takeProfit) / 2) : Number(this._takeProfit)))  && currentPrice > longLevel)
                || 
                    ((Math.abs(currentPrice - shortLevel) >= (filledTransactions === 1 ? (Number(this._takeProfit) / 2) : Number(this._takeProfit))) && currentPrice < shortLevel)
                )
                && 
                (
                    Number(this._profit) >= 1
                )
            ) await this.revive();


        } 
        catch(error) {
          console.log(error);
        }
    }

    async shouldGetOut() {
        try {
            const currentPrice = this.ticker.currentPrice;
            const longLevel = this._levels.sort((a, b) => b - a)[0];
            const shortLevel = this._levels.sort((a, b) => b - a)[1];
            const filledTransactions = this.transactions.filter(one => one._status === "FILLED").length;
            if(
                (
                    ((Math.abs(currentPrice - longLevel) >=  Number(this._takeProfit)) && currentPrice > longLevel)
                    || 
                    ((Math.abs(currentPrice - shortLevel) >= Number(this._takeProfit)) && currentPrice < shortLevel)
                    && filledTransactions === 0
                    && Number(this._takeProfit) !== 0
                )
            ) await this.revive();
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
            this.start();
            if(!this.canTick()) return;
            this.hold();
            if(this._mode === "LIVE" && this.transactions.length < 1) await this.setLeverage();
            if(this._baseAmountIn === 0 || !this._baseAmountIn) this._baseAmountIn = this._quoteAmountIn / this.ticker.currentPrice;
            if(this._quoteAmountIn === 0 || !this._quoteAmountIn) this._quoteAmountIn = this.ticker.getQuoteQuantity(this._baseAmountIn * this.ticker.currentPrice);
            await this.controller.tick();
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

    log() {
    }

    async fill() {
        try {
            if(this.transactions.length === 0) {
                const currentPrice = this.ticker.currentPrice;
                const longPrice = Number(currentPrice) + Number(this._stepSize);
                const shortPrice = Number(currentPrice) - Number(this._stepSize);
                this._levels = [...new Set([
                    longPrice,
                    shortPrice,
                ].sort((a, b) => b - a))];
                const baseAmountIn = this._baseAmountIn;
                let isFake = false;
                if(((this._currentRounds + 1) < this._startsAt || !this._startsAt) || ((this._currentRounds + 1) > this._endsAt || !this._endsAt)) isFake = true;
                const long = await this.newTransaction({side: "LONG", price: longPrice, baseAmountIn, isFake});
                const short = await this.newTransaction({side: "SHORT", price: shortPrice, baseAmountIn, isFake});    
            }
            else {
                const longLevel = this._levels.sort((a, b) => b - a)[0];
                const shortLevel = this._levels.sort((a, b) => b - a)[1];
                const isAllLongFilled = this.transactions.filter(obj => obj._price === longLevel && obj._status === "FILLED").length === this.transactions.filter(obj => obj._price === longLevel).length;
                const isAllShortFilled = this.transactions.filter(obj => obj._price === shortLevel && obj._status === "FILLED").length === this.transactions.filter(obj => obj._price === shortLevel).length;
                const longAmount = this.transactions.filter(obj => obj._price === longLevel).length < 1 ? 0 :
                this.transactions.filter(obj => obj._price === longLevel).map(obj => Number(obj._baseAmountIn)).sort((a, b) => b._baseAmountIn - a._baseAmountIn)[0];
                const shortAmount = this.transactions.filter(obj => obj._price === shortLevel).length < 1 ? 0 :
                this.transactions.filter(obj => obj._price === shortLevel).map(obj => Number(obj._baseAmountIn)).sort((a, b) => b._baseAmountIn - a._baseAmountIn)[0];

                const longTransactions = this.transactions.filter(obj => obj._price === longLevel).length;
                const shortTransactions = this.transactions.filter(obj => obj._price === shortLevel).length;

                let doubles = this._doubles;

                if(isAllLongFilled && (shortAmount < longAmount) && shortTransactions < 1) {
                    const lastBaseAmountIn = this.transactions.filter(obj => obj._price === longLevel && !obj._isFake).sort((a, b) => b._baseAmountIn - a._baseAmountIn)[0]?._baseAmountIn;
                    let baseAmountIn = lastBaseAmountIn ? Number(lastBaseAmountIn * doubles) : this._baseAmountIn;
                    baseAmountIn = this._currentAmountIn;
                    let isFake = false;
                    if(((this._currentRounds + 1) < this._startsAt || !this._startsAt) || ((this._currentRounds + 1) > this._endsAt || !this._endsAt)) isFake = true;
                    if(isFake) baseAmountIn = this._baseAmountIn;
                    const newShort = await this.newTransaction({side: "SHORT", price: shortLevel, baseAmountIn, isFake});     
                }
                if(isAllShortFilled && (longAmount < shortAmount) && longTransactions < 1) {
                    const lastBaseAmountIn = this.transactions.filter(obj => obj._price === shortLevel && !obj._isFake).sort((a, b) => b._baseAmountIn - a._baseAmountIn)[0]?._baseAmountIn;
                    let baseAmountIn = lastBaseAmountIn ? Number(lastBaseAmountIn * doubles) : this._baseAmountIn;
                    baseAmountIn = this._currentAmountIn;
                    let isFake = false;
                    if(((this._currentRounds + 1) < this._startsAt || !this._startsAt) || ((this._currentRounds + 1) > this._endsAt || !this._endsAt)) isFake = true;
                    if(isFake) baseAmountIn = this._baseAmountIn;
                    const newLong = await this.newTransaction({side: "LONG", price: longLevel, baseAmountIn, isFake});   
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

    async revive(starts = "NOW") {
        try {
            if(this._status === "STOPPED") return;
            await this.destroy();
            await this.controller.createTrader({
                symbol: this._symbol,
                takeProfit: this._takeProfit,
                baseAmountIn: this._baseAmountIn,
                quoteAmountIn: this._quoteAmountIn,
                maxBaseAmountIn: this._maxBaseAmountIn,
                peakBaseAmountIn: this._peakBaseAmountIn,
                peakRounds: this._peakRounds,
                stepSize: this._stepSize,
                stopLoss: this._stopLoss,
                mode: this._mode,
                leverage: this._leverage,
                starts: starts,
                takeProfitStep: this._takeProfitStep,
                startsAt: this._startsAt,
                endsAt: this._endsAt,
                doubles: this._doubles
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
