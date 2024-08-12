const { getPrice, getAccount, getQuantity } = require("./services");

exports.getAccountData = async () => {
  try {
    const data = await getAccount();
    return data;
  } catch (error) {
    throw error;
  }
};

exports.getBalances = async () => {
    try {
      const data = await getAccount();
      return data?.balances;
    } catch (error) {
      throw error;
    }
};

exports.getAssetBalance = async (asset) => {
    try {
      const data = await getAccount();
      return data?.balances.find(obj => obj.asset === asset);
    } catch (error) {
      throw error;
    }
};

exports.isProfitable = async(market, amountIn, qty) => {
    try {
        console.log(`Analyzing ${market.symbol}`);

        const {price} = await getPrice(market.symbol);
        const earnings = price * qty;
        const profit = earnings - amountIn;

        console.log("Price", price);
        console.log("Amount In", amountIn);
        console.log("Qty", qty);
        console.log("Earnings", earnings);
        console.log("Profit", profit);

        if(profit >= (amountIn / 500)) return true;
        return false;
    }
    catch(error) {
        console.log(error);
        throw(error);
    }
}

exports.calculateProfit = async(market, amountIn, qty) => {
    try {
      const price = await getPrice(market.symbol);
      const earnings = price * qty;
      const profit = earnings - amountIn;
        return profit;
    }
    catch(error) {
        console.log(error);
        throw(error);
    }
}