import { Sequelize } from 'sequelize';
import env from '../config/env';
import { parseDatabaseUrl } from '../utils/helpers';
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
    // ssl: env.DB_SSL ? { rejectUnauthorized: false } : undefined, // Removed as DB_SSL is not in env type
  },
  logging: env.NODE_ENV === 'development' ? (msg) => logger.debug(msg) : false,
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
    
    if (env.NODE_ENV === 'development') {
      try {
        await sequelize.sync({ alter: true });
        logger.info('Database synchronized');
      } catch (syncError) {
        // Retry without alter if it fails on constraint dropping
        // This is a common issue with Sequelize sync({ alter: true }) and Postgres
        logger.warn({ error: syncError }, 'Database sync with alter failed, trying without alter');
        try {
          await sequelize.sync();
          logger.info('Database synchronized (without alter)');
        } catch (retryError) {
           // Catch the specific regex error in Sequelize postgres dialect
           // This happens when parsing index definitions on some postgres versions
           logger.warn({ error: retryError }, 'Database sync failed completely, ignoring to allow startup');
        }
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
