
const markets = require("../data/symbols.json");

exports.wait = (time) => new Promise((resolve) => setTimeout(resolve, time));
exports.hoursPassed = (date) => Math.abs(new Date(date) - new Date()) / 36e5;
exports.compromise = (hours, amountIn, profit) => {
    return (hours >= 1 && (profit >= (amountIn / 600))) ||
    (hours >= 2 && (profit >= (amountIn / 700))) ||
    (hours >= 3 && (profit >= (amountIn / 800))) ||
    (hours >= 6 && (profit >= (amountIn / 900))) ||
    hours >= 12;
}
exports.randomIntFromInterval = (min, max) => {  
    return Math.floor(Math.random() * (max - min + 1) + min);
}
exports.findMarketBySymbol = (symbol) => markets.find(one => one.symbol === symbol);
exports.calculatePercentage = (from, to) => {
    return ((Number(parseFloat(from).toFixed(2)) / Number(parseFloat(to).toFixed(2))) * 100) - 100;
}


exports.arrayAvg = (arr) => {
    if(arr.length) {
        const sum = arr.reduce((total, current) => total + current);
        const avg = Number(sum) / Number(arr.length);
        return avg;
    }
    else {
        return 0;
    }
}
