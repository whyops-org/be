import { createServiceLogger } from '@whyops/shared/logger';
import env from '@whyops/shared/env';
import type { Context, Next } from 'hono';
import type { AuthMiddlewareConfig, UnifiedAuthContext, SessionUser, UserSession } from './types';
import { extractApiKey } from './api-key-extractor';
import type { BetterAuthSession } from './auth-utils';
import { getSessionAuthContext, loadUserSession, loadUserSessionFast, loadUserSessionFromBetterAuth, validateApiKey } from './auth-utils';

const logger = createServiceLogger('middleware:auth');
const LOCAL_SESSION_CACHE_TTL_MS = env.AUTH_LOCAL_SESSION_CACHE_TTL_MS;
const SESSION_AUTH_CONTEXT_CACHE_TTL_MS = env.AUTH_MIDDLEWARE_SESSION_CONTEXT_CACHE_TTL_MS;
const localSessionCache = new Map<string, { expiresAtMs: number; session: unknown | null }>();
const localSessionInFlight = new Map<string, Promise<unknown | null>>();
const localSessionAuthContextCache = new Map<
  string,
  { expiresAtMs: number; context: UnifiedAuthContext | null }
>();
const localSessionAuthContextInFlight = new Map<string, Promise<UnifiedAuthContext | null>>();

const defaultConfig: AuthMiddlewareConfig = {
  requireAuth: false,
  skipPaths: [],
  enableApiKeyAuth: true,
  enableSessionAuth: true,
  requireProjectEnv: true,
  hydrateSessionUserFromDb: true,
};

function getCachedSessionAuthContext(userId: string): UnifiedAuthContext | null | undefined {
  const cached = localSessionAuthContextCache.get(userId);
  if (!cached) return undefined;
  if (Date.now() > cached.expiresAtMs) {
    localSessionAuthContextCache.delete(userId);
    return undefined;
  }
  return cached.context;
}

function setCachedSessionAuthContext(userId: string, context: UnifiedAuthContext | null): void {
  localSessionAuthContextCache.set(userId, {
    expiresAtMs: Date.now() + SESSION_AUTH_CONTEXT_CACHE_TTL_MS,
    context,
  });
}

async function resolveSessionAuthContext(userId: string): Promise<UnifiedAuthContext | null> {
  const cached = getCachedSessionAuthContext(userId);
  if (cached !== undefined) {
    return cached;
  }

  const existingInFlight = localSessionAuthContextInFlight.get(userId);
  if (existingInFlight) {
    return existingInFlight;
  }

  const fetchPromise = (async () => {
    const context = await getSessionAuthContext(userId);
    setCachedSessionAuthContext(userId, context ?? null);
    return context ?? null;
  })();

  localSessionAuthContextInFlight.set(userId, fetchPromise);

  try {
    return await fetchPromise;
  } finally {
    localSessionAuthContextInFlight.delete(userId);
  }
}

declare module 'hono' {
  interface ContextVariableMap {
    whyopsAuth: UnifiedAuthContext;
    sessionUser: SessionUser | null;
    sessionData: UserSession['session'] | null;
    authDurationMs: number;
  }
}

export function createAuthMiddleware(config: Partial<AuthMiddlewareConfig> = {}) {
  const finalConfig = { ...defaultConfig, ...config };

  return async function unifiedAuthMiddleware(c: Context, next: Next) {
    const authStartedAt = performance.now();

    try {
      if (finalConfig.skipPaths?.some((path) => c.req.path === path || c.req.path.startsWith(path))) {
        await next();
        return;
      }

      if (c.get('whyopsAuth')) {
        await next();
        return;
      }

      if (finalConfig.enableApiKeyAuth) {
        const apiKey = await extractApiKey(c);

        if (apiKey) {
          const result = await validateApiKey(apiKey);

          if (result.valid && result.context) {
            c.set('whyopsAuth', result.context);
            logger.debug(
              {
                userId: result.context.userId,
                projectId: result.context.projectId,
                authType: 'api_key',
              },
              'Request authenticated via API key'
            );
            await next();
            return;
          }

          if (finalConfig.requireAuth && !finalConfig.enableSessionAuth) {
            return c.json({ error: `Unauthorized: ${result.error}` }, 401);
          }
        }
      }

      if (finalConfig.enableSessionAuth) {
        const sessionData = finalConfig.hydrateSessionUserFromDb
          ? await loadUserSession(c)
          : await loadUserSessionFast(c);

        if (sessionData) {
          c.set('sessionUser', sessionData.user);
          c.set('sessionData', sessionData.session);

          if (finalConfig.requireProjectEnv) {
            const authContext = await resolveSessionAuthContext(sessionData.user.id);

            if (authContext && authContext.authType === 'session') {
              const sessionContext = {
                ...authContext,
                sessionId: sessionData.session.id,
                userEmail: sessionData.user.email,
                userName: sessionData.user.name,
              };
              c.set('whyopsAuth', sessionContext);
              logger.debug(
                {
                  userId: sessionContext.userId,
                  projectId: sessionContext.projectId,
                  authType: 'session',
                },
                'Request authenticated via session'
              );
              await next();
              return;
            }
          } else {
            c.set('whyopsAuth', {
              authType: 'session',
              userId: sessionData.user.id,
              projectId: '',
              environmentId: '',
              isMaster: true,
              sessionId: sessionData.session.id,
              userEmail: sessionData.user.email,
              userName: sessionData.user.name,
            });
            await next();
            return;
          }
        }
      }

      if (finalConfig.requireAuth) {
        return c.json({ error: 'Unauthorized: Authentication required' }, 401);
      }

      await next();
    } finally {
      c.set('authDurationMs', performance.now() - authStartedAt);
    }
  };
}

