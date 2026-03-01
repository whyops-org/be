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

    const context: ApiKeyAuthContext = {
      authType: 'api_key',
      apiKey,
      userId: apiKeyRecord.userId,
      projectId: apiKeyRecord.projectId,
      environmentId: apiKeyRecord.environmentId,
      providerId: apiKeyRecord.providerId ?? undefined,
      entityId: apiKeyRecord.entityId ?? undefined,
      isMaster: apiKeyRecord.isMaster,
      apiKeyId: apiKeyRecord.id,
      apiKeyPrefix: apiKeyRecord.keyPrefix,
      environmentName: environment.name,
      project,
      environment,
      provider: (apiKeyRecord as any).provider,
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
  try {
    const project = await Project.findOne({
      where: { userId, isActive: true },
      order: [['createdAt', 'ASC']],
    });

    if (!project) {
      return null;
    }

    const environment = await Environment.findOne({
      where: { projectId: project.id },
      order: [['createdAt', 'ASC']],
    });

    if (!environment) {
      return null;
    }

    const apiKeyRecord = await ApiKey.findOne({
      where: {
        userId,
        projectId: project.id,
        environmentId: environment.id,
        isMaster: true,
        isActive: true,
      },
      include: [{ model: Provider, as: 'provider', required: false }],
    });

    return {
      authType: 'session',
      userId,
      projectId: project.id,
      environmentId: environment.id,
      providerId: apiKeyRecord?.providerId ?? undefined,
      isMaster: true,
      sessionId: '',
      userEmail: '',
    };
  } catch (error) {
    logger.error({ error }, 'Failed to get session auth context');
    return null;
  }
}

export async function loadUserSession(c: Context): Promise<{ user: SessionUser; session: UserSession['session'] } | null> {
  const sessionData = await getSessionFromCookie(c);
  
  if (!sessionData) {
    return null;
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
      return { user: mergedUser, session: sessionData.session };
    }

    return {
      user: sessionData.user as SessionUser,
      session: sessionData.session,
    };
  } catch (error) {
    logger.warn({ error }, 'Failed to load Sequelize user data, using Better Auth user');
    return {
      user: sessionData.user as SessionUser,
      session: sessionData.session,
    };
  }
}

export async function loadUserSessionFromBetterAuth(
  session: BetterAuthSession | null
): Promise<{ user: SessionUser; session: UserSession['session'] } | null> {
  if (!session) {
    return null;
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
      return { user: mergedUser, session: session.session };
    }

    return {
      user: session.user as SessionUser,
      session: session.session,
    };
  } catch (error) {
    logger.warn({ error }, 'Failed to load Sequelize user data, using Better Auth user');
    return {
      user: session.user as SessionUser,
      session: session.session,
    };
  }
}
