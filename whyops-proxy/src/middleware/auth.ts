import { createServiceLogger } from '@whyops/shared/logger';
import { ApiKey, Entity, Environment, Project, Provider } from '@whyops/shared/models';
import { hashApiKey } from '@whyops/shared/utils';
import type { Context, Next } from 'hono';

const logger = createServiceLogger('proxy:auth');

export interface AuthContext {
  apiKey: string;
  userId: string;
  apiKeyId: string;
  projectId: string;
  environmentId: string;
  environmentName: string;
  providerId?: string;
  entityId?: string;
  isMaster: boolean;
  provider?: any;
  project: any;
  environment: any;
  entity?: any;
}

declare module 'hono' {
  interface ContextVariableMap {
    auth: AuthContext;
  }
}

export async function authMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    logger.warn('Missing or invalid Authorization header');
    return c.json({ error: 'Unauthorized: Missing API key' }, 401);
  }

  const apiKey = authHeader.substring(7); // Remove 'Bearer '

  // Validate format - support both YOPS- and whyops_ prefixes
  const isYopsKey = apiKey.startsWith('YOPS-');
  const isWhyopsKey = apiKey.startsWith('whyops_');
  
  if (!isYopsKey && !isWhyopsKey) {
    logger.warn({ apiKey: apiKey.substring(0, 12) + '...' }, 'Invalid API key prefix');
    return c.json({ error: 'Unauthorized: Invalid API key format' }, 401);
  }

  try {
    // Hash and lookup
    const keyHash = hashApiKey(apiKey);
    
    const apiKeyRecord = await ApiKey.findOne({
      where: {
        keyHash,
        isActive: true,
      },
      include: [
        {
          model: Project,
          as: 'project',
          required: true,
        },
        {
          model: Environment,
          as: 'environment',
          required: true,
        },
        {
          model: Provider,
          as: 'provider',
          required: false,
        },
        {
          model: Entity,
          as: 'entity',
          required: false,
        },
      ],
    });

    if (!apiKeyRecord) {
      logger.warn({ keyHash: keyHash.substring(0, 16) + '...' }, 'API key not found');
      return c.json({ error: 'Unauthorized: Invalid API key' }, 401);
    }

    // Check expiration
    if (apiKeyRecord.expiresAt && new Date() > apiKeyRecord.expiresAt) {
      logger.warn({ apiKeyId: apiKeyRecord.id }, 'API key expired');
      return c.json({ error: 'Unauthorized: API key expired' }, 401);
    }

    // Check if project and environment are active
    const project = (apiKeyRecord as any).project;
    const environment = (apiKeyRecord as any).environment;

    if (!project?.isActive) {
      logger.warn({ projectId: apiKeyRecord.projectId }, 'Project is not active');
      return c.json({ error: 'Unauthorized: Project is not active' }, 401);
    }

    if (!environment?.isActive) {
      logger.warn({ environmentId: apiKeyRecord.environmentId }, 'Environment is not active');
      return c.json({ error: 'Unauthorized: Environment is not active' }, 401);
    }

    // Update last used (fire and forget)
    ApiKey.update(
      { lastUsedAt: new Date() },
      { where: { id: apiKeyRecord.id } }
    ).catch((err) => logger.error({ err }, 'Failed to update lastUsedAt'));

    // Set auth context with project and environment info
    c.set('auth', {
      apiKey: apiKey, // Store original API key for forwarding to analyse
      userId: apiKeyRecord.userId,
      apiKeyId: apiKeyRecord.id,
      projectId: apiKeyRecord.projectId,
      environmentId: apiKeyRecord.environmentId,
      environmentName: environment.name,
      providerId: apiKeyRecord.providerId,
      entityId: apiKeyRecord.entityId,
      isMaster: apiKeyRecord.isMaster,
      provider: (apiKeyRecord as any).provider,
      project,
      environment,
      entity: (apiKeyRecord as any).entity,
    });

    logger.debug({
      userId: apiKeyRecord.userId,
      projectId: apiKeyRecord.projectId,
      environmentId: apiKeyRecord.environmentId,
      environmentName: environment.name,
      isMaster: apiKeyRecord.isMaster,
    }, 'Request authenticated');

    await next();
  } catch (error) {
    logger.error({ error }, 'Auth middleware error');
    return c.json({ error: 'Internal server error' }, 500);
  }
}
