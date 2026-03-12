import env from '@whyops/shared/env';
import { createServiceLogger } from '@whyops/shared/logger';
import { buildPgSslConfig, parseDatabaseUrl } from '@whyops/shared/utils';
import { getMigrations } from 'better-auth/db/migration';
import { Hono } from 'hono';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';

interface MigrationTable {
  table: string;
}

const logger = createServiceLogger('auth:migrate');
const app = new Hono();

const parsedDbUrl = env.DATABASE_URL ? parseDatabaseUrl(env.DATABASE_URL) : null;

const poolConfig = env.DATABASE_URL
  ? {
      connectionString: env.DATABASE_URL,
      host: parsedDbUrl?.host,
      port: parsedDbUrl?.port,
      database: parsedDbUrl?.database,
      user: parsedDbUrl?.username,
    }
  : {
      host: env.DB_HOST,
      port: env.DB_PORT,
      database: env.DB_NAME,
      user: env.DB_USER,
    };

// Create Kysely instance
const db = new Kysely({
  dialect: new PostgresDialect({
    pool: new Pool({
      ...poolConfig,
      password: env.DB_PASSWORD,
      ssl: buildPgSslConfig({
        databaseUrl: env.DATABASE_URL,
        dbHost: parsedDbUrl?.host || env.DB_HOST,
        explicitSsl: env.DB_SSL,
        rejectUnauthorized: env.DB_SSL_REJECT_UNAUTHORIZED,
      }),
    }),
  }),
});

app.post('/', async (c) => {
  try {
    logger.info('Starting Better Auth migrations');

    const { toBeCreated, toBeAdded, runMigrations } = await getMigrations({
      database: {
        db,
        type: 'postgres',
      } as any,
    });

    if (toBeCreated.length === 0 && toBeAdded.length === 0) {
      logger.info('No migrations needed');
      return c.json({ 
        success: true,
        message: 'No migrations needed',
      });
    }

    logger.info({ 
      toBeCreated: toBeCreated.map((t: MigrationTable) => t.table),
      toBeAdded: toBeAdded.map((t: MigrationTable) => t.table),
    }, 'Running migrations');

    await runMigrations();

    logger.info('Migrations completed successfully');

    return c.json({
      success: true,
      message: 'Migrations completed successfully',
      tablesCreated: toBeCreated.map((t: MigrationTable) => t.table),
      tablesUpdated: toBeAdded.map((t: MigrationTable) => t.table),
    });
  } catch (error: any) {
    logger.error({ error }, 'Migration failed');
    return c.json({
      success: false,
      error: typeof error?.message === 'string' ? error.message : 'Migration failed',
    }, 500);
  }
});

export default app;
