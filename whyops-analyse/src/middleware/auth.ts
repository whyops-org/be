import { ApiKey, Environment, Project, Provider } from '@whyops/shared/models';
import { hashApiKey } from '@whyops/shared/utils';
import type { Context, Next } from 'hono';
import { createServiceLogger } from '@whyops/shared/logger';

const logger = createServiceLogger('analyse:auth');

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
  }
}

/**
 * Auth middleware for analyse service
 * Extracts userId, projectId, environmentId from API key
 */
export async function analyseAuthMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');

  // No auth header - continue without auth (for internal service calls)
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    await next();
    return;
  }

  const apiKey = authHeader.substring(7);

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

  await next();
}
