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
    this._takeProfitOrderId = null;
    this._stopLossOrderId = null;
    this._price = null;
    this._takeProfit = Number(this.trader._takeProfit);
    this._stopLoss = Number(this.trader._stopLoss);
    this._closingPrice = 0;
    this._profit = 0;
    this._profitable = false;
    this._isFake = false;
    this._status = null;
    this._type = "STOP_MARKET";
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
      if(this._mode === "LIVE" && !this._isFake) {
        await this.order();
      }
      else {
        this._status = "FILLED";
      }
    } 
    catch(error) {
      console.log(error);
    }
  }

  async order() {
    try {
      if(!this._side || this._mode !== "LIVE" || this.busy || this._orderId !== null || this._isFake) return false;
      console.log("PRICEEEE", this._price );
      if((this._type === "LIMIT" || this._type === "STOP_MARKET") && (!this._price)) return false;
      this.hold();
      const orderObj = {
        symbol: this._symbol,
        side: this._side === "LONG" ? "BUY" : "SELL",
        //positionSide: this._side,
        type: this._type,
        quantity: this._baseAmountIn,
      }

      if(this._type === "LIMIT") {
        orderObj["price"] = this.ticker.getQuoteQuantity(this._price);
        orderObj["timeInForce"] = "GTC";
        orderObj["postOnly"] = true;
      }

      if(this._type === "STOP_MARKET") {
        orderObj["stopPrice"] = this.ticker.getQuoteQuantity(this._price);
        orderObj["reduceOnly"] = false;
      }

      const order = await this.service.order(orderObj);
      console.log("ORDER", order);
      if(order && order?.orderId) this._orderId = order.orderId;

      if(this._type === "MARKET") {
        await this.tp();
        await this.sl();
      }
      
      this.release();
    } 
    catch(error) {
      console.log(error);
    }
  }

  async tp() {
    try {
      if(this._mode !== "LIVE" || !this._takeProfit || this._takeProfitOrderId !== null || this._isFake) return false;
      this.hold();
      const orderObj = {
        symbol: this._symbol,
        side: this._side === "LONG" ? "SELL" : "BUY",
        //positionSide: this._side,
        type: 'TAKE_PROFIT_MARKET',
        quantity: this._baseAmountIn,
        stopPrice: this._takeProfit,
        reduceOnly: true,
      }
      const order = await this.service.order(orderObj);
      console.log("TP", order);
      if(order && order?.orderId) this._takeProfitOrderId = order.orderId;
      this.release();
    } 
    catch(error) {
      console.log(error);
    }
  }

  async sl() {
    try {
      if(this._mode !== "LIVE" || !this._stopLoss || this._stopLossOrderId !== null || this._isFake) return false;
      this.hold();
      const orderObj = {
        symbol: this._symbol,
        side: this._side === "LONG" ? "SELL" : "BUY",
        //positionSide: this._side,
        type: 'STOP_MARKET',
        quantity: this._baseAmountIn,
        stopPrice: this._stopLoss,
        reduceOnly: true,
      }
      const order = await this.service.order(orderObj);
      console.log("SL", order);
      if(order && order?.orderId) this._stopLossOrderId = order.orderId;
      this.release();
    } 
    catch(error) {
      console.log(error);
    }
  }
  
  async update() {
    try {
      if(this._orderId !== null && this._mode === "LIVE" && this._status !== "CLOSED" && !this.busy && !this._isFake) {
        const orderResponse = await this.service.getOrderByOrderId(this._symbol, this._orderId);
        console.log("ORDERRRRRRR:", orderResponse);
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

  async updateTpSl() {
    try {
      if(this._mode === "LIVE" && this._status !== "CLOSED" && !this.busy && !this._isFake) {
        if(this._takeProfitOrderId !== null) {
          const orderResponse = await this.service.getOrderByOrderId(this._symbol, this._takeProfitOrderId);
          console.log("TP UPDATE", orderResponse);
          if(orderResponse) {
            if(orderResponse?.status === "FILLED") await this.destroy();
          }
        }
        else {
          await this.tp();
        }
        if(this._stopLossOrderId !== null) {
          const orderResponse = await this.service.getOrderByOrderId(this._symbol, this._stopLossOrderId);
          console.log("SL UPDATE", orderResponse);
          if(orderResponse) {
            if(orderResponse?.status === "FILLED") await this.destroy();
          }
        }
        else {
          await this.sl();
        }
      }
    } 
    catch(error) {
      console.log(error);
    }
  } 

  async sync() {
    try {
      if(this._mode === "LIVE" && !this.busy) {
        if(this._status === "NEW") await this.update();
        if(this._status === "FILLED") await this.updateTpSl();
      }
      await this.dbSync();
    } 
    catch(error) {
      console.log(error);
    }
  }

  async cancel() {
    try {
      if(this._mode === "LIVE" && !this._isFake) {
        this.hold();
        if(this._orderId && this._status === "NEW") await this.service.cancelOrder({symbol: this._symbol, orderId: this._orderId});
        this.release();
      }
    }  
    catch(error) {
      console.log(error);
      this.release();
    }
  } 
  async cancelTp() {
    try {
      if(this._mode === "LIVE" && !this._isFake) {
        this.hold();
        if(this._takeProfitOrderId) await this.service.cancelOrder({symbol: this._symbol, orderId: this._takeProfitOrderId});
        this.release();
      }
    }  
    catch(error) {
      console.log(error);
      this.release();
    }
  } 
  async cancelSl() {
    try {
      if(this._mode === "LIVE" && !this._isFake) {
        this.hold();
        if(this._stopLossOrderId) await this.service.cancelOrder({symbol: this._symbol, orderId: this._stopLossOrderId});
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
      if(this._mode === "LIVE" && this._status !== "CLOSED" && !this.busy && !this._isFake) {
        this.hold();
        if(this._status === "FILLED" && this._type === "MARKET") {
          const closeOrder = await this.service.order({
            symbol: this._symbol,
            side: this._side === "LONG" ? "SELL" : "BUY",
            //positionSide: this._side,
            type: "MARKET",
            quantity: this._baseAmountIn,
            recvWindow: '10000'
          });
        }
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
      await this.cancel();
      await this.cancelTp();
      await this.cancelSl();
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
      this._takeProfit = this.trader._takeProfit > 0 ? this._side === "LONG" ? this._price + this.trader._takeProfit : this._price  - this.trader._takeProfit : 0;
      this._stopLoss = this.trader._stopLoss > 0 ? this._side === "LONG" ? this._price - this.trader._stopLoss : this._price + this.trader._stopLoss : 0;

      if(
        this._status === "NEW"
        &&
        ((((this._position === "HIGHER" && this.ticker.currentPrice >= this._price)
        ||
        (this._position === "LOWER" && this.ticker.currentPrice <= this._price)))
        ||
        ((this._type === "LIMIT" || this._type === "STOP_MARKET") && this._mode === "LIVE" && !this._isFake)
        )
      ) {
        await this.fill();
      }
      
      if(
        this._mode === "TESTING" 
        &&
        (
          (this._side === "LONG" && this.ticker.getQuoteQuantity(this.ticker.currentPrice) >= this.ticker.getQuoteQuantity(this._takeProfit) && this.ticker.getQuoteQuantity(this._takeProfit) !== 0 && this._status === "FILLED")
          ||
          (this._side === "SHORT" && this.ticker.getQuoteQuantity(this.ticker.currentPrice) <= this.ticker.getQuoteQuantity(this._takeProfit) && this.ticker.getQuoteQuantity(this._takeProfit) !== 0 && this._status === "FILLED")
          ||
          (this._side === "SHORT" && this.ticker.getQuoteQuantity(this.ticker.currentPrice) >= this.ticker.getQuoteQuantity(this._stopLoss) && this.ticker.getQuoteQuantity(this._stopLoss) !== 0 && this._status === "FILLED")
          ||
          (this._side === "LONG" && this.ticker.getQuoteQuantity(this.ticker.currentPrice) <= this.ticker.getQuoteQuantity(this._stopLoss) && this.ticker.getQuoteQuantity(this._stopLoss) !== 0 && this._status === "FILLED")
        )
      ) await this.close();

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
