import { getIntegrationCorsOptions } from '@whyops/shared/cors';
import env from '@whyops/shared/env';
import { createAuthMiddleware, getAuthContext } from '@whyops/shared/middleware';
import { createServiceLogger } from '@whyops/shared/logger';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import { errorHandler } from './middleware/error';
import { rateLimitMiddleware } from './middleware/rateLimit';
import { requestLogMiddleware } from './middleware/requestLog';
import agentsRouter from './routes/agents';
import anthropicRouter from './routes/anthropic';
import healthRouter from './routes/health';
import openaiRouter from './routes/openai';

const logger = createServiceLogger('proxy');
const app = new Hono();

app.use('*', honoLogger());
app.use('*', cors(getIntegrationCorsOptions()));
app.use('*', requestLogMiddleware);

app.use('/v1/*', async (c, next) => {
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

app.route('/health', healthRouter);

const proxyAuthMiddleware = createAuthMiddleware({
  requireAuth: true,
  skipPaths: ['/health'],
  enableApiKeyAuth: true,
  enableSessionAuth: false,
  requireProjectEnv: true,
});

app.use('/v1/*', proxyAuthMiddleware);
app.use('/v1/*', rateLimitMiddleware);

app.route('/v1', openaiRouter);
app.route('/v1', anthropicRouter);
app.route('/v1', agentsRouter);

app.onError(errorHandler);

app.notFound((c) => {
  return c.json({ error: 'Not Found' }, 404);
});

const port = env.PROXY_PORT;

logger.info(`🚀 WhyOps Proxy Server starting on port ${port}`);

export default {
  port,
  fetch: app.fetch,
};
