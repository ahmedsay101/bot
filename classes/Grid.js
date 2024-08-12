const { v4: uuidv4 } = require('uuid');
const { Grids } = require("../schema/grids.schema");
const { Transaction } = require('./Transaction');

class Grid {
  constructor(trader, side) {
    this.id = uuidv4();
    this._id = null;

    this.trader = trader;
    this.trader.addGrid(this);
    this.service = this.trader.service;
    this.ticker = this.trader.ticker;
    this.symbol = this.trader.symbol;
    this.side = side;
    this.mode = this.trader.mode;
    this.status = "ACTIVE";
    this.profit = 0;
    this.acceptableProfit = this.trader.acceptableProfit;
    this.acceptableLoss = this.trader.acceptableLoss;
    this.acceptableshift = this.trader.quoteAmountIn / this.trader.leverage;

    this.transactions = [];

    this.createdAt = new Date();
    this.updatedAt = new Date();
  }

  async fromId(_id) {
      this._id = _id;
      await this.get();
  }

  async save() {
    try {
      if(this._id) {
        const data = {};
        if(this.symbol) data["symbol"] = this.symbol;
        if(this.side) data["side"] = this.side;
        if(this.transactions) data["transactions"] = this.transactions.length > 0 ? this.transactions.map(obj => obj._id) : [];
        if(this.status) data["status"] = this.status;
        if(this.createdAt) data["createdAt"] = this.createdAt;
        if(this.updatedAt) data["updatedAt"] = this.updatedAt;

        if(Object.keys(data).length > 0) {
          const grid = await Grids.findByIdAndUpdate(this._id, data);
          return grid;
        }
        return false;
      }
      else {
        if(!this.symbol || !this.side) return false;

        let dbData = {
          symbol: this.symbol, 
          side: this.side, 
          transactions: this.transactions.length > 0 ? this.transactions.map(obj => obj._id) : [],
          createdAt: this.createdAt,
          updatedAt: this.updatedAt,
        };

        const grid = await Grids.create(dbData);
        if(grid) this._id = grid._id;
        return grid;
      }
    } catch (err) {
      console.log(err);
      throw err;
    }
  }
    
  async get() {
    try {
      if(!this._id) return false;
      const grid =  await Grids.findById(this._id);
      if(grid) {
        this._id = grid._id;
        this.side = grid.side;
        this.symbol = grid.symbol;
        this.transactions = await Promise.all(grid.transactions.map(async(id) => {
          const transaction = await this.getTransactionById(id);
          return transaction;
        }));
        this.status = grid.status;     
        this.createdAt = new Date(grid.createdAt);
        this.updatedAt = new Date(grid.updatedAt);
        return grid;
      }
      return false;
    } catch (err) {
      throw err;
    }
  }

  getTransactions() {
    return this.side === "LONG" ? this.transactions.sort((a, b) => b.price - a.price) : this.transactions.sort((a, b) => a.price - b.price);
  }

  getFirstTransaction() {
    const transactions = this.getTransactions();
    return transactions.length > 0 ? transactions[0] : null;
  }

  getLastTransaction() {
    const transactions = this.getTransactions();
    return transactions.length === 1 ? transactions[0] : this.transactions.length > 1 ? transactions[this.transactions.length - 1] : null;
  }

  isLastTransaction(transaction) {
    const lastTransaction = this.getLastTransaction()
    return lastTransaction ? transaction.id === lastTransaction.id : false;
  }

  isFull() {
    return this.transactions.length === this.trader.maxPositionsPerGrid;
  }

  removeTransaction(transaction) {
    this.transactions = this.transactions.filter(obj => obj.id !== transaction.id);
  }

  addTransaction(transaction) {
    if(this.transactions.filter(one => one.id === transaction.id).length < 1 && transaction.status !== "CLOSED") {
        this.transactions = [...this.transactions, transaction];
    }
  }

  async getTransactionById(id) {
    try {
      const transaction = new Transaction(this);
      await transaction.fromId(id);  
      if(transaction.status !== "CLOSED") {
        this.addTransaction(transaction);
      }
      return transaction;
    }
    catch(error) {
      throw error;
    }
  }

  async newTransaction() {
    try {
      if(this.ticker.currentPrice > 0) {
        if(this.isFull() && Math.abs(this.getLastTransaction().profit) >= this.acceptableshift) {
          const transaction = this.getFirstTransaction();
          await transaction.close();
        }

        if(this.isFull()) return false;
        
        const data = {
          symbol: this.symbol,
          price: this.ticker.currentPrice,
          side: this.side,
          type: "MARKET",
          baseAmountIn: this.trader.baseAmountIn,
          quoteAmountIn: this.trader.baseAmountIn * this.ticker.currentPrice,
          mode: this.mode,
          status: "NEW",
        };

        const newTransaction = new Transaction(this, data);
        await newTransaction.save();
        await this.save();
      };
    }
    catch(error) {
      throw error;
    }
  }

  async start() {
    try {
      await this.newTransaction();
      await this.save();
    }
    catch(error) {
        console.log(error);
    }
  }

  async tick() {
    try {
      if(this.transactions.length < 1) {
        await this.newTransaction();
      }

      if(this.transactions.length < this.trader.transactionsLength) await this.refill();

      this.acceptableshift = this.trader.quoteAmountIn / this.trader.leverage;
      this.acceptableProfit = this.trader.acceptableProfit;
      this.acceptableLoss = this.trader.acceptableLoss;

      for(let transaction of this.transactions) {
        await transaction.tick();
      }

      this.profit = this.transactions.map(obj => obj.profit).reduce((total, current) => Number(total) + Number(current));
      this.update();
      await this.save();
    }
    catch(error) {
      throw(error);
    }
  }

  async refill() {
    try {
      if(this.status !== "CLOSED") {
        await this.newTransaction();
        return true;
      }
      return false;
    }
    catch(error) {
      console.log(error);
    }
  }

  async destroy() {
      try {
        this.status = "CLOSED";
        await Promise.all(this.transactions.map(async(transaction) => {
          await transaction.close();
          return transaction;
        }));
        this.transactions = [];
        await this.save();
      } 
      catch(error) {
        console.log(error);
      }
  }

  update() {
    this.updatedAt = new Date();
  }

  static async getOpenGridsBySymbol(trader) {
    try {
      const grids = await Grids.aggregate([
        { $match: { symbol: trader.symbol, mode: trader.mode, status: {$ne: "CLOSED"} } },
        { $project: {_id: 1} },
        { $sort: {createdAt: -1} },
        { $limit: 100 }
      ]);
      
      return grids;
    } catch (err) {
      console.log(err);
      throw err;
    }
  };
}

module.exports = { Grid };
