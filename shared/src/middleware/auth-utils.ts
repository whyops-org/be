import env from '@whyops/shared/env';
import { createServiceLogger } from '@whyops/shared/logger';
import { ApiKey, Entity, Environment, Project, Provider } from '@whyops/shared/models';
import {
  cacheApiKeyAuthContext,
  claimRedisThrottleGate,
  getCachedApiKeyAuthContext,
  prefixedRedisKey,
} from '@whyops/shared/services';
import { hashApiKey } from '@whyops/shared/utils';
import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import type { ApiKeyAuthContext, SessionAuthContext, SessionUser, UserSession } from './types';

const logger = createServiceLogger('auth:utils');
const REMOTE_SESSION_CACHE_TTL_MS = 15_000;
const SESSION_USER_CACHE_TTL_MS = 30_000;
const SESSION_AUTH_CONTEXT_CACHE_TTL_MS = 30_000;

const remoteSessionCache = new Map<
  string,
  { expiresAtMs: number; value: BetterAuthSession | null }
>();
const remoteSessionInFlight = new Map<string, Promise<BetterAuthSession | null>>();
const sessionUserCache = new Map<string, { expiresAtMs: number; user: SessionUser }>();
const sessionAuthContextCache = new Map<string, { expiresAtMs: number; context: SessionAuthContext | null }>();
const sessionAuthContextInFlight = new Map<string, Promise<SessionAuthContext | null>>();

function cloneSessionAuthContext(context: SessionAuthContext): SessionAuthContext {
  return {
    authType: context.authType,
    userId: context.userId,
    projectId: context.projectId,
    environmentId: context.environmentId,
    providerId: context.providerId,
    isMaster: context.isMaster,
    sessionId: context.sessionId,
    userEmail: context.userEmail,
    userName: context.userName,
  };
}

function extractSessionTokenFromCookieHeader(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(
    /(?:^|;\s*)(?:__Secure-better-auth\.session_token|better-auth\.session_token)=([^;]+)/
  );
  return match?.[1] || null;
}

function getRemoteSessionCacheKey(headers: Headers): string | null {
  const cookie = headers.get('Cookie') || headers.get('cookie');
  const token = extractSessionTokenFromCookieHeader(cookie);
  return token ? `session:${token}` : null;
}

function getCachedRemoteSession(cacheKey: string): BetterAuthSession | null | undefined {
  const cached = remoteSessionCache.get(cacheKey);
  if (!cached) return undefined;
  if (Date.now() > cached.expiresAtMs) {
    remoteSessionCache.delete(cacheKey);
    return undefined;
  }
  if (cached.value?.session?.expiresAt) {
    const sessionExpiresAtMs = new Date(cached.value.session.expiresAt).getTime();
    if (!Number.isFinite(sessionExpiresAtMs) || sessionExpiresAtMs <= Date.now()) {
      remoteSessionCache.delete(cacheKey);
      return undefined;
    }
  }
  return cached.value;
}

function setCachedRemoteSession(cacheKey: string, value: BetterAuthSession | null): void {
  remoteSessionCache.set(cacheKey, {
    expiresAtMs: Date.now() + REMOTE_SESSION_CACHE_TTL_MS,
    value,
  });
}

function getCachedSessionUser(userId: string): SessionUser | null {
  const cached = sessionUserCache.get(userId);
  if (!cached) return null;
  if (Date.now() > cached.expiresAtMs) {
    sessionUserCache.delete(userId);
    return null;
  }
  return cached.user;
}

function setCachedSessionUser(user: SessionUser): void {
  sessionUserCache.set(user.id, {
    expiresAtMs: Date.now() + SESSION_USER_CACHE_TTL_MS,
    user,
  });
}

function getCachedSessionAuthContext(userId: string): SessionAuthContext | null | undefined {
  const cached = sessionAuthContextCache.get(userId);
  if (!cached) return undefined;
  if (Date.now() > cached.expiresAtMs) {
    sessionAuthContextCache.delete(userId);
    return undefined;
  }
  return cached.context ? cloneSessionAuthContext(cached.context) : null;
}

function setCachedSessionAuthContext(userId: string, context: SessionAuthContext | null): void {
  sessionAuthContextCache.set(userId, {
    expiresAtMs: Date.now() + SESSION_AUTH_CONTEXT_CACHE_TTL_MS,
    context: context ? cloneSessionAuthContext(context) : null,
  });
}

