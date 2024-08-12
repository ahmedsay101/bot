const { Transactions } = require("../schema/transaction.schema");
const { v4: uuidv4 } = require('uuid');

class Transaction {
  constructor(trader, initialData = null) {
    this.trader = trader;
    this.traderId = this.trader._id;
    this.ticker = this.trader.ticker;
    this.createdAt = new Date();
    this.updatedAt = new Date();
    this.id = uuidv4();
    this._id = null;
    this.symbol = this.trader.symbol;
    this.side = null;
    this.price = this.ticker.currentPrice;
    this.orderId = null;
    this.baseAmountIn = this.trader.baseAmountIn;
    this.baseAmountOut = null;
    this.quoteAmountIn = this.trader.quoteAmountIn;
    this.quoteAmountOut = null;
    this.profit = 0;
    this.status = "NEW";
    this.currentPrice = 0;
    this.acceptableProfit = this.trader.acceptableProfit;
    this.acceptableLoss = this.trader.acceptableLoss;
    this.isProfitable = false;
    this.shifted = false;
    this.service = this.trader.service;

    if(typeof initialData === 'object' && initialData !== null) {
      const {
        symbol, 
        side = "LONG", 
        price, 
        baseAmountIn, 
        quoteAmountIn, 
        orderId, 
        baseAmountOut = 0, 
        quoteAmountOut = 0, 
        profit = 0, 
        status = "NEW", 
      } = initialData;
      this.symbol = symbol, 
      this.side = side, 
      this.price = price, 
      this.orderId = orderId, 
      this.baseAmountIn = baseAmountIn;
      this.baseAmountOut = baseAmountOut;
      this.quoteAmountIn = quoteAmountIn;
      this.quoteAmountOut = quoteAmountOut;
      this.profit = profit; 
      this.status = status;
    }
  }

  async fromId(_id) {
    this._id = _id;
    await this.get();
  }

  async fromOrderId(id) {
    this.orderId = id;
    await this.get();
  }
  
  async getLastTransaction() {
    try {
      const txs = await Transactions.aggregate([
        { $match: { symbol: this.symbol, mode: this.trader.mode, side: this.side } },
        { $project: {_id: 1, createdAt: 1} },
        { $sort: {createdAt: -1}},
        { $limit: 1 }
      ]).exec();
  
      if(txs.length > 0) {
        return txs[0];
      }

      return null;
    } catch (err) {
      throw err;
    }
  };

  async save() {
    try {
      if(this._id) {
        const data = {};
        if(this.traderId) data["traderId"] = this.traderId;
        if(this.symbol) data["symbol"] = this.symbol;
        if(this.side) data["side"] = this.side;
        if(this.price) data["price"] = this.price;
        if(this.baseAmountIn) data["baseAmountIn"] = this.baseAmountIn;
        if(this.baseAmountOut) data["baseAmountOut"] = this.baseAmountOut;
        if(this.quoteAmountIn) data["quoteAmountIn"] = this.quoteAmountIn;
        if(this.quoteAmountOut) data["quoteAmountOut"] = this.quoteAmountOut;
        if(this.profit) data["profit"] = this.profit;
        if(this.status) data["status"] = this.status;
        if(this.createdAt) data["createdAt"] = this.createdAt;
        if(this.updatedAt) data["updatedAt"] = this.updatedAt;
        data["isProfitable"] = this.isProfitable;
        data["shifted"] = this.shifted;

        if(Object.keys(data).length > 0) {
          const tx = await Transactions.findByIdAndUpdate(this._id, data);
          return tx;
        }
        return false;
      }
      else {
        if(!this.symbol || !this.side || !this.baseAmountIn || !this.quoteAmountIn || !this.price) return false;
        let dbData = {
          traderId: this.traderId,
          symbol: this.symbol, 
          side: this.side, 
          price: this.price, 
          type: this.type,
          baseAmountIn: this.baseAmountIn,
          baseAmountOut: this.baseAmountOut,
          quoteAmountIn: this.quoteAmountIn,
          quoteAmountOut: this.quoteAmountOut,
          profit: this.profit ? this.profit : 0, 
          status: this.trader.mode === "TESTING" ? "FILLED" : this.status,
          mode: this.trader.mode,
          isProfitable: this.isProfitable,
          shifted: this.shifted,
          createdAt: this.createdAt,
          updatedAt: this.updatedAt,
        };

        let tx = null;

        if(!this.trader.mode === "TESTING") {
          //Exec Order ---------------------------------------
          const payload = {
            quantity: this.baseAmountIn,
            symbol: this.symbol,
            side: this.side === "SHORT" ? "SELL" : "BUY",
            positionSide: this.side,
            type: "MARKET"
          }

          let orderResponse = await this.service.order(payload);
          console.log("orderResponse:", orderResponse);

          if(orderResponse) {
            this.status = orderResponse.status;

            dbData = {
              ...dbData,
              status: orderResponse.status,
              orderId: orderResponse.orderId
            }

            let actualBaseAmountIn = Number(orderResponse.executedQty) ? Number(orderResponse.executedQty) : Number(orderResponse.origQty),
            actualQuoteAmountIn = Number(orderResponse.cumQuote) ? Number(orderResponse.cumQuote) : this.quoteAmountIn,
            actualPrice = Number(orderResponse.price) ? Number(orderResponse.price) : this.price;

            if(this.status !== 'FILLED' && this.status !== "CLOSED" && !this.trader.mode === "TESTING") {
              orderResponse = await this.service.getOrderByOrderId(this.symbol, orderResponse.orderId);
              actualBaseAmountIn = Number(orderResponse.executedQty) ? Number(orderResponse.executedQty) : Number(orderResponse.origQty),
              actualQuoteAmountIn = Number(orderResponse.cumQuote) ? Number(orderResponse.cumQuote) : this.quoteAmountIn,
              actualPrice = Number(orderResponse.price) ? Number(orderResponse.price) : this.price;
            }

            this.baseAmountIn = actualBaseAmountIn;
            this.quoteAmountIn = actualQuoteAmountIn;            
            this.price = actualPrice;

            dbData = {
              ...dbData,
              baseAmountIn: actualBaseAmountIn,
              quoteAmountIn: actualQuoteAmountIn,
              price: actualPrice,
            }
            tx = await Transactions.create(dbData);
          }
        }
        else {
          this.status = "FILLED";
          tx = await Transactions.create(dbData);
        }

        if(tx) this._id = tx._id;
        if(this.status !== "CLOSED") this.trader.addTransaction(this);
        return tx;
      }
    } catch (err) {
      console.log(err);
      throw err;
    }
  }

