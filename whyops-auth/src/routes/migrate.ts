import env from '@whyops/shared/env';
import { createServiceLogger } from '@whyops/shared/logger';
import { buildPgSslConfig } from '@whyops/shared/utils';
import { getMigrations } from 'better-auth/db';
import { Hono } from 'hono';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';

const logger = createServiceLogger('auth:migrate');
const app = new Hono();

// Create Kysely instance
const db = new Kysely({
  dialect: new PostgresDialect({
    pool: new Pool({
      connectionString: env.DATABASE_URL,
      ssl: buildPgSslConfig({
        databaseUrl: env.DATABASE_URL,
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
      toBeCreated: toBeCreated.map(t => t.table),
      toBeAdded: toBeAdded.map(t => t.table),
    }, 'Running migrations');

    await runMigrations();

    logger.info('Migrations completed successfully');

    return c.json({
      success: true,
      message: 'Migrations completed successfully',
      tablesCreated: toBeCreated.map(t => t.table),
      tablesUpdated: toBeAdded.map(t => t.table),
    });
  } catch (error: any) {
    logger.error({ error }, 'Migration failed');
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Migration failed',
    }, 500);
  }
});

export default app;
