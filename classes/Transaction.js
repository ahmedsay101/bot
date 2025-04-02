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
    this._currentTakeProfit = Number(this.trader._takeProfit);
    this._takeProfitStep = Number(this.trader.takeProfitStep);
    this._readyToTakeProfit = false;
    this._baseAmountOut = 0;
    this._quoteAmountOut = 0;
    this._side = null;
    this._orderId = null;
    this._price = null;
    this._takeProfit = Number(this.trader._takeProfit);
    this._stopLoss = Number(this.trader._stopLoss);
    this._closingPrice = 0;
    this._profit = 0;
    this._profitable = false;
    this._status = null;
    this._type = "MARKET";
    this._position = null;
    this.busy = false;
    this._createdAt = new Date();
    this._updatedAt = new Date();
    this.overwrite = ["orderId"];
  }

  hold() {
    this.busy = true;
  }

  release() {
    this.busy = false;
  }

  async fill() {
    try {
      if(this._baseAmountIn >= this.trader._maxBaseAmountIn) {
        await this.trader.revive();
        return;
      }
      if(this._mode === "LIVE") await this.order();
      else this._status = "FILLED";
    } 
    catch(error) {
      console.log(error);
    }
  }

  async order() {
    try {
      if(!this._side || this._mode !== "LIVE" || this.busy || this._orderId !== null) return false;
      if(this._type === "LIMIT" && (!this._price)) return false;
      this.hold();
      const orderObj = {
        symbol: this._symbol,
        side: this._side === "LONG" ? "BUY" : "SELL",
        positionSide: this._side,
        type: this._type,
        quantity: this._baseAmountIn,
      }
      if(this._type === "LIMIT") {
        orderObj["price"] = this.ticker.getQuoteQuantity(this._price);
        orderObj["timeInForce"] = "GTC";
      }
      const order = await this.service.order(orderObj);
      console.log("ORDER", order);
      if(order && order?.orderId) this._orderId = order.orderId;
      this.release();
    } 
    catch(error) {
      console.log(error);
    }
  }

  /*async takeProfit() {
    try {
      if(this.busy) return;
      this.hold();
      if(this._takeProfit && this._status === "FILLED") {
        const takeProfitOrder = await this.service.order({
          symbol: this._symbol,
          side: this._side === "SHORT" ? "BUY" : "SELL",
          positionSide: this._side,
          type: "TAKE_PROFIT_MARKET",
          stopPrice: this.ticker.getQuoteQuantity(this._takeProfit),
          quantity: this.ticker.getBaseQuantity(this._baseAmountIn),
          timeInForce: "GTC",
          workingType: "MARK_PRICE",
          priceProtect: true,
        });
      }
      this.release();
    } 
    catch(error) {
      console.log(error);
    }
  }*/

  /*async stopLoss() {
    try {
      if(this.busy) return;
      this.hold();
      if(this._stopLoss && this._status === "FILLED") {
        const stopLossOrder = await this.service.order({
          symbol: this._symbol,
          side: this._side === "SHORT" ? "BUY" : "SELL",
          positionSide: this._side,
          type: "STOP_MARKET",
          stopPrice: this.ticker.getQuoteQuantity(this._stopLoss),
          quantity: this.ticker.getBaseQuantity(this._baseAmountIn),
          timeInForce: "GTC",
          workingType: "MARK_PRICE",
          priceProtect: true,
        });
      }
      this.release();
    } 
    catch(error) {
      console.log(error);
    }
  }*/
  
  async update() {
    try {
      if(this._orderId !== null && this._mode === "LIVE" && this._status !== "CLOSED" && !this.busy) {
        const orderResponse = await this.service.getOrderByOrderId(this._symbol, this._orderId);
        if(orderResponse) {
          if(orderResponse?.status === "NEW" || orderResponse?.status === "FILLED") this._status = orderResponse?.status;
          if(orderResponse?.status === "CANCELED") {
            this._orderId = null;
            return;
          }
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

  async sync() {
    try {
      if(this._mode === "LIVE") {
        if(!this.busy && this._status === "NEW") await this.update();
        /*if(
          !this._orderId 
          && (
            (this._side === "LONG" && this.ticker.getQuoteQuantity(this.ticker.currentPrice) <= this.ticker.getQuoteQuantity(Number(this._price) + (Number(this.trader._stepSize) * 2)))
            || (this._side === "SHORT" && this.ticker.getQuoteQuantity(this.ticker.currentPrice) >= this.ticker.getQuoteQuantity(Number(this._price) - (Number(this.trader._stepSize) * 2)))
          )
        ) await this.order();
        if(
          this._orderId 
          && this._status === "NEW"
          && (
            (this._side === "LONG" && this.ticker.getQuoteQuantity(this.ticker.currentPrice) > this.ticker.getQuoteQuantity(Number(this._price) + (Number(this.trader._stepSize) * 2)))
            || (this._side === "SHORT" && this.ticker.getQuoteQuantity(this.ticker.currentPrice) < this.ticker.getQuoteQuantity(Number(this._price) - (Number(this.trader._stepSize) * 2)))
          )
        ) await this.cancel();*/
      }
      await this.dbSync();
    } 
    catch(error) {
      console.log(error);
    }
  }

  async cancel() {
    try {
      if(this._mode === "LIVE" && this._status === "NEW" && this._orderId) {
        this.hold();
        await this.service.cancelOrder({symbol: this._symbol, orderId: this._orderId});
        this.release();
      }
    }  
    catch(error) {
      console.log(error);
      this.release();
    }
  } 

  async close() {
    try {
      if(this._mode === "LIVE" && this._status !== "CLOSED" && !this.busy) {
        this.hold();
        if(this._status === "FILLED") {
          const closeOrder = await this.service.order({
            symbol: this._symbol,
            side: this._side === "LONG" ? "SELL" : "BUY",
            positionSide: this._side,
            type: "MARKET",
            quantity: this._baseAmountIn,
            recvWindow: '10000'
          });
        }
        if(this._orderId && this._status === "NEW") await this.cancel();
      }
      this.release();
      await this.destroy();
    }  
    catch(error) {
      console.log(error);
      this.release();
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
      if(this._position === null) this._position = this.ticker.currentPrice > this._price ? "LOWER" : "HIGHER";

      if(
        this._status === "NEW"
        &&
        ((this._position === "HIGHER" && this.ticker.currentPrice >= this._price)
        ||
        (this._position === "LOWER" && this.ticker.currentPrice <= this._price))
      ) {
        await this.fill();
      }

      /*if(
        (this._side === "LONG" && this.ticker.getQuoteQuantity(this.ticker.currentPrice) >= this.ticker.getQuoteQuantity(this._takeProfit) && this.ticker.getQuoteQuantity(this._takeProfit) !== 0 && this._status === "FILLED")
        ||
        (this._side === "SHORT" && this.ticker.getQuoteQuantity(this.ticker.currentPrice) <= this.ticker.getQuoteQuantity(this._takeProfit) && this.ticker.getQuoteQuantity(this._takeProfit) !== 0 && this._status === "FILLED")
        ||
        (this._side === "SHORT" && this.ticker.getQuoteQuantity(this.ticker.currentPrice) >= this.ticker.getQuoteQuantity(this._stopLoss) && this.ticker.getQuoteQuantity(this._stopLoss) !== 0 && this._status === "FILLED")
        ||
        (this._side === "LONG" && this.ticker.getQuoteQuantity(this.ticker.currentPrice) <= this.ticker.getQuoteQuantity(this._stopLoss) && this.ticker.getQuoteQuantity(this._stopLoss) !== 0 && this._status === "FILLED")
      ) await this.close();*/

      //this._baseAmountIn = this.trader._baseAmountIn;
      this._quoteAmountIn = this._baseAmountIn * this._price;
      this._quoteAmountOut = this._side === "LONG" ? this._baseAmountIn * this.ticker.currentPrice : (this._quoteAmountIn + (this._quoteAmountIn - (this._baseAmountIn * this.ticker.currentPrice)));
      this._baseAmountOut = this.ticker.getBaseQuantity(this._quoteAmountOut / this.ticker.currentPrice);
      this._closingPrice = this.ticker.currentPrice;
      this._profit = this._status === "FILLED" ? (this._quoteAmountOut - this._quoteAmountIn) - (this._quoteAmountIn * this.trader._fee) : this._profit > 0 ? this._profit : 0;
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