export const authMiddleware = createAuthMiddleware({ requireAuth: true });

export const optionalAuthMiddleware = createAuthMiddleware({ requireAuth: false });

export interface BetterAuthInstance {
  api: {
    getSession: (options: { headers: Headers }) => Promise<unknown>;
  };
}

function extractSessionTokenFromCookieHeader(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(
    /(?:^|;\s*)(?:__Secure-better-auth\.session_token|better-auth\.session_token)=([^;]+)/
  );
  return match?.[1] || null;
}

function isBetterAuthSession(value: unknown): value is BetterAuthSession {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.user === 'object' && candidate.user !== null &&
    typeof candidate.session === 'object' && candidate.session !== null;
}

export function createLocalSessionMiddleware(auth: BetterAuthInstance) {
  return async function localSessionMiddleware(c: Context, next: Next) {
    try {
      const cookieHeader = c.req.header('Cookie');
      const token = extractSessionTokenFromCookieHeader(cookieHeader);
      const cacheKey = token ? `session:${token}` : null;
      const now = Date.now();

      let session: unknown | null = null;
      if (cacheKey) {
        const cached = localSessionCache.get(cacheKey);
        if (cached && now <= cached.expiresAtMs) {
          session = cached.session;
        } else {
          const existingInFlight = localSessionInFlight.get(cacheKey);
          if (existingInFlight) {
            session = await existingInFlight;
          } else {
            const fetchPromise = auth.api.getSession({
              headers: c.req.raw.headers,
            });
            localSessionInFlight.set(cacheKey, fetchPromise);

            try {
              session = await fetchPromise;
            } finally {
              localSessionInFlight.delete(cacheKey);
            }

            localSessionCache.set(cacheKey, {
              expiresAtMs: Date.now() + LOCAL_SESSION_CACHE_TTL_MS,
              session: session ?? null,
            });
          }
        }
      } else {
        session = await auth.api.getSession({
          headers: c.req.raw.headers,
        });
      }

      if (!session) {
        c.set('sessionUser', null);
        c.set('sessionData', null);
        await next();
        return;
      }

      if (!isBetterAuthSession(session)) {
        c.set('sessionUser', null);
        c.set('sessionData', null);
        await next();
        return;
      }

      const sessionData = await loadUserSessionFromBetterAuth(session, {
        hydrateUserFromDb: false,
      });

      if (sessionData) {
        c.set('sessionUser', sessionData.user);
        c.set('sessionData', sessionData.session);
      } else {
        c.set('sessionUser', null);
        c.set('sessionData', null);
      }

      await next();
    } catch (error) {
      logger.error({ error }, 'Failed to load session');
      c.set('sessionUser', null);
      c.set('sessionData', null);
      await next();
    }
  };
}

export async function requireAuth(c: Context, next: Next) {
  const auth = c.get('whyopsAuth');
  const sessionUser = c.get('sessionUser');

  if (!auth && !sessionUser) {
    logger.warn('Unauthorized access attempt');
    return c.json({ error: 'Unauthorized: Authentication required' }, 401);
  }

  await next();
}

export async function requireApiKey(c: Context, next: Next) {
  const auth = c.get('whyopsAuth');

  if (!auth || auth.authType !== 'api_key') {
    return c.json({ error: 'Unauthorized: API key required' }, 401);
  }

  await next();
}

export async function requireSession(c: Context, next: Next) {
  const auth = c.get('whyopsAuth');
  const sessionUser = c.get('sessionUser');

  if (!auth && !sessionUser) {
    return c.json({ error: 'Unauthorized: Session authentication required' }, 401);
  }

  await next();
}

export function getAuthContext(c: Context): UnifiedAuthContext | undefined {
  return c.get('whyopsAuth');
}

export function getSessionUser(c: Context): SessionUser | null {
  return c.get('sessionUser');
}

export function getSessionData(c: Context): UserSession['session'] | null {
  return c.get('sessionData');
}
