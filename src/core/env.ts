import { z } from 'zod';
import { config as dotenvConfig } from 'dotenv';

dotenvConfig();

const EnvSchema = z.object({
  MODE: z.enum(['test', 'live']).default('test'),

  BINANCE_API_KEY: z.string().default(''),
  BINANCE_API_SECRET: z.string().default(''),
  BINANCE_REST_BASE: z.string().url().default('https://fapi.binance.com'),
  BINANCE_WS_BASE: z.string().url().default('wss://fstream.binance.com'),

  MONGO_URI: z.string().default('mongodb://localhost:27017/bot'),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  API_PORT: z.coerce.number().int().positive().default(4000),
  API_HOST: z.string().default('0.0.0.0'),
  JWT_SECRET: z.string().min(8).default('dev-secret-change-me'),
  JWT_EXPIRES_IN: z.string().default('12h'),

  ADMIN_USERNAME: z.string().default('admin'),
  ADMIN_PASSWORD: z.string().min(4).default('changeme'),

  DASHBOARD_ORIGIN: z.string().default('http://localhost:5173'),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  LOG_PRETTY: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),

  LOOP_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
  SCANNER_INTERVAL_MS: z.coerce.number().int().positive().default(300_000),

  RNG_SEED: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env: Env = parsed.data;

if (env.MODE === 'live') {
  if (!env.BINANCE_API_KEY || !env.BINANCE_API_SECRET) {
    // eslint-disable-next-line no-console
    console.error('LIVE mode requires BINANCE_API_KEY and BINANCE_API_SECRET');
    process.exit(1);
  }
  if (env.JWT_SECRET === 'dev-secret-change-me') {
    // eslint-disable-next-line no-console
    console.error('LIVE mode requires a strong JWT_SECRET');
    process.exit(1);
  }
}
