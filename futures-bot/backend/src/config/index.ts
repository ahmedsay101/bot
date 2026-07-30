import Joi from 'joi';
import dotenv from 'dotenv';

dotenv.config();

interface AppConfig {
  node: {
    env: string;
    port: number;
    workerPort: number;
  };
  database: {
    url: string;
  };
  redis: {
    url: string;
    host: string;
    port: number;
    password?: string;
  };
  binance: {
    apiKey: string;
    secretKey: string;
    baseUrl: string;
    futuresBaseUrl: string;
    futuresWsUrl: string;
    testnet: boolean;
  };
  jwt: {
    secret: string;
    expiresIn: string;
  };
  trading: {
    mode: 'LIVE' | 'SIMULATION';
    maxTraders: number;
    initialCapital: string;
    positionSize: string;
    leverage: number;
    marginMode: 'ISOLATED' | 'CROSSED';
    hedgeDistance: string;
    hedgeTpPercent: string;
    hedgeSlPercent: string;
    shortTpPercent: string;
    refreshInterval: number;
    retryLimit: number;
    feeRate: string;
    slippage: string;
  };
  logging: {
    level: string;
    dir: string;
  };
}

const schema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
  PORT: Joi.number().integer().min(1).max(65535).default(3001),
  WORKER_PORT: Joi.number().integer().min(1).max(65535).default(3002),
  DATABASE_URL: Joi.string().required(),
  REDIS_URL: Joi.string().default('redis://localhost:6379'),
  REDIS_HOST: Joi.string().default('localhost'),
  REDIS_PORT: Joi.number().integer().default(6379),
  REDIS_PASSWORD: Joi.string().optional().allow(''),
  BINANCE_API_KEY: Joi.string().required(),
  BINANCE_SECRET_KEY: Joi.string().required(),
  BINANCE_BASE_URL: Joi.string().default('https://api.binance.com/api/v3'),
  BINANCE_FUTURES_BASE_URL: Joi.string().default('https://fapi.binance.com/fapi/v1'),
  BINANCE_FUTURES_WS_URL: Joi.string().default('wss://fstream.binance.com'),
  BINANCE_TESTNET: Joi.boolean().default(false),
  JWT_SECRET: Joi.string().min(32).required(),
  TRADING_MODE: Joi.string().valid('LIVE', 'SIMULATION').default('SIMULATION'),
  MAX_TRADERS: Joi.number().integer().min(1).max(50).default(5),
  INITIAL_CAPITAL: Joi.string().default('1000'),
  POSITION_SIZE: Joi.string().default('100'),
  LEVERAGE: Joi.number().integer().min(1).max(125).default(10),
  MARGIN_MODE: Joi.string().valid('ISOLATED', 'CROSSED').default('ISOLATED'),
  HEDGE_DISTANCE: Joi.string().default('0.10'),
  HEDGE_TP_PERCENT: Joi.string().default('0.50'),
  HEDGE_SL_PERCENT: Joi.string().default('0.10'),
  SHORT_TP_PERCENT: Joi.string().default('0.20'),
  REFRESH_INTERVAL: Joi.number().integer().min(5000).default(60000),
  RETRY_LIMIT: Joi.number().integer().min(1).max(20).default(5),
  FEE_RATE: Joi.string().default('0.0004'),
  SLIPPAGE: Joi.string().default('0.0001'),
  LOG_LEVEL: Joi.string().valid('error', 'warn', 'info', 'debug').default('info'),
  LOG_DIR: Joi.string().default('logs'),
});

function loadConfig(): AppConfig {
  const { error, value: env } = schema.validate(process.env, { allowUnknown: true, abortEarly: false });

  if (error != null) {
    const messages = error.details.map((d) => d.message).join('\n');
    throw new Error(`Configuration validation error:\n${messages}`);
  }

  return {
    node: {
      env: env.NODE_ENV as string,
      port: env.PORT as number,
      workerPort: env.WORKER_PORT as number,
    },
    database: {
      url: env.DATABASE_URL as string,
    },
    redis: {
      url: env.REDIS_URL as string,
      host: env.REDIS_HOST as string,
      port: env.REDIS_PORT as number,
      password: (env.REDIS_PASSWORD as string) || undefined,
    },
    binance: {
      apiKey: env.BINANCE_API_KEY as string,
      secretKey: env.BINANCE_SECRET_KEY as string,
      baseUrl: env.BINANCE_BASE_URL as string,
      futuresBaseUrl: env.BINANCE_FUTURES_BASE_URL as string,
      futuresWsUrl: env.BINANCE_FUTURES_WS_URL as string,
      testnet: env.BINANCE_TESTNET as boolean,
    },
    jwt: {
      secret: env.JWT_SECRET as string,
      expiresIn: '24h',
    },
    trading: {
      mode: env.TRADING_MODE as 'LIVE' | 'SIMULATION',
      maxTraders: env.MAX_TRADERS as number,
      initialCapital: env.INITIAL_CAPITAL as string,
      positionSize: env.POSITION_SIZE as string,
      leverage: env.LEVERAGE as number,
      marginMode: env.MARGIN_MODE as 'ISOLATED' | 'CROSSED',
      hedgeDistance: env.HEDGE_DISTANCE as string,
      hedgeTpPercent: env.HEDGE_TP_PERCENT as string,
      hedgeSlPercent: env.HEDGE_SL_PERCENT as string,
      shortTpPercent: env.SHORT_TP_PERCENT as string,
      refreshInterval: env.REFRESH_INTERVAL as number,
      retryLimit: env.RETRY_LIMIT as number,
      feeRate: env.FEE_RATE as string,
      slippage: env.SLIPPAGE as string,
    },
    logging: {
      level: env.LOG_LEVEL as string,
      dir: env.LOG_DIR as string,
    },
  };
}

export const config = loadConfig();
export type { AppConfig };
