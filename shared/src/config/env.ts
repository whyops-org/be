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

// Environment validation schema
const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().url().optional(),
  DB_HOST: z.string().default('localhost'),
  DB_PORT: z.coerce.number().default(5432),
  DB_NAME: z.string().default('whyops'),
  DB_USER: z.string().default('postgres'),
  DB_PASSWORD: z.string().default('postgres'),
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
});

export type Env = z.infer<typeof envSchema>;

export const env = envSchema.parse(process.env);



export default env;
