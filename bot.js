require("dotenv").config();

const BinanceApi = require("./src/api/binanceApi");
const SymbolScanner = require("./src/core/symbolScanner");
const Controller = require("./src/core/controller");
const config = require("./src/utils/config");
const { log } = require("./src/utils/logger");

async function startBot() {
  log("BOOT", `Starting bot in ${config.mode.toUpperCase()} mode`);

  const api = new BinanceApi();
  const scanner = new SymbolScanner({ api });
  const controller = new Controller({ api, scanner });

  await controller.start();

  return { api, scanner, controller };
}

if (require.main === module) {
  startBot().catch((err) => {
    log("BOOT", `Fatal error: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  startBot
};
