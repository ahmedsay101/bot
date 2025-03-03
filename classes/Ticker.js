const cron = require('node-cron');
const { v4: uuidv4 } = require('uuid');
const { findMarketBySymbol, arrayAvg } = require("../lib/utils");

class Ticker {
  constructor(controller, symbol) {
    this.id = uuidv4();
    this.controller = controller;
    this.controller.addTicker(this);
    this.traders = [];
    this.symbol = symbol;
    this.priceMemoryLimit = 10;
    this.speedMemoryLimit = 100;
    this.priceMemory = [];
    this.speedMemory = [];
    this.avgSpeed = 0;
    this.market = findMarketBySymbol(this.symbol);
    this.orderBook = null;
    this.service = this.controller.service;

    this.bidPrice = 0;
    this.askPrice = 0;
    this.currentPrice = 0;
    this.bidPercentage = 0;
    this.askPercentage = 0;
    this.side = "LONG";

    this.createdAt = new Date();
    this.updatedAt = new Date();

    //this.interval = setInterval(this.tick.bind(this), 500);

    this.task = cron.schedule(`*/1 * * * * *`, async() => {
      await this.tick();
    });
  }

  reverse() {
    this.direction = this.direction === "LONG" ? "SHORT" : "LONG";
  }

  addTrader(trader) {
    if(this.traders.filter(one => one.id === trader.id).length < 1) {
        this.traders = [...this.traders, trader];
        trader.ticker = this;
    }
  }

  removeTrader(trader) {
    this.traders = this.traders.filter(one => one.id !== trader.id);
  }
  
  async updateTraders() {
    try {
      for(let trader of this.traders) {
        if(trader._status === "ACTIVE") await trader.tick();
      } 
    } 
    catch(error) {
      console.log(error);
    }
  }

  async tick() {
    try {
      const currentPrice = await this.service.getPrice(this.symbol);
      const price = Number(currentPrice.price);
      const lastPrice = this.priceMemory.length > 0 ? this.priceMemory[this.priceMemory.length - 1] : null;
      this.priceMemory = [...this.priceMemory, price];
      this.speedMemory = [...this.speedMemory, lastPrice ? lastPrice - price : 0].filter(sp => sp > 0);
      if(this.priceMemory.length > this.priceMemoryLimit) this.priceMemory.shift();
      if(this.speedMemory.length > this.speedMemoryLimit) this.speedMemory.shift();
      if(this.speedMemory.length >= this.speedMemoryLimit) this.avgSpeed = arrayAvg(this.speedMemory);
      this.currentPrice = price;
      //if(this.currentPrice > 86000) this.side = "SHORT";
      //if(this.currentPrice < 84000) this.side = "LONG";
      //this.currentPrice = this.side === "LONG" ? this.currentPrice += 20 : this.currentPrice -= 20;
      await this.updateTraders();
    }
    catch(error) {
        throw(error);
    }
  }

  orderByQuantity = (book) => {
    if(!this.symbol || !this.market) return;
    const results = book.sort((a, b) => Number(parseFloat(b[1]).toFixed(this.market.baseAssetPrecision)) - Number(parseFloat(a[1]).toFixed(this.market.baseAssetPrecision)));
    return results;
  }

  getQuoteQuantity(qty) {
    if(!this.symbol || !this.market) return qty;
    const quantity = Number(parseFloat(qty).toFixed(this.market.quoteAssetPrecision));
    return quantity;
  }

  getBaseQuantity(qty) {
    if(!this.symbol || !this.market) return qty;
    let quantity = Math.floor(qty / this.market.filters.find(filter => filter.filterType === "LOT_SIZE")?.stepSize);
    quantity = quantity * this.market.filters.find(filter => filter.filterType === "LOT_SIZE")?.stepSize;
    return Number(parseFloat(quantity).toFixed(this.market.baseAssetPrecision));
  } 
};

module.exports = { Ticker };
