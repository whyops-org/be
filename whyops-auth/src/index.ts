import { getIntegrationCorsOptions } from '@whyops/shared/cors';
import { initDatabase } from '@whyops/shared/database';
import env from '@whyops/shared/env';
import { createLocalSessionMiddleware, requireAuth, requireSession } from '@whyops/shared/middleware';
import { createServiceLogger } from '@whyops/shared/logger';
import type { Context, MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import { auth } from './lib/auth';
import apiKeysRouter from './routes/apiKeys';
import authRouter from './routes/auth';
import configRouter from './routes/config';
import devRouter from './routes/dev';
import healthRouter from './routes/health';
import migrateRouter from './routes/migrate';
import projectsRouter from './routes/projects';
import providersRouter from './routes/providers';
import usersRouter from './routes/users';
import { verifyEmailConnection } from './utils/email.util';

const logger = createServiceLogger('auth');
const app = new Hono();
const GET_SESSION_CACHE_TTL_MS = 10_000;
const getSessionCache = new Map<string, { expiresAtMs: number; payload: unknown }>();
const getSessionInFlight = new Map<string, Promise<unknown | null>>();

type MagicLinkRateState = Map<string, { count: number; start: number }>;
const MAGIC_LINK_RATE_LIMIT: MagicLinkRateState = new Map();

function extractSessionToken(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(
    /(?:^|;\s*)(?:__Secure-better-auth\.session_token|better-auth\.session_token)=([^;]+)/
  );
  return match?.[1] || null;
}

await initDatabase();
logger.info('Database initialized');

const emailConfigured = await verifyEmailConnection();
if (!emailConfigured) {
  logger.warn('Maileroo not configured. Magic link authentication will not work.');
  logger.warn('Please set MAILEROO_API_KEY environment variable.');
} else {
  logger.info('Maileroo email service configured successfully');
}

app.use('*', honoLogger());
app.use('*', cors(getIntegrationCorsOptions()));

const magicLinkLimiter: MiddlewareHandler = async (c: Context, next) => {
  const ipHeader =
    c.req.header('x-forwarded-for') ||
    c.req.header('x-real-ip') ||
    c.req.raw.headers.get('cf-connecting-ip') ||
    c.req.raw.headers.get('x-forwarded-for') ||
    'unknown';
  const ip = ipHeader.split(',')[0].trim() || 'unknown';
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;

  const entry = MAGIC_LINK_RATE_LIMIT.get(ip);

  if (!entry || now - entry.start > windowMs) {
    MAGIC_LINK_RATE_LIMIT.set(ip, { count: 1, start: now });
  } else if (entry.count >= 3) {
    return c.json({ error: 'Too many requests. Try again later.' }, 429);
  } else {
    entry.count += 1;
    MAGIC_LINK_RATE_LIMIT.set(ip, entry);
  }

  await next();
};

app.use('/api/auth/sign-in/magic-link', magicLinkLimiter);

app.route('/health', healthRouter);
app.route('/api/config', configRouter);

// Hot path optimization for frontend polling.
// Better Auth get-session can be called very frequently; short TTL cache avoids repeated DB hits.
app.get('/api/auth/get-session', async (c) => {
  const cookieHeader = c.req.header('Cookie');
  const token = extractSessionToken(cookieHeader);

  if (token) {
    const cacheKey = `session:${token}`;
    const cached = getSessionCache.get(cacheKey);
    if (cached && Date.now() <= cached.expiresAtMs) {
      return c.json(cached.payload, 200);
    }

    const existingInFlight = getSessionInFlight.get(cacheKey);
    if (existingInFlight) {
      const session = await existingInFlight;
      return c.json(session ?? null, 200);
    }

    const sessionPromise = auth.api.getSession({
      headers: c.req.raw.headers,
    });
    getSessionInFlight.set(cacheKey, sessionPromise);

    let session: unknown | null = null;
    try {
      session = await sessionPromise;
    } finally {
      getSessionInFlight.delete(cacheKey);
    }

    getSessionCache.set(cacheKey, {
      expiresAtMs: Date.now() + GET_SESSION_CACHE_TTL_MS,
      payload: session ?? null,
    });

    return c.json(session ?? null, 200);
  }

  const session = await auth.api.getSession({
    headers: c.req.raw.headers,
  });
  return c.json(session ?? null, 200);
});

// Better Auth handler - must be before session middleware
// Handles /api/auth/* endpoints like /api/auth/get-session, /api/auth/sign-in, etc.
app.on(['POST', 'GET'], '/api/auth/*', (c) => {
  return auth.handler(c.req.raw);
});

// Custom auth routes (for non-Better-Auth endpoints)
app.route('/api/auth', authRouter);

if (env.NODE_ENV === 'development') {
  app.route('/migrate', migrateRouter);
  app.route('/api/dev', devRouter);
}

// Session middleware for protected routes (NOT applied to /api/auth/*)
const sessionMiddleware = createLocalSessionMiddleware(auth);
app.use('/api/projects/*', sessionMiddleware);
app.use('/api/providers/*', sessionMiddleware);
app.use('/api/api-keys/*', sessionMiddleware);
app.use('/api/users/*', sessionMiddleware);

app.use('/api/projects/*', requireSession);
app.use('/api/providers/*', requireSession);
app.use('/api/api-keys/*', requireSession);
app.use('/api/users/*', requireSession);

app.route('/api/projects', projectsRouter);
app.route('/api/providers', providersRouter);
app.route('/api/api-keys', apiKeysRouter);
app.route('/api/users', usersRouter);

app.notFound((c) => {
  return c.json({ error: 'Not Found' }, 404);
});

app.onError((err, c) => {
  logger.error({ err }, 'Request error');
  return c.json({ error: 'Internal server error' }, 500);
});

const port = env.AUTH_PORT;

logger.info(`🚀 WhyOps Auth Server starting on port ${port}, working fine...`);

export default {
  port,
  fetch: app.fetch,
};
