const { v4: uuidv4 } = require('uuid');
const { Transactions } = require("../schema/transaction.schema");
const { DB } = require('./DB');

class Transaction extends DB {
  constructor(trader) {
    super(Transactions);
    this.id = uuidv4();
    this._id = null;
    this.trader = trader;
    this.trader.addTransaction(this);
    this.ticker = this.trader.ticker;
    this._symbol = this.trader._symbol;
    this._mode = this.trader._mode;
    this._baseAmountIn = this.trader._baseAmountIn;
    this._quoteAmountIn = this.trader._quoteAmountIn;
    this._baseAmountOut = 0;
    this._quoteAmountOut = 0;
    this._side = null;
    this._traderId = this.trader._id || null;   
    this._orderId = null;
    this._price = null;
    this._takeProfit = 0;
    this._stopLoss = 0;
    this._closingPrice = 0;
    this._profit = 0;
    this._profitable = false;
    this._status = null;
    this._type = "LIMIT";
    this._createdAt = new Date();
    this._updatedAt = new Date();
  }

  async order() {
    try {
      if(!this._side) return false;
      if(this._type === "LIMIT" && (!this._price || !this._takeProfit)) return false;
    } 
    catch(error) {
      console.log(error);
    }
  }
  
  async updateOrder() {
    try {
      if(this.orderId !== null && this.mode === "LIVE") {
        const orderResponse = await this.service.getOrderByOrderId(this._symbol, this._orderId);
        console.log("orderResponse", orderResponse);
        if(orderResponse) {
          this._status = orderResponse.status;
          this._baseAmountIn = Number(orderResponse.executedQty) ? Number(orderResponse.executedQty) : Number(orderResponse.origQty);
          this._quoteAmountIn = Number(orderResponse.cumQuote) ? Number(orderResponse.cumQuote) : Number(this._quoteAmountIn);
          this._price = Number(orderResponse.price) ? Number(orderResponse.price) : Number(this._price);
          if(this._status === "CLOSED") await this.close();
        }
      }
    } 
    catch(error) {
      console.log(error);
    }
  } 

  async sync() {
    try {
      if(this.mode === "LIVE") {
        if(!this._orderId) await this.order();
        await this.updateOrder();
      }
      await this.dbSync();
    } 
    catch(error) {
      console.log(error);
    }
  }

  async close() {
    try {
      this._status = "CLOSED";
      this.trader.removeTransaction(this);
      await this.sync();
    }  
    catch(error) {
      console.log(error);
    }
  } 

  async tick() {
    try {
      if(!this._price && this._type === "MARKET") this._price = this.ticker.currentPrice;
      if(!this._price || !this._baseAmountIn || !this.ticker.currentPrice || this._status === "CLOSED") return;
      this._takeProfit = this._side === "LONG" ? this._price + this.trader._takeProfit : this._price  - this.trader._takeProfit;
      this._stopLoss = this.trader._stopLoss > 0 ? this._side === "LONG" ? this._price - this.trader._stopLoss : this._price + this.trader._stopLoss : 0;

      if(this._mode === "TESTING") {
        if(
          (this._side === "LONG" && this.ticker.currentPrice >= this._price)
          ||
          (this._side === "SHORT" && this.ticker.currentPrice <= this._price)
        ) this._status = "FILLED";
        if(
          (this._side === "LONG" && this.ticker.currentPrice >= this._takeProfit)
          ||
          (this._side === "SHORT" && this.ticker.currentPrice <= this._takeProfit)
          ||
          (this._side === "SHORT" && this.ticker.currentPrice >= this._stopLoss && this._stopLoss !== 0)
          ||
          (this._side === "LONG" && this.ticker.currentPrice <= this._stopLoss && this._stopLoss !== 0)
        ) await this.close();
      }
          
      this._baseAmountIn = this.trader._baseAmountIn;
      this._quoteAmountIn = this._baseAmountIn * this._price;
      this._quoteAmountOut = this._side === "LONG" ? this._baseAmountIn * this.ticker.currentPrice : (this._quoteAmountIn + (this._quoteAmountIn - (this._baseAmountIn * this.ticker.currentPrice)));
      this._baseAmountOut = this.ticker.getBaseQuantity(this._quoteAmountOut / this.ticker.currentPrice);
      this._closingPrice = this.ticker.currentPrice;
      this._profit = this._status === "FILLED" ? (this._quoteAmountOut - this._quoteAmountIn) - (this._quoteAmountIn * this.trader._fee) : 0;
      this._isProfitable = this._profit > 0;
      this._expectedAmountOut = this._side === "LONG" ? this._baseAmountIn * this._takeProfit : (this._quoteAmountIn + (this._quoteAmountIn - (this._baseAmountIn * this._takeProfit)));
      this._expectedProfit = (this._expectedAmountOut - this._quoteAmountIn) - (this._quoteAmountIn * this.trader._fee);
      await this.sync();
    }
    catch(error) {
      console.log(error);
    }
  }

  static async doesExist(traderId, price) {
    try {
      const transactions = await Transactions.aggregate([
        {$match: {traderId, price, status: {$ne: "CLOSED"}}},
        {$project: {_id: 1, price: 1}}
      ]).exec();
      if(transactions.length > 0) return true;
      else return false;
    }  
    catch(error) {
      console.log(error);
    }
  } 

  static async count(traderId) {
    try {
      const count = await Transactions.countDocuments({traderId});
      return count;
    }  
    catch(error) {
      console.log(error);
    }
  }
};

module.exports = { Transaction };