async function touchApiKeyLastUsed(apiKeyId: string): Promise<void> {
  try {
    const shouldWrite = await claimRedisThrottleGate(
      prefixedRedisKey('auth', 'apikey', 'last-used', apiKeyId),
      env.APIKEY_LAST_USED_WRITE_INTERVAL_SEC
    );

    if (!shouldWrite) return;

    ApiKey.update(
      { lastUsedAt: new Date() },
      { where: { id: apiKeyId } }
    ).catch((err) => logger.error({ err, apiKeyId }, 'Failed to update lastUsedAt'));
  } catch (error) {
    logger.warn({ error, apiKeyId }, 'Failed to schedule lastUsedAt update');
  }
}

async function resolveSingleActiveProvider(userId: string): Promise<Provider | null> {
  const providers = await Provider.findAll({
    where: {
      userId,
      isActive: true,
    },
    order: [['createdAt', 'ASC']],
    limit: 2,
  });

  return providers.length === 1 ? providers[0] : null;
}

export interface BetterAuthSession {
  user: {
    id: string;
    email: string;
    name: string | null;
    image?: string | null;
    createdAt?: Date;
    updatedAt?: Date;
  };
  session: {
    id: string;
    userId: string;
    expiresAt: Date;
    ipAddress?: string | null;
    userAgent?: string | null;
  };
}

export async function getSessionFromAuthServer(headers: Headers): Promise<BetterAuthSession | null> {
  const authUrl = env.AUTH_URL.replace(/\/$/, '');
  const url = `${authUrl}/api/auth/get-session`;
  const cacheKey = getRemoteSessionCacheKey(headers);

  if (cacheKey) {
    const cached = getCachedRemoteSession(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const existingInFlight = remoteSessionInFlight.get(cacheKey);
    if (existingInFlight) {
      return existingInFlight;
    }
  }

  const fetchPromise = (async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    try {
      logger.debug({ url, authUrl }, 'Fetching session from auth service');
      
      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      logger.debug({ 
        status: response.status, 
        ok: response.ok,
        url 
      }, 'Session fetch response');

      if (response.ok) {
        const data = await response.json() as BetterAuthSession | null;
        return data;
      }
      
      logger.warn({ 
        status: response.status, 
        statusText: response.statusText,
        url 
      }, 'Session fetch returned non-OK status');
      return null;
    } catch (error) {
      clearTimeout(timeoutId);
      logger.warn({ error, authUrl, url }, 'Failed to fetch session from auth service');
      return null;
    }
  })();

  if (cacheKey) {
    remoteSessionInFlight.set(cacheKey, fetchPromise);
  }

  try {
    const result = await fetchPromise;
    if (cacheKey) {
      setCachedRemoteSession(cacheKey, result);
    }
    return result;
  } finally {
    if (cacheKey) {
      remoteSessionInFlight.delete(cacheKey);
    }
  }
}

export async function getSessionFromCookie(c: Context): Promise<BetterAuthSession | null> {
  // Check for both secure (production) and non-secure (development) cookie names
  const secureSessionToken = getCookie(c, '__Secure-better-auth.session_token');
  const sessionToken = getCookie(c, 'better-auth.session_token');
  const token = secureSessionToken || sessionToken;
  
  // Build headers - forward all cookies if we have them, or use specific cookie
  const headers = new Headers();
  
  if (token) {
    const cookieName = secureSessionToken ? '__Secure-better-auth.session_token' : 'better-auth.session_token';
    headers.set('Cookie', `${cookieName}=${token}`);
  } else {
    // Fallback: forward all cookies from the original request
    const cookieHeader = c.req.header('Cookie');
    if (cookieHeader) {
      headers.set('Cookie', cookieHeader);
    } else {
      return null;
    }
  }
  
  headers.set('Content-Type', 'application/json');

  return getSessionFromAuthServer(headers);
}

