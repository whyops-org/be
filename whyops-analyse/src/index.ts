import { getIntegrationCorsOptions } from '@whyops/shared/cors';
import { initDatabase } from '@whyops/shared/database';
import env from '@whyops/shared/env';
import { createAuthMiddleware, getAuthContext, requireAuth } from '@whyops/shared/middleware';
import { createServiceLogger } from '@whyops/shared/logger';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import analyticsRouter from './routes/analytics';
import agentAnalysesRouter from './routes/agent-analyses';
import agentSettingsRouter from './routes/agent-settings';
import analysesRouter from './routes/analyses';
import entitiesRouter from './routes/entities';
import eventsRouter from './routes/events';
import healthRouter from './routes/health';
import llmCostsRouter from './routes/llmCosts';
import threadsRouter from './routes/threads';
import visualizeRouter from './routes/visualize';
import { startAnalyseEventsWorker } from './services/events-queue.service';

const logger = createServiceLogger('analyse');
const app = new Hono();

await initDatabase();
await startAnalyseEventsWorker();

app.use('*', honoLogger());
app.use('*', cors(getIntegrationCorsOptions()));

app.route('/api/health', healthRouter);

const analyseAuthMiddleware = createAuthMiddleware({
  requireAuth: false,
  skipPaths: ['/api/health', '/api/health/'],
  enableApiKeyAuth: true,
  enableSessionAuth: true,
  requireProjectEnv: true,
  hydrateSessionUserFromDb: false,
});

app.use('/api/*', analyseAuthMiddleware);

app.use('/api/*', async (c, next) => {
  const startedAt = performance.now();
  await next();

  const totalMs = performance.now() - startedAt;
  const authMs = c.get('authDurationMs') ?? 0;
  const existing = c.res.headers.get('Server-Timing');
  const values = [
    existing,
    `auth;dur=${authMs.toFixed(1)}`,
    `total;dur=${totalMs.toFixed(1)}`,
  ].filter(Boolean);

  c.res.headers.set('Server-Timing', values.join(', '));
});

app.use('/api/*', async (c, next) => {
  const auth = getAuthContext(c);
  if (!auth) {
    return c.json({ error: 'Unauthorized: Authentication required' }, 401);
  }
  await next();
});

app.route('/api/events', eventsRouter);
app.route('/api/threads', threadsRouter);
app.route('/api/analyses', analysesRouter);
app.route('/api/analytics', analyticsRouter);
app.route('/api/visualize', visualizeRouter);
app.route('/api/entities', entitiesRouter);
app.route('/api/agent-settings', agentSettingsRouter);
app.route('/api/llm-costs', llmCostsRouter);
app.route('/api/agent-analyses', agentAnalysesRouter);

app.notFound((c) => {
  return c.json({ error: 'Not Found' }, 404);
});

app.onError((err, c) => {
  logger.error({ err }, 'Request error');
  return c.json({ error: 'Internal server error' }, 500);
});

const port = env.ANALYSE_PORT;

logger.info(`🚀 WhyOps Analyse Server starting on port ${port}`);

export default {
  port,
  idleTimeout: 120,
  fetch: app.fetch,
};
