const cron = require('node-cron');
const { v4: uuidv4 } = require('uuid');
const { findMarketBySymbol, arrayAvg } = require("../lib/utils");

class Ticker {
  constructor(trader) {
    this.id = uuidv4();
    this.trader = trader;
    this.symbol = this.trader._symbol;
    this.priceMemoryLimit = 10;
    this.speedMemoryLimit = 1000;
    this.priceMemory = [];
    this.speedMemory = [];
    this.avgSpeed = 0;
    this.market = findMarketBySymbol(this.symbol);
    this.orderBook = null;
    this.service = this.trader.service;

    this.bidPrice = 0;
    this.askPrice = 0;
    this.currentPrice = 0;
    this.bidPercentage = 0;
    this.askPercentage = 0;
    this.side = 0;

    this.createdAt = new Date();
    this.updatedAt = new Date();

    this.task = cron.schedule(`*/1 * * * * *`, async() => {
      await this.tick();
    });
  }

  reverse() {
    this.direction = this.direction === "LONG" ? "SHORT" : "LONG";
  }

  async tick() {
    try {
      this.symbol = this.trader._symbol;
      if(!this.symbol) return;
      const currentPrice = await this.service.getPrice(this.symbol);
      const price = Number(currentPrice.price);
      const lastPrice = this.priceMemory.lenth > 0 ? this.priceMemory[this.priceMemory.length - 1] : null;
      this.priceMemory = [...this.priceMemory, price];
      this.speedMemory = [...this.priceMemory, lastPrice ? lastPrice : price];
      if(this.priceMemory.length > this.priceMemoryLimit) this.priceMemory = [...this.priceMemory.shift()]
      if(this.speedMemory.length > this.speedMemory) this.speedMemory = [...this.speedMemory.shift()];
      if(this.speedMemory.length >= this.speedMemoryLimit) this.avgSpeed = arrayAvg(this.speedMemory);
      this.currentPrice = price;
      await this.trader.tick();
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