  async get() {
    try {
      if(!this._id && !this.orderId) return false;
      const tx = this._id ? await Transactions.findById(this._id) : Transaction.findOne({orderId: this.orderId});
      this._id = tx._id;
      this.orderId = tx.orderId;
      this.symbol = tx.symbol;
      this.side = tx.side;
      this.price = Number(tx.price);
      this.baseAmountIn = Number(tx.baseAmountIn);
      this.baseAmountOut = tx.baseAmountOut ? Number(tx.baseAmountOut) : 0;
      this.quoteAmountIn = Number(tx.quoteAmountIn);
      this.quoteAmountOut = tx.quoteAmountOut ? Number(tx.quoteAmountOut) : 0;
      this.profit = tx.profit ? Number(tx.profit) : 0;
      this.status = tx.status;     
      this.isProfitable = tx.isProfitable;
      this.createdAt = new Date(tx.createdAt);
      this.updatedAt = new Date(tx.updatedAt);

      if(this.status !== "CLOSED") this.trader.addTransaction(this);
      this.tick();

      return tx;
    } catch (err) {
      throw err;
    }
  }

  async close()  {
    try {
      if(this.trader.mode === "TESTING") this.status = "CLOSED";
      const data = {
        status: "CLOSED", 
        closedAt: new Date(), 
        closingPrice: this.currentPrice, 
        baseAmountOut: this.baseAmountOut,
        quoteAmountOut: this.quoteAmountOut,
        profit: this.profit,
        isProfitable: this.isProfitable
      }
      
      let tx = null;

      if(this.trader.mode !== "TESTING") {
        const payload = {
          quantity: this.baseAmountIn,
          symbol: this.symbol,
          side: this.side === "SHORT" ? "BUY" : "SELL",
          positionSide: this.side,
          type: "MARKET"
        }

        let orderResponse = await this.service.order(payload);
        if(orderResponse) {
          console.log("orderResponse", orderResponse);
          this.status = "CLOSED";
          tx = await Transactions.findByIdAndUpdate(this._id, data);
        }
      }
      else {
        tx = await Transactions.findByIdAndUpdate(this._id, data);
      }

      await this.trader.removeTransaction(this);
      await this.save();
      return tx;
    } catch (err) {
      throw err;
    }
  };

  async tick() {
    if(this.status === "CLOSED") return;
    this.currentPrice = this.ticker.currentPrice;
    if(!this.currentPrice) return;

    if(this.status !== 'FILLED' && !this.trader.mode === "TESTING") {
      const orderResponse = await this.service.getOrderByOrderId(this.symbol, this.orderId);
      console.log("orderResponse", orderResponse);
      if(orderResponse) {
        this.status = orderResponse.status;
        this.baseAmountIn = Number(orderResponse.executedQty) ? Number(orderResponse.executedQty) : Number(orderResponse.origQty);
        this.quoteAmountIn = Number(orderResponse.cumQuote) ? Number(orderResponse.cumQuote) : this.quoteAmountIn;
        this.price = Number(orderResponse.price) ? Number(orderResponse.price) : this.price;
      }
    }

    this.acceptableProfit = this.trader.acceptableProfit;
    this.acceptableLoss = this.trader.acceptableLoss

    this.quoteAmountOut = this.side === "LONG" ? this.baseAmountIn * this.currentPrice : (this.quoteAmountIn + (this.quoteAmountIn - (this.baseAmountIn * this.currentPrice)));
    this.baseAmountOut = this.trader.ticker.getBaseQuantity(this.quoteAmountOut / this.currentPrice);
    this.closingPrice = this.currentPrice;
    this.profit = (this.quoteAmountOut - this.quoteAmountIn) - (this.quoteAmountIn * this.trader.fee);

    this.isProfitable = this.profit > this.acceptableProfit && this.acceptableProfit > 0;
    if(this.isProfitable) await this.close();
    await this.save();
  }

  static async getOpenTransactionsBySymbol(trader) {
    try {
      const txs = await Transactions.aggregate([
        { $match: { traderId: trader._id, symbol: trader.symbol, mode: trader.mode, status: {$ne: "CLOSED"} } },
        { $project: {_id: 1} },
        { $sort: {createdAt: -1} },
        { $limit: 100 }
      ]).exec();
  
      if(txs.length > 0) {
        const results = await Promise.all(txs.map(async(obj) => {
          const transaction = new Transaction(trader);
          await transaction.fromId(obj._id);
          return transaction;
        }));

        return results;
      }
      return [];
    } catch (err) {
      console.log(err);
      throw err;
    }
  };

};

module.exports = { Transaction };
