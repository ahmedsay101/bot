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

/*(async() => {
    const data = {
        symbol: "UNIUSDT",
        baseAmountIn: Number(10),
        takeProfit: Number(100),
        stepSize: Number(0.05),
        stopLoss: 0,
        leverage: 1,
        mode: "LIVE",
        takeProfitStep: 1
    }
    await controller.createTrader(data);
})();*/

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

app.post('/login', async(req, res) => {
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

// Get dashboard data (top gainers, losers, and traders)
app.get('/dashboard', authenticate, async (req, res) => {
    console.log('Dashboard endpoint hit');
    try {
        console.log('Fetching market data...');
        const [topGainers, topLosers] = await Promise.all([
            controller.service.getTopGainers(10),
            controller.service.getTopLosers(10)
        ]);
        console.log('Market data fetched, getting traders...');

        const traders = controller.traders.map(trader => trader.getTradingSummary());
        const tradingMode = controller.getTradingMode();
        console.log('Dashboard data prepared, sending response');

        return res.status(200).json({
            topGainers: topGainers,
            topLosers: topLosers,
            currentTraders: traders.sort((a, b) => (b.realTimeTotalProfit || 0) - (a.realTimeTotalProfit || 0)),
            tradingMode: tradingMode,
            totalTraders: controller.traders.length,
            maxTraders: controller.maxTraders,
            settings: {
                minContractPrice: controller.minContractPrice,
                minContractDays: controller.minContractDays
            }
        });
    }
    catch(error) {
        console.log('Dashboard error:', error);
        return res.status(500).json({success: false, message: "Something went wrong!", error: error.message});
    }
});

// Manual scan for new trading opportunities
app.post('/scan-opportunities', authenticate, async (req, res) => {
    try {
        console.log('Manual trader scan triggered via API');
        await controller.createTradersFromGainers();
        
        return res.status(200).json({
            success: true,
            message: 'Scan completed',
            activeTraders: controller.traders.length,
            maxTraders: controller.maxTraders
        });
    }
    catch(error) {
        console.log('Manual scan error:', error);
        return res.status(500).json({success: false, message: "Scan failed", error: error.message});
    }
});

// Get specific trader details
app.get('/api/trader/:id', authenticate, (req, res) => {
    try {
        const traderId = req.params.id;
        const trader = controller.traders.find(t => t.id === traderId);
        
        if (!trader) {
            return res.status(404).json({success: false, message: "Trader not found"});
        }

        const traderSummary = trader.getTradingSummary();
        
        return res.status(200).json({
            success: true,
            data: traderSummary
        });
    }
    catch(error) {
        console.log(error);
        return res.status(500).json({success: false, message: "Something went wrong!"});
    }
});

// Legacy API for backwards compatibility
app.get('/api', authenticate, (req, res) => {
    try {
        const traders = controller.traders.map(trader => {
            const summary = trader.getTradingSummary();
            return {
                id: trader.id,
                symbol: summary.symbol,
                mode: trader.testingMode ? 'TESTING' : 'LIVE',
                currentPrice: summary.currentPrice,
                startPercentage: summary.startPercentage,
                highestPercentage: summary.highestPercentage,
                profit: summary.realTimeTotalProfit,
                averagePrice: summary.averagePrice,
                totalPosition: summary.totalPosition,
                takeProfitPrice: summary.takeProfitPrice,
                profitPercentage: summary.profitPercentage,
                status: summary.status,
                executedLevels: summary.executedLevels,
                transactions: summary.transactions,
                createdAt: trader.createdAt,
                updatedAt: trader.updatedAt
            };
        });

        return res.status(200).json({
            profit: traders.reduce((sum, t) => sum + t.profit, 0),
            traders: traders.sort((a, b) => b.profit - a.profit)
        });
    }
    catch(error) {
        console.log(error);
        return res.status(500).json({success: false, message: "Something Went Wrong!"});
    }
});

// Create trader from manual input
app.post('/api/trader', authenticate, async(req, res) => {
    try {
        const {
            symbol, 
            takeProfit = 20,
            testingMode
        } = req.body;
        
        if(!symbol) return res.status(400).json({success: false, message: "Symbol is required"});
        
        // Get current market data for the symbol
        const currentPrice = await controller.service.getPrice(symbol);
        if (!currentPrice) {
            return res.status(400).json({success: false, message: "Invalid symbol or no price data"});
        }

        const data = {
            symbol,
            percentage: 50, // Default starting percentage
            price: parseFloat(currentPrice.price),
            priceChange: "0",
            volume: "0",
            contractAge: 30,
            takeProfit: Number(takeProfit),
            testingMode: testingMode !== undefined ? testingMode : controller.testingMode
        };
        
        const trader = controller.addTrader(data);
        if (!trader) {
            return res.status(400).json({success: false, message: "Failed to create trader. Maximum traders reached."});
        }
        
        res.status(200).json({success: true, message: "Trader created successfully", data: trader.getTradingSummary()});
    }
    catch(error) {
        console.log(error);
        return res.status(500).json({success: false, message: "Something went wrong!"});
    }
});

// Toggle trading mode
app.put('/api/trading-mode', authenticate, (req, res) => {
    try {
        const { testingMode } = req.body;
        controller.setTradingMode(testingMode);
        
        res.status(200).json({
            success: true, 
            message: `Trading mode set to ${testingMode ? 'TESTING' : 'LIVE'}`,
            data: controller.getTradingMode()
        });
    }
    catch(error) {
        console.log(error);
        return res.status(500).json({success: false, message: "Something went wrong!"});
    }
});

// Scan for new trading opportunities
app.post('/api/scan-opportunities', authenticate, async(req, res) => {
    try {
        await controller.scanForTradingOpportunities();
        res.status(200).json({success: true, message: "Scan completed successfully"});
    }
    catch(error) {
        console.log(error);
        return res.status(500).json({success: false, message: "Something went wrong!"});
    }
});

// Legacy create trader endpoint
app.post('/api', authenticate, async(req, res) => {
    try {
        const {
            symbol, 
            baseAmountIn, 
            takeProfit, 
            stepSize, 
            stopLoss, 
            leverage = 10, 
            aim = 100, 
            mode = "LIVE", 
            takeProfitStep = 1,
            startsAt = 0,
            endsAt = 0,
            doubles,
        } = req.body;
        if(!symbol || !baseAmountIn) return res.status(400).json({success: false, message: "Missing Data!"});
        
        // Convert to new format
        const currentPrice = await controller.service.getPrice(symbol);
        const data = {
            symbol,
            percentage: 50,
            price: parseFloat(currentPrice.price),
            priceChange: "0",
            volume: "0",
            contractAge: 30,
            takeProfit: Number(takeProfit),
            testingMode: mode === "TESTING"
        };
        
        const trader = controller.addTrader(data);
        res.status(200).json({success: true, message: "Trader Created Successfully"});
    }
    catch(error) {
        console.log(error);
        return res.status(500).json({success: false, message: "Something Went Wrong!"});
    }
});

// Delete trader
app.delete('/api/trader/:id', authenticate, async(req, res) => {
    try {
        const traderId = req.params.id;
        const trader = controller.traders.find(t => t.id === traderId);
        
        if (!trader) {
            return res.status(404).json({success: false, message: "Trader not found"});
        }
        
        trader.destroy();
        controller.removeTrader(trader);
        
        res.status(200).json({success: true, message: "Trader destroyed successfully"});
    }
    catch(error) {
        console.log(error);
        return res.status(500).json({success: false, message: "Something went wrong!"});
    }
});

// Legacy delete endpoint
app.delete('/api/:id', authenticate, async(req, res) => {
    try {
        const traderId = req.params.id;
        const trader = controller.traders.find(one => one.id === traderId || JSON.stringify(one._id) === JSON.stringify(traderId));
        if(trader) {
            trader.destroy();
            controller.removeTrader(trader);
        }
        res.status(200).json({success: true, message: "Trader Destroyed Successfully"});
    }
    catch(error) {
        console.log(error);
        return res.status(500).json({success: false, message: "Something Went Wrong!"});
    }
});


app.listen(port, () => {
    console.log(`App is listening on port ${port}`);
});