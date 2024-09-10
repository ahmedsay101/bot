require("./lib/connection");
require("dotenv").config();
const cron = require('node-cron');
const fs = require("fs");
const { getInfo } = require("./lib/services");

const express = require('express');
const app = express();
const cors = require('cors');
const { Controller } = require("./classes/Controller");

const port = 5000;

cron.schedule(`0 0 0 * * *`, async() => {
    const {symbols} = await getInfo();
    const filter = symbols.filter(obj => 
        (obj.permissionSets.filter(arr => arr.includes("SPOT")).length > 0)
        && (obj.status.toLowerCase() === "trading")
    );
    fs.writeFileSync("./symbols.json", JSON.stringify(filter));
});

let traders = [
    {
        symbol: "BTCUSDT", 
        baseAmountIn: 0.1,
        takeProfit: 100,
        stopLoss: 500
    },
    {
        symbol: "ETHUSDT", 
        baseAmountIn: 0.5,
        takeProfit: 10,
        stopLoss: 50,
    },
    {
        symbol: "UNIUSDT", 
        baseAmountIn: 100,
        takeProfit: 0.05,
        stopLoss: 0.25
    }
]
const controller = new Controller(traders);

app.use(cors());

app.get('/api', (req, res) => {
    res.status(200).json(controller.traders.map(obj => {
        return {
            id: obj.id,
            symbol: obj._symbol,
            mode: obj._mode,
            leverage: obj._leverage,
            currentPrice: obj.ticker.currentPrice,
            baseAmountIn: obj._baseAmountIn,
            quoteAmountIn: obj._quoteAmountIn,
            moneyIn: obj._moneyIn,
            profit: obj._profit,
            profitTaken: obj._profitTaken,
            fee: obj._fee,
            levels: [{type: "PRICE", price: obj.ticker.currentPrice}, ...obj._prices.map(p => ({type: "LEVEL", price: p}))].sort((a, b) => b.price - a.price),
            takeProfit: obj._takeProfit,
            stopLoss: obj._stopLoss,
            stepSize: obj._stepSize,
            createdAt: obj._createdAt,
            updatedAt: obj._updatedAt,
            transactions: obj.transactions.map(transaction => ({
                _id: transaction._id,
                side: transaction._side,
                price: transaction._price,
                orderId: transaction._orderId,
                baseAmountIn: transaction._baseAmountIn,
                baseAmountOut: transaction._baseAmountOut,
                quoteAmountIn: transaction._quoteAmountIn,
                quoteAmountOut: transaction._quoteAmountOut,
                profit: transaction._profit,
                status: transaction._status,
                takeProfit: transaction._takeProfit,
                stopLoss: transaction._stopLoss,
                isProfitable: transaction._isProfitable,
                createdAt: transaction._createdAt,
                updatedAt: transaction._createdAt,
            }))
        }
    }));
})

app.listen(port, () => {
    console.log(`App is listening on port ${port}`)
});