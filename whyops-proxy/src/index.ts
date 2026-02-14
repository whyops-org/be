import env from '@whyops/shared/env';
import { createServiceLogger } from '@whyops/shared/logger';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import { authMiddleware } from './middleware/auth';
import { errorHandler } from './middleware/error';
import { rateLimitMiddleware } from './middleware/rateLimit';
import { requestLogMiddleware } from './middleware/requestLog';
import agentsRouter from './routes/agents';
import anthropicRouter from './routes/anthropic';
import healthRouter from './routes/health';
import openaiRouter from './routes/openai';

const logger = createServiceLogger('proxy');
const app = new Hono();

// Global middleware
app.use('*', honoLogger());
app.use('*', cors());
app.use('*', requestLogMiddleware);

// Health check (no auth required)
app.route('/health', healthRouter);

// Protected routes - require authentication
app.use('/v1/*', authMiddleware);
app.use('/v1/*', rateLimitMiddleware);

// Provider routes
app.route('/v1', openaiRouter);
app.route('/v1', anthropicRouter);
app.route('/v1', agentsRouter);

// Error handler
app.onError(errorHandler);

// 404 handler
app.notFound((c) => {
  return c.json({ error: 'Not Found' }, 404);
});

const port = env.PROXY_PORT;

logger.info(`🚀 WhyOps Proxy Server starting on port ${port}`);

export default {
  port,
  fetch: app.fetch,
};