export async function validateApiKey(
  apiKey: string
): Promise<{ valid: boolean; context?: ApiKeyAuthContext; error?: string }> {
  const isYopsKey = apiKey.startsWith('YOPS-');
  const isWhyopsKey = apiKey.startsWith('whyops_');

  if (!isYopsKey && !isWhyopsKey) {
    return { valid: false, error: 'Invalid API key format' };
  }

  try {
    const keyHash = hashApiKey(apiKey);
    const cached = await getCachedApiKeyAuthContext(keyHash);

    if (cached?.cacheVersion === 1 && cached.context) {
      if (cached.expiresAt && new Date() > new Date(cached.expiresAt)) {
        return { valid: false, error: 'API key expired' };
      }

      const context = {
        ...(cached.context as unknown as Omit<ApiKeyAuthContext, 'apiKey'>),
        apiKey,
      } satisfies ApiKeyAuthContext;

      if (!context.providerId) {
        const inferredProvider = await resolveSingleActiveProvider(context.userId);
        if (inferredProvider) {
          context.providerId = inferredProvider.id;
          context.provider = inferredProvider as any;
        }
      }

      void touchApiKeyLastUsed(context.apiKeyId);

      return {
        valid: true,
        context,
      };
    }

    const apiKeyRecord = await ApiKey.findOne({
      where: {
        keyHash,
        isActive: true,
      },
      include: [
        { model: Project, as: 'project', required: true },
        { model: Environment, as: 'environment', required: true },
        { model: Provider, as: 'provider', required: false },
        { model: Entity, as: 'entity', required: false },
      ],
    });

    if (!apiKeyRecord) {
      return { valid: false, error: 'Invalid API key' };
    }

    if (apiKeyRecord.expiresAt && new Date() > apiKeyRecord.expiresAt) {
      return { valid: false, error: 'API key expired' };
    }

    const project = (apiKeyRecord as any).project;
    const environment = (apiKeyRecord as any).environment;

    if (!project?.isActive) {
      return { valid: false, error: 'Project is not active' };
    }

    if (!environment?.isActive) {
      return { valid: false, error: 'Environment is not active' };
    }

    let resolvedProviderId = apiKeyRecord.providerId ?? undefined;
    let resolvedProvider = (apiKeyRecord as any).provider;

    if (!resolvedProviderId) {
      const inferredProvider = await resolveSingleActiveProvider(apiKeyRecord.userId);
      if (inferredProvider) {
        resolvedProviderId = inferredProvider.id;
        resolvedProvider = inferredProvider as any;
      }
    }

    const context: ApiKeyAuthContext = {
      authType: 'api_key',
      apiKey,
      userId: apiKeyRecord.userId,
      projectId: apiKeyRecord.projectId,
      environmentId: apiKeyRecord.environmentId,
      providerId: resolvedProviderId,
      entityId: apiKeyRecord.entityId ?? undefined,
      isMaster: apiKeyRecord.isMaster,
      apiKeyId: apiKeyRecord.id,
      apiKeyPrefix: apiKeyRecord.keyPrefix,
      environmentName: environment.name,
      project,
      environment,
      provider: resolvedProvider,
      entity: (apiKeyRecord as any).entity,
    };

    const { apiKey: _apiKey, ...cacheableContext } = context;
    await cacheApiKeyAuthContext({
      cacheVersion: 1,
      apiKeyId: apiKeyRecord.id,
      keyHash,
      expiresAt: apiKeyRecord.expiresAt ? apiKeyRecord.expiresAt.toISOString() : null,
      context: cacheableContext as unknown as Record<string, unknown>,
    });

    void touchApiKeyLastUsed(apiKeyRecord.id);

    return {
      valid: true,
      context,
    };
  } catch (error) {
    logger.error({ error }, 'Failed to validate API key');
    return { valid: false, error: 'Internal server error' };
  }
}

export async function getSessionAuthContext(
  userId: string
): Promise<SessionAuthContext | null> {
  const cached = getCachedSessionAuthContext(userId);
  if (cached !== undefined) {
    return cached;
  }

  const existingInFlight = sessionAuthContextInFlight.get(userId);
  if (existingInFlight) {
    const context = await existingInFlight;
    return context ? cloneSessionAuthContext(context) : null;
  }

  const fetchPromise = (async () => {
    try {
      // Primary strategy: rank active master keys by usage recency, then creation time.
      // This aligns session-scoped dashboards with where traffic is actually flowing.
      const rankedMasterKeys = await ApiKey.findAll({
        where: {
          userId,
          isMaster: true,
          isActive: true,
        },
        include: [
          { model: Provider, as: 'provider', required: false },
          { model: Project, as: 'project', required: true, where: { isActive: true } },
          { model: Environment, as: 'environment', required: true, where: { isActive: true } },
        ],
        order: [['createdAt', 'DESC']],
        limit: 50,
      });

      const apiKeyRecord = rankedMasterKeys
        .slice()
        .sort((a, b) => {
          const aUsedAt = a.lastUsedAt?.getTime() ?? null;
          const bUsedAt = b.lastUsedAt?.getTime() ?? null;
          if (aUsedAt !== null && bUsedAt !== null) return bUsedAt - aUsedAt;
          if (aUsedAt !== null) return -1;
          if (bUsedAt !== null) return 1;
          return b.createdAt.getTime() - a.createdAt.getTime();
        })[0] ?? null;

      // Last resort fallback for legacy data: first active project/environment.
      let projectId: string | null = null;
      let environmentId: string | null = null;
      let providerId: string | undefined;

      if (apiKeyRecord) {
        const project = (apiKeyRecord as any).project as Project | undefined;
        const environment = (apiKeyRecord as any).environment as Environment | undefined;
        projectId = project?.id ?? null;
        environmentId = environment?.id ?? null;
        providerId = apiKeyRecord.providerId ?? undefined;
      }

      if (!projectId) {
        const project = await Project.findOne({
          where: { userId, isActive: true },
          order: [['createdAt', 'ASC']],
        });
        projectId = project?.id ?? null;
      }

      if (!environmentId && projectId) {
        const environment = await Environment.findOne({
          where: { projectId, isActive: true },
          order: [['createdAt', 'ASC']],
        });
        environmentId = environment?.id ?? null;
      }

      if (!projectId || !environmentId) {
        return null;
      }

      if (!providerId) {
        const inferredProvider = await resolveSingleActiveProvider(userId);
        if (inferredProvider) {
          providerId = inferredProvider.id;
        }
      }

      return {
        authType: 'session',
        userId,
        projectId,
        environmentId,
        providerId,
        isMaster: true,
        sessionId: '',
        userEmail: '',
      } satisfies SessionAuthContext;
    } catch (error) {
      logger.error({ error }, 'Failed to get session auth context');
      return null;
    }
  })();

  sessionAuthContextInFlight.set(userId, fetchPromise);

  try {
    const context = await fetchPromise;
    setCachedSessionAuthContext(userId, context);
    return context ? cloneSessionAuthContext(context) : null;
  } finally {
    sessionAuthContextInFlight.delete(userId);
  }
}

