const cron = require('node-cron');
const { findMarketBySymbol } = require("../lib/utils");
const { v4: uuidv4 } = require('uuid');

class Ticker {
  constructor(trader) {
    this.id = uuidv4();
    this.trader = trader;
    this.symbol = this.trader.symbol;
    this.speeds = [];
    this.market = findMarketBySymbol(this.symbol);
    this.orderBook = null;
    this.service = this.trader.service;

    this.bidPrice = 0;
    this.askPrice = 0;
    this.currentPrice = 0;
    this.bidPercentage = 0;
    this.askPercentage = 0;
    this.side = 0;

    /*this.direction = "LONG";

    this.interval = setInterval(() => {
      this.reverse();
    }, 50000);*/

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
      const currentPrice = await this.service.getPrice(this.symbol);
      const price = Number(currentPrice.price);
      const randomNumber = Math.floor(Math.random() * 100);
      //const testPrice = this.direction === "LONG" ? this.currentPrice += (randomNumber > 20 ? randomNumber : randomNumber + 20) : this.currentPrice -= (randomNumber > 20 ? randomNumber : randomNumber + 20);
      this.currentPrice = price;
      await this.trader.tick();
    }
    catch(error) {
        throw(error);
    }
  }

  calculatePriceData() {
    const bidPrice = this.getQuoteQuantity(this.orderBook.bids[0][0]);
    const askPrice = this.getQuoteQuantity(this.orderBook.asks[0][0]);
    const bids = this.orderByQuantity(this.orderBook.bids);
    const asks = this.orderByQuantity(this.orderBook.asks);

    const bidQuantity = bids.map(arr => Number(parseFloat(arr[1]).toFixed(this.market.baseAssetPrecision))).reduce((total, num) => Number(total + num));
    const askQuantity = asks.map(arr => Number(parseFloat(arr[1]).toFixed(this.market.baseAssetPrecision))).reduce((total, num) => Number(total + num)); 

    const bidPercentage = Math.floor(Number(bidQuantity / (bidQuantity + askQuantity)) * 100);
    const askPercentage = Math.floor(Number(askQuantity / (bidQuantity + askQuantity)) * 100);

    const side = bidPercentage > askPercentage && bidPercentage > this.trader.maxCloseRange ? "LONG" : askPercentage > bidPercentage && askPercentage > this.trader.maxCloseRange ? "SHORT" : "STABLE";
    const currentPrice = side === "LONG" ? askPrice : bidPrice; 

    this.bidPrice = bidPrice;
    this.askPrice = askPrice;
    this.currentPrice = currentPrice;
    this.bidPercentage = bidPercentage;
    this.askPercentage = askPercentage;
    this.side = side;

    console.log(`-------------------------${this.symbol}------------------------------`);
    console.log("CURRENT_PRICE", this.currentPrice);         
  }

  orderByQuantity = (book) => {
    const results = book.sort((a, b) => Number(parseFloat(b[1]).toFixed(this.market.baseAssetPrecision)) - Number(parseFloat(a[1]).toFixed(this.market.baseAssetPrecision)));
    return results;
  }

  getQuoteQuantity(qty) {
    const quantity = Number(parseFloat(qty).toFixed(this.market.quoteAssetPrecision));
    return quantity;
  }

  getBaseQuantity(qty) {
    let quantity = Math.floor(qty / this.market.filters.find(filter => filter.filterType === "LOT_SIZE")?.stepSize);
    quantity = quantity * this.market.filters.find(filter => filter.filterType === "LOT_SIZE")?.stepSize;
    return Number(parseFloat(quantity).toFixed(this.market.baseAssetPrecision));
  } 
};

module.exports = { Ticker };
