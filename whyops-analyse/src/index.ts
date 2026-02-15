import { getWhyopsCorsOptions } from '@whyops/shared/cors';
import { initDatabase } from '@whyops/shared/database';
import env from '@whyops/shared/env';
import { createServiceLogger } from '@whyops/shared/logger';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import { sessionAuthMiddleware } from './middleware/session-auth';
import analyticsRouter from './routes/analytics';
import entitiesRouter from './routes/entities';
import eventsRouter from './routes/events';
import healthRouter from './routes/health';
import llmCostsRouter from './routes/llmCosts';
import threadsRouter from './routes/threads';
import visualizeRouter from './routes/visualize';

const logger = createServiceLogger('analyse');
const app = new Hono();

// Initialize database
await initDatabase();

// Global middleware
app.use('*', honoLogger());
app.use('*', cors(getWhyopsCorsOptions()));
app.use('*', sessionAuthMiddleware);

// Routes
app.route('/api/health', healthRouter);
app.route('/api/events', eventsRouter);
app.route('/api/threads', threadsRouter);
app.route('/api/analytics', analyticsRouter);
app.route('/api/visualize', visualizeRouter);
app.route('/api/entities', entitiesRouter);
app.route('/api/llm-costs', llmCostsRouter);

// 404 handler
app.notFound((c) => {
  return c.json({ error: 'Not Found' }, 404);
});

// Error handler
app.onError((err, c) => {
  logger.error({ err }, 'Request error');
  return c.json({ error: 'Internal server error' }, 500);
});

const port = env.ANALYSE_PORT;

logger.info(`🚀 WhyOps Analyse Server starting on port ${port}`);

export default {
  port,
  fetch: app.fetch,
};