export async function loadUserSession(c: Context): Promise<{ user: SessionUser; session: UserSession['session'] } | null> {
  const sessionData = await getSessionFromCookie(c);
  
  if (!sessionData) {
    return null;
  }

  const cachedUser = getCachedSessionUser(sessionData.user.id);
  if (cachedUser) {
    return {
      user: {
        ...cachedUser,
        email: sessionData.user.email || cachedUser.email,
        name: sessionData.user.name ?? cachedUser.name,
      },
      session: sessionData.session,
    };
  }

  try {
    const { User } = await import('@whyops/shared/models');
    const appUser = await User.findByPk(sessionData.user.id);

    if (appUser) {
      const mergedUser: SessionUser = {
        id: sessionData.user.id,
        email: sessionData.user.email,
        name: sessionData.user.name,
        metadata: appUser.metadata,
        onboardingComplete: Boolean(appUser.metadata?.onboardingComplete),
        isActive: appUser.isActive,
      };
      setCachedSessionUser(mergedUser);
      return { user: mergedUser, session: sessionData.session };
    }

    const fallbackUser = {
      user: sessionData.user as SessionUser,
      session: sessionData.session,
    };
    setCachedSessionUser(fallbackUser.user);
    return fallbackUser;
  } catch (error) {
    logger.warn({ error }, 'Failed to load Sequelize user data, using Better Auth user');
    const fallbackUser = {
      user: sessionData.user as SessionUser,
      session: sessionData.session,
    };
    setCachedSessionUser(fallbackUser.user);
    return fallbackUser;
  }
}

export async function loadUserSessionFromBetterAuth(
  session: BetterAuthSession | null
): Promise<{ user: SessionUser; session: UserSession['session'] } | null> {
  if (!session) {
    return null;
  }

  const cachedUser = getCachedSessionUser(session.user.id);
  if (cachedUser) {
    return {
      user: {
        ...cachedUser,
        email: session.user.email || cachedUser.email,
        name: session.user.name ?? cachedUser.name,
      },
      session: session.session,
    };
  }

  try {
    const { User } = await import('@whyops/shared/models');
    const appUser = await User.findByPk(session.user.id);

    if (appUser) {
      const mergedUser: SessionUser = {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name,
        metadata: appUser.metadata,
        onboardingComplete: Boolean(appUser.metadata?.onboardingComplete),
        isActive: appUser.isActive,
      };
      setCachedSessionUser(mergedUser);
      return { user: mergedUser, session: session.session };
    }

    const fallbackUser = {
      user: session.user as SessionUser,
      session: session.session,
    };
    setCachedSessionUser(fallbackUser.user);
    return fallbackUser;
  } catch (error) {
    logger.warn({ error }, 'Failed to load Sequelize user data, using Better Auth user');
    const fallbackUser = {
      user: session.user as SessionUser,
      session: session.session,
    };
    setCachedSessionUser(fallbackUser.user);
    return fallbackUser;
  }
}
