const { v4: uuidv4 } = require('uuid');
const { Transactions } = require("../schema/transaction.schema");
const { DB } = require('./DB');

class Transaction extends DB {
  constructor(trader) {
    super(Transactions);
    this.id = uuidv4();
    this._id = null;
    this.trader = trader;
    this.service = this.trader.service;
    this._traderId = this.trader._id || null;   
    this.trader.addTransaction(this);
    this.ticker = this.trader.ticker;
    this._symbol = this.trader._symbol;
    this._mode = this.trader._mode;
    this._baseAmountIn = this.trader._baseAmountIn;
    this._quoteAmountIn = this.trader._quoteAmountIn;
    this._baseAmountOut = 0;
    this._quoteAmountOut = 0;
    this._side = null;
    this._orderId = null;
    this._takeProfitOrderId = null;
    this._price = null;
    this._takeProfit = 0;
    this._stopLoss = 0;
    this._closingPrice = 0;
    this._profit = 0;
    this._profitable = false;
    this._status = null;
    this._type = "LIMIT";
    this.position = null;
    this.busy = false;
    this._createdAt = new Date();
    this._updatedAt = new Date();
  }

  hold() {
    this.busy = true;
  }

  release() {
    this.busy = false;
  }

  async order() {
    try {
      if(!this._side || this._mode !== "LIVE" || this.busy || this._orderId !== null || !this._takeProfit) return false;
      if(this._type === "LIMIT" && (!this._price || !this._takeProfit)) return false;
      this.hold();
      const order = await this.service.order({
        symbol: this._symbol,
        side: this._side === "LONG" ? "BUY" : "SELL",
        positionSide: this._side,
        type: "LIMIT",
        price: this.ticker.getQuoteQuantity(this._price),
        quantity: this.ticker.getBaseQuantity(this._baseAmountIn),
        timeInForce: "GTC"
      });
      if(order && order?.orderId) this._orderId = order.orderId;
      this.release();
    } 
    catch(error) {
      console.log(error);
    }
  }

  async takeProfit() {
    try {
      if(this.busy) return;
      this.hold();
      if(this._takeProfit && !this._takeProfitOrderId && this._status === "FILLED") {
        const takeProfitOrder = await this.service.order({
          symbol: this._symbol,
          side: this._side === "SHORT" ? "BUY" : "SELL",
          positionSide: this._side,
          type: "TAKE_PROFIT",
          price: this.ticker.getQuoteQuantity(this._price),
          stopPrice: this.ticker.getQuoteQuantity(this._takeProfit),
          quantity: this.ticker.getBaseQuantity(this._baseAmountIn),
          timeInForce: "GTC"
        });
        if(takeProfitOrder && takeProfitOrder?.orderId) this._takeProfitOrderId = takeProfitOrder.orderId;
      }
      this.release();
    } 
    catch(error) {
      console.log(error);
    }
  }
  
  async update() {
    try {
      if(this._orderId !== null && this._mode === "LIVE" && this._status !== "CLOSED") {
        const orderResponse = await this.service.getOrderByOrderId(this._symbol, this._orderId);
        if(orderResponse) {
          this._status = orderResponse.status;
          this._baseAmountIn = Number(orderResponse.executedQty) ? Number(orderResponse.executedQty) : Number(orderResponse.origQty);
          this._quoteAmountIn = Number(orderResponse.cumQuote) ? Number(orderResponse.cumQuote) : Number(this._quoteAmountIn);
          this._price = Number(orderResponse.price) ? Number(orderResponse.price) : Number(this._price);
        }
      }
    } 
    catch(error) {
      console.log(error);
    }
  } 

  async updateTakeProfit() {
    try {
      if(this._takeProfitOrderId !== null && this._mode === "LIVE" && this._status !== "CLOSED") {
        const orderResponse = await this.service.getOrderByOrderId(this._symbol, this._takeProfitOrderId);
        if(orderResponse?.status !== "NEW") console.log("TAKEPROFITORDER:::", orderResponse)
        if(orderResponse?.status === "FILLED" && this._status !== "CLOSED") {
          await this.destroy();
        }
      }
    } 
    catch(error) {
      console.log(error);
    }
  } 

  async sync() {
    try {
      if(this._mode === "LIVE") {
        if(!this._orderId) await this.order();
        if(!this._takeProfitOrderId && this._takeProfit && this._status === "FILLED") await this.takeProfit();
        if(!this.busy && this._status === "NEW") await this.update();
        if(!this.busy && this._status !== "CLOSED") await this.updateTakeProfit();
      }
      await this.dbSync();
    } 
    catch(error) {
      console.log(error);
    }
  }

  async close() {
    try {
      if(this._mode === "LIVE" && this._status !== "CLOSED" && !this.busy) {
        this.hold();
        if(this._status === "FILLED") await this.service.order({
          symbol: this._symbol,
          side: this._side === "LONG" ? "SELL" : "BUY",
          positionSide: this._side,
          type: "MARKET",
          quantity: this.ticker.getBaseQuantity(this._baseAmountIn),
        });
        if(this._takeProfitOrderId) await this.service.cancelOrder({symbol: this._symbol, orderId: this._takeProfitOrderId});
        if(this._orderId && this._status === "NEW")  await this.service.cancelOrder({symbol: this._symbol, orderId: this._orderId});
        this.release();
      }
      await this.destroy();
    }  
    catch(error) {
      console.log(error);
    }
  } 

  async destroy() {
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
      if(this.position === null) this.position = this.ticker.currentPrice > this._price ? "LOWER" : "HIGHER";
      this._takeProfit = this._side === "LONG" ? this._price + this.trader._takeProfit : this._price  - this.trader._takeProfit;
      this._stopLoss = this.trader._stopLoss > 0 ? this._side === "LONG" ? this._price - this.trader._stopLoss : this._price + this.trader._stopLoss : 0;

      if(this._mode === "TESTING" && this._status !== "CLOSED") {
        if(
          (this.position === "HIGHER" && this.ticker.currentPrice >= this._price)
          ||
          (this.position === "LOWER" && this.ticker.currentPrice <= this._price)
        ) this._status = "FILLED";

        if(
          (this._side === "LONG" && this.ticker.currentPrice >= this._takeProfit && this._takeProfit !== 0 && this._status === "FILLED")
          ||
          (this._side === "SHORT" && this.ticker.currentPrice <= this._takeProfit && this._takeProfit !== 0 && this._status === "FILLED")
          ||
          (this._side === "SHORT" && this.ticker.currentPrice >= this._stopLoss && this._stopLoss !== 0 && this._status === "FILLED")
          ||
          (this._side === "LONG" && this.ticker.currentPrice <= this._stopLoss && this._stopLoss !== 0 && this._status === "FILLED")
        ) await this.destroy();
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
};

module.exports = { Transaction };
