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

const controller = new Controller();
let traders = [{symbol: "BTCUSDT", baseAmountIn: 0.002}, {symbol: "ETHUSDT", baseAmountIn: 0.3}, {symbol: "UNIUSDT", baseAmountIn: 10}];

(async() => {
    try {
        await controller.setTraders();
        if(controller.traders.length < 1) {
            console.log(controller.traders.map(obj => obj._id));
            for(let trader of traders) {
                controller.createTrader(trader);
            }
        }
    }
    catch(error) {
        console.log(error);
    }
})();

app.use(cors())

app.get('/api', (req, res) => {
    res.status(200).json(controller.traders.map(obj => {
        return {
            id: obj.id,
            symbol: obj.symbol,
            mode: obj.mode,
            leverage: obj.leverage,
            currentPrice: obj.ticker.currentPrice,
            baseAmountIn: obj.baseAmountIn,
            quoteAmountIn: obj.quoteAmountIn,
            moneyIn: obj.moneyIn,
            earnings: obj.earnings,
            totalProfit: obj.totalProfit,
            profit: obj.profit,
            losses: obj.losses,
            shifts: obj.shifts,
            maxShifts: obj.maxShifts,
            currentLosses: obj.currentLosses,
            fee: obj.fee,
            acceptableProfit: obj.acceptableProfit,
            acceptableLoss: obj.acceptableLoss,
            profitMultiplier: obj.profitMultiplier,
            maxPositions: obj.maxPositions,
            startedAt: obj.startedAt,
            updatedAt: obj.startedAt,
            transactions: obj.transactions.map(transaction => ({
                _id: transaction._id,
                side: transaction.side,
                price: transaction.price,
                orderId: transaction.orderId,
                baseAmountIn: transaction.baseAmountIn,
                baseAmountOut: transaction.baseAmountOut,
                quoteAmountIn: transaction.quoteAmountIn,
                quoteAmountOut: transaction.quoteAmountOut,
                profit: transaction.profit,
                status: transaction.status,
                acceptableProfit: transaction.acceptableProfit,
                acceptableLoss: transaction.acceptableLoss,
                isProfitable: transaction.isProfitable,
                createdAt: transaction.createdAt,
                updatedAt: transaction.createdAt,
            }))
        }
    }));
})

app.listen(port, () => {
    console.log(`App is listening on port ${port}`)
});