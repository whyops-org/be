import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';

// Try to load .env from current directory or parent directory (monorepo root)
const envPath = path.resolve(process.cwd(), '.env');
const parentEnvPath = path.resolve(process.cwd(), '../.env');

if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else if (fs.existsSync(parentEnvPath)) {
  dotenv.config({ path: parentEnvPath });
}

const envBoolean = z.preprocess((value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n', 'off', ''].includes(normalized)) return false;
  }
  if (typeof value === 'number') return value !== 0;
  return value;
}, z.boolean());

// Environment validation schema
const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().url().optional(),
  DB_HOST: z.string().default('localhost'),
  DB_PORT: z.coerce.number().default(5432),
  DB_NAME: z.string().default('whyops'),
  DB_USER: z.string().default('postgres'),
  DB_PASSWORD: z.string().default('postgres'),
  DB_SSL: envBoolean.optional(),
  DB_SSL_REJECT_UNAUTHORIZED: envBoolean.default(false),
  DB_POOL_MAX: z.coerce.number().default(20),
  DB_POOL_MIN: z.coerce.number().default(5),
  
  // Application
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  
  // Services
  PROXY_PORT: z.coerce.number().default(8080),
  ANALYSE_PORT: z.coerce.number().default(8081),
  AUTH_PORT: z.coerce.number().default(8082),
  
  PROXY_URL: z.string().url().default('http://localhost:8080'),
  ANALYSE_URL: z.string().url().default('http://localhost:8081'),
  AUTH_URL: z.string().url().default('http://localhost:8082'),
  
  // Security
  JWT_SECRET: z.string().default('your-super-secret-jwt-key-change-in-production'),
  API_KEY_PREFIX: z.string().default('whyops'),
  
  // Rate Limiting
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60000), // 1 minute
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().default(100),
  
  // Proxy specific
  PROXY_TIMEOUT_MS: z.coerce.number().default(60000), // 60 seconds
  PROXY_MAX_RETRIES: z.coerce.number().default(3),

  // Redis (optional, for queue/cache/rate-limit)
  REDIS_URL: z.string().optional(),
  REDIS_KEY_PREFIX: z.string().default('whyops'),

  // Queue configuration
  EVENTS_STREAM_NAME: z.string().default('whyops:events'),
  EVENTS_DLQ_STREAM_NAME: z.string().default('whyops:events:dlq'),
  EVENTS_STREAM_GROUP: z.string().default('whyops-analyse-workers'),
  EVENTS_STREAM_MAX_LEN: z.coerce.number().default(200000),
  EVENTS_STREAM_BATCH_SIZE: z.coerce.number().default(100),
  EVENTS_STREAM_BLOCK_MS: z.coerce.number().default(2000),
  EVENTS_STREAM_RETRY_MAX: z.coerce.number().default(5),
  EVENTS_WORKER_ENABLED: envBoolean.default(true),

  // Cache configuration
  AUTH_APIKEY_CACHE_TTL_SEC: z.coerce.number().default(60),
  PROVIDER_CACHE_TTL_SEC: z.coerce.number().default(60),
  APIKEY_LAST_USED_WRITE_INTERVAL_SEC: z.coerce.number().default(300),
  
  // Better Auth
  BETTER_AUTH_URL: z.string().url().default('http://localhost:8082'),
  BETTER_AUTH_SECRET: z.string().min(32).default('your-better-auth-secret-change-in-production-min-32-chars'),
  
  // OAuth - GitHub
  AUTHGH_CLIENT_ID: z.string().default(''),
  AUTHGH_CLIENT_SECRET: z.string().optional(),
  
  // OAuth - Google
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  
  // Email - Maileroo
  MAILEROO_API_KEY: z.string().optional(),
  MAILEROO_FROM_EMAIL: z.string().email().default('noreply@whyops.com'),
  MAILEROO_FROM_NAME: z.string().default('WhyOps'),
  
  // Trusted Origins (for CORS and Better Auth)
  TRUSTED_ORIGINS: z.string().default('http://localhost:3000,http://localhost:5173'),

  COOKIE_DOMAIN: z.string().default('localhost'),

  // LLM Judge Configuration (via LiteLLM proxy)
  JUDGE_LLM_BASE_URL: z.string().default('https://litellm.whiteocean-2fb73b80.centralindia.azurecontainerapps.io/v1'),
  JUDGE_LLM_API_KEY: z.string().optional(),
  JUDGE_LLM_MODEL: z.string().default('azure/gpt-4.1'),
  JUDGE_LLM_TEMPERATURE: z.coerce.number().default(0),
  JUDGE_MAX_RETRIES: z.coerce.number().default(2),
});

export type Env = z.infer<typeof envSchema>;

export const env = envSchema.parse(process.env);

export function getTrustedOrigins(): string[] {
  const origins = env.TRUSTED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean);
  return origins;
}

export default env;
