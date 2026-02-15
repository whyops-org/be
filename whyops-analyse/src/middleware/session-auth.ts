import env from '@whyops/shared/env';
import { createServiceLogger } from '@whyops/shared/logger';
import { ApiKey, Environment, Project, Provider } from '@whyops/shared/models';
import { hashApiKey } from '@whyops/shared/utils';
import type { Context, Next } from 'hono';

const logger = createServiceLogger('analyse:session-auth');

export interface AnalyseAuthContext {
  userId: string;
  projectId: string;
  environmentId: string;
  providerId?: string;
  isMaster: boolean;
}

declare module 'hono' {
  interface ContextVariableMap {
    analyseAuth: AnalyseAuthContext;
    sessionUserId?: string;
  }
}

/**
 * Middleware to authenticate analyse requests.
 * Supports both API key auth and Better Auth session cookie auth.
 */
export async function sessionAuthMiddleware(c: Context, next: Next) {
  if (c.get('analyseAuth')) {
    await next();
    return;
  }

  const authHeader = c.req.header('Authorization');
  const xApiKeyHeader = c.req.header('X-API-Key') ?? c.req.header('x-api-key');

  let apiKey: string | undefined;
  if (authHeader?.startsWith('Bearer ')) {
    apiKey = authHeader.substring(7).trim();
  } else if (xApiKeyHeader) {
    apiKey = xApiKeyHeader.trim();
  }

  if (apiKey) {
    try {
      const keyHash = hashApiKey(apiKey);
      const apiKeyRecord = await ApiKey.findOne({
        where: {
          keyHash,
          isActive: true,
        },
        include: [
          { model: Project, as: 'project', required: true },
          { model: Environment, as: 'environment', required: true },
          { model: Provider, as: 'provider', required: false },
        ],
      });

      if (apiKeyRecord) {
        c.set('analyseAuth', {
          userId: apiKeyRecord.userId,
          projectId: apiKeyRecord.projectId,
          environmentId: apiKeyRecord.environmentId,
          providerId: apiKeyRecord.providerId ?? undefined,
          isMaster: apiKeyRecord.isMaster,
        });
      }
    } catch (error) {
      logger.error({ error }, 'Failed to validate API key');
    }
  }

  // If API key auth did not set context, try Better Auth session cookie auth
  if (!c.get('analyseAuth')) {
    try {
      let sessionUserId = c.get('sessionUserId');

      console.log(c.req.raw.headers)

      if (!sessionUserId) {
        const authUrl = env.AUTH_URL.replace(/\/$/, '');
        const response = await fetch(`${authUrl}/api/auth/get-session`, {
          method: 'GET',
          headers: c.req.raw.headers,
        });

        if (response.ok) {
          const data = await response.json() as {
            user?: { id: string };
            session?: { id: string; userId: string };
          } | null;

          sessionUserId = data?.user?.id;

          if (sessionUserId) {
            c.set('sessionUserId', sessionUserId);
          }
        }
      }

      if (sessionUserId) {
        const project = await Project.findOne({
          where: { userId: sessionUserId, isActive: true },
          order: [['createdAt', 'ASC']],
        });

        if (project) {
          const environment = await Environment.findOne({
            where: { projectId: project.id },
            order: [['createdAt', 'ASC']],
          });

          if (environment) {
            const apiKeyRecord = await ApiKey.findOne({
              where: {
                userId: sessionUserId,
                projectId: project.id,
                environmentId: environment.id,
                isMaster: true,
                isActive: true,
              },
              include: [{ model: Provider, as: 'provider', required: false }],
            });

            c.set('analyseAuth', {
              userId: sessionUserId,
              projectId: project.id,
              environmentId: environment.id,
              providerId: apiKeyRecord?.providerId ?? undefined,
              isMaster: true,
            });
          }
        }
      }
    } catch (error) {
      logger.error({ error }, 'Failed to validate session');
    }
  }

  await next();
}
