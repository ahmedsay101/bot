require("./lib/connection");
require("dotenv").config();
const cron = require('node-cron');
const fs = require("fs");
const { getInfo } = require("./lib/services");
const express = require('express');
const app = express();
const cors = require('cors');
const { Controller } = require("./classes/Controller");
const jwt = require('jsonwebtoken');

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

app.use(cors());
app.use(express.json());

const authenticate = async (req, res, next) => {
    try {
        if (req.headers && req.headers.authorization) {
            const token = req.headers.authorization.split(" ")[1];
            const decodedToken = jwt.verify(
                token,
                `${process.env.JWT_SECRET_KEY}`,
                (err, verifiedJwt) => {
                  if (err) {
                    return err.message;
                  } else {
                    return verifiedJwt;
                  }
                }
            );
            if(decodedToken) return next();
            else throw "Unauthorized!";
        }
        else {
            throw "Unauthorized!";
        }
    }   
    catch(error) {
        console.log(error);
        return res.status(401).json({success: false, message: "Unauthorized!"});
    }
}

app.post('/api/login', async(req, res) => {
    try {
        const validUsername = process.env.USER_NAME,
        validPassword = process.env.PASSWORD;
        const {username, password} = req.body;

        if(username === validUsername && password === validPassword) {
            const token = jwt.sign({ createdAt: new Date() }, process.env.JWT_SECRET_KEY);
            return res.status(200).json({success: true, message: "Logged In Successfully", token});
        }
        else {
            throw "Unauthorized!";
        }
    }
    catch(error) {
        console.log(error);
        return res.status(401).json({success: false, message: "Unauthorized!"});
    }
});

app.get('/api', authenticate, (req, res) => {
    try {
        return res.status(200).json({
            profit: controller.profit,
            traders: controller.traders.map(obj => {
                return {
                    id: obj.id,
                    _id: obj._id,
                    symbol: obj._symbol,
                    mode: obj._mode,
                    leverage: obj._leverage,
                    currentPrice: obj.ticker.currentPrice,
                    baseAmountIn: obj._baseAmountIn,
                    quoteAmountIn: obj._quoteAmountIn,
                    moneyIn: obj._moneyIn,
                    maxMoneyIn: obj._maxMoneyIn,
                    maxPrice: obj._maxPrice,
                    minPrice: obj._minPrice,
                    coverage: obj._coverage,
                    requiredTransactions: obj._requiredTransactions,
                    requiredBalance: obj._requiredBalance,
                    accumulatedProfit: obj._accumulatedProfit,
                    profit: obj._profit,
                    profitTaken: obj._profitTaken,
                    fee: obj._fee,
                    levels: [{type: "PRICE", price: obj.ticker.currentPrice}, ...obj._levels.map(p => ({type: "LEVEL", price: p}))].sort((a, b) => b.price - a.price),
                    takeProfit: obj._takeProfit,
                    stopLoss: obj._stopLoss,
                    stepSize: obj._stepSize,
                    speed: obj.ticker.avgSpeed,
                    status: obj._status,
                    direction: obj._direction,
                    aim: obj._aim,
                    lives: obj._lives,
                    type: obj._type,
                    totalProfit: obj._totalProfit,
                    peak: obj._peak,
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
            }).sort((a, b) => b.profit - a.profit)
        });
    }
    catch(error) {
        console.log(error);
        return res.status(500).json({success: false, message: "Something Went Wrong!"});
    }
})

app.post('/api', authenticate, async(req, res) => {
    try {
        const {symbol, baseAmountIn, takeProfit, stepSize, stopLoss, leverage = 10, aim = 1, lives = 0, hours = 0, type = "UNLIMITED", mode = "TESTING", direction = "BOTH"} = req.body;
        if(!symbol || !baseAmountIn) return res.status(400).json({success: false, message: "Missing Data!"});
        const data = {
            symbol,
            baseAmountIn: Number(baseAmountIn),
            takeProfit: Number(takeProfit),
            stepSize: Number(stepSize),
            stopLoss: Number(stopLoss),
            leverage: Number(leverage),
            type,
            mode,
            direction
        }
        if(type === "LIMITED") data["aim"] = aim;
        if(type !== "UNLIMITED") data["lives"] = lives;
        if(type === "TIMED") data["hours"] = hours;
        await controller.createTrader(data);
        res.status(200).json({success: true, message: "Trader Created Successfully"});
    }
    catch(error) {
        console.log(error);
        return res.status(500).json({success: false, message: "Something Went Wrong!"});
    }
});

app.delete('/api/:id', authenticate, async(req, res) => {
    try {
        const traderId = req.params.id;
        const trader = controller.traders.find(one => JSON.stringify(one._id) === JSON.stringify(traderId));
        if(trader) await trader.destroy(true);
        res.status(200).json({success: true, message: "Trader Destroyed Successfully"});
    }
    catch(error) {
        console.log(error);
        return res.status(500).json({success: false, message: "Something Went Wrong!"});
    }
})


app.listen(port, () => {
    console.log(`App is listening on port ${port}`)
});