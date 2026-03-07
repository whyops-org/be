import { Sequelize } from 'sequelize';
import env from '../config/env';
import { buildPgSslConfig, parseDatabaseUrl } from '../utils/helpers';
import logger from '../utils/logger';

let dbConfig: any;

if (env.DATABASE_URL) {
  const parsed = parseDatabaseUrl(env.DATABASE_URL);
  dbConfig = {
    host: parsed.host,
    port: parsed.port,
    database: parsed.database,
    username: parsed.username,
    password: parsed.password,
  };
} else {
  dbConfig = {
    host: env.DB_HOST,
    port: env.DB_PORT,
    database: env.DB_NAME,
    username: env.DB_USER,
    password: env.DB_PASSWORD,
  };
}

export const sequelize = new Sequelize({
  ...dbConfig,
  dialect: 'postgres',
  dialectOptions: {
    // Disable prepared statements to avoid "cached plan must not change result type" error
    // which can happen when schema changes or with connection pooling issues in some environments.
    // This forces pg to use simple queries.
    binary: false,
    ssl:
      buildPgSslConfig({
        databaseUrl: env.DATABASE_URL,
        dbHost: dbConfig.host,
        explicitSsl: env.DB_SSL,
        rejectUnauthorized: env.DB_SSL_REJECT_UNAUTHORIZED,
      }) || undefined,
  },
  benchmark: true,
  logging: (sql, timingMs) => {
    if (env.NODE_ENV === 'development') {
      logger.debug({ sql, timingMs }, 'SQL query executed');
      return;
    }

    if (typeof timingMs === 'number' && timingMs >= env.DB_SLOW_QUERY_MS) {
      logger.warn({ sql, timingMs }, 'Slow SQL query');
    }
  },
  pool: {
    max: env.DB_POOL_MAX,
    min: env.DB_POOL_MIN,
    acquire: 30000,
    idle: 10000,
  },
  define: {
    timestamps: true,
    underscored: true,
  },
});

export async function initDatabase() {
  try {
    await sequelize.authenticate();
    logger.info('Database connection established successfully');
    
    // Note: Using migrations for schema changes, not sync({ alter: true })
    // Sync with alter causes issues with constraint naming in PostgreSQL
    // Run `bun run db:migrate` to apply schema changes
    if (env.NODE_ENV === 'development') {
      try {
        // Only sync in development to create tables if they don't exist
        // This is safe as it won't alter existing tables
        await sequelize.sync();
        logger.info('Database synchronized');
      } catch (syncError) {
        logger.warn({ error: syncError }, 'Database sync failed, ignoring to allow startup');
      }
    }
  } catch (error) {
    logger.error({ error }, 'Unable to connect to the database');
    throw error;
  }
}

export async function closeDatabase() {
  try {
    await sequelize.close();
    logger.info('Database connection closed');
  } catch (error) {
    logger.error({ error }, 'Error closing database connection');
    throw error;
  }
}

export default sequelize;
