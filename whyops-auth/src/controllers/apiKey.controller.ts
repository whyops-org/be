import { createServiceLogger } from '@whyops/shared/logger';
import { invalidateApiKeyAuthCacheByHash, invalidateApiKeyAuthCacheById } from '@whyops/shared/services';
import { hashApiKey } from '@whyops/shared/utils';
import { Context } from 'hono';
import { ApiKeyService, CreateApiKeyData, UpdateApiKeyData } from '../services';
import { ResponseUtil } from '../utils';

const logger = createServiceLogger('auth:apikey-controller');

export class ApiKeyController {
  static async listApiKeysMaskedByStage(c: Context) {
    try {
      const user = c.get('sessionUser');
      if (!user) {
        return ResponseUtil.unauthorized(c, 'Not authenticated');
      }

      const apiKeys = await ApiKeyService.listApiKeysMaskedByStage(user.id);

      return ResponseUtil.success(c, { apiKeys });
    } catch (error: any) {
      logger.error({ error }, 'Failed to fetch masked API keys');
      return ResponseUtil.internalError(c, 'Failed to fetch masked API keys');
    }
  }

  static async getUnmaskedApiKey(c: Context) {
    try {
      const user = c.get('sessionUser');
      if (!user) {
        return ResponseUtil.unauthorized(c, 'Not authenticated');
      }
      const id = c.req.param('id');

      const apiKey = await ApiKeyService.getUnmaskedApiKeyById(id, user.id);

      return ResponseUtil.success(c, { id, apiKey });
    } catch (error: any) {
      if (error.message === 'API key not found') {
        logger.warn({ apiKeyId: c.req.param('id') }, 'Unmasked API key lookup failed: not found');
        return ResponseUtil.notFound(c, error.message);
      }

      if (error.message === 'API key cannot be revealed. Rotate/regenerate this key.') {
        logger.warn({ apiKeyId: c.req.param('id') }, 'Unmasked API key lookup failed: key not revealable');
        return ResponseUtil.badRequest(c, error.message);
      }

      if (error.message === 'API key reveal is not available yet. Please run the latest database migration first.') {
        logger.warn({ apiKeyId: c.req.param('id') }, 'Unmasked API key lookup failed: migration missing');
        return ResponseUtil.badRequest(c, error.message);
      }

      logger.error({ error }, 'Failed to fetch unmasked API key');
      return ResponseUtil.internalError(c, 'Failed to fetch unmasked API key');
    }
  }

  static async listApiKeys(c: Context) {
    try {
      const user = c.get('sessionUser');
      if (!user) {
        return ResponseUtil.unauthorized(c, 'Not authenticated');
      }
      const projectId = c.req.query('projectId');
      const environmentId = c.req.query('environmentId');
      
      const apiKeys = await ApiKeyService.listApiKeys(user.id, {
        projectId,
        environmentId,
      });

      return ResponseUtil.success(c, { apiKeys });
    } catch (error: any) {
      logger.error({ error }, 'Failed to fetch API keys');
      return ResponseUtil.internalError(c, 'Failed to fetch API keys');
    }
  }

  static async createApiKey(c: Context) {
    try {
      const user = c.get('sessionUser');
      if (!user) {
        return ResponseUtil.unauthorized(c, 'Not authenticated');
      }
      const data = await c.req.json();
      
      const apiKeyRecord = await ApiKeyService.createApiKey({
        userId: user.id,
        ...data,
        expiresAt: data.expiresAt ? new Date(data.expiresAt) : undefined,
      } as CreateApiKeyData);

      await invalidateApiKeyAuthCacheById(apiKeyRecord.id);
      if (apiKeyRecord.apiKey) {
        await invalidateApiKeyAuthCacheByHash(hashApiKey(apiKeyRecord.apiKey));
      }

      return ResponseUtil.created(c, {
        id: apiKeyRecord.id,
        name: apiKeyRecord.name,
        apiKey: apiKeyRecord.apiKey,
        keyPrefix: apiKeyRecord.keyPrefix,
        projectId: apiKeyRecord.projectId,
        environmentId: apiKeyRecord.environmentId,
        providerId: apiKeyRecord.providerId,
        entityId: apiKeyRecord.entityId,
        isMaster: apiKeyRecord.isMaster,
        rateLimit: apiKeyRecord.rateLimit,
        expiresAt: apiKeyRecord.expiresAt,
        isActive: apiKeyRecord.isActive,
        createdAt: apiKeyRecord.createdAt,
        warning: 'Save this API key securely. You will not be able to retrieve it again.',
      });
    } catch (error: any) {
      logger.error({ error }, 'Failed to create API key');
      
      if (error.message.includes('not found')) {
        return ResponseUtil.notFound(c, error.message);
      }
      
      return ResponseUtil.internalError(c, 'Failed to create API key');
    }
  }

  static async getApiKey(c: Context) {
    try {
      const user = c.get('sessionUser');
      if (!user) {
        return ResponseUtil.unauthorized(c, 'Not authenticated');
      }
      const id = c.req.param('id');
      
      const apiKey = await ApiKeyService.getApiKeyById(id, user.id);

      if (!apiKey) {
        return ResponseUtil.notFound(c, 'API key not found');
      }

      return ResponseUtil.success(c, apiKey);
    } catch (error: any) {
      logger.error({ error }, 'Failed to fetch API key');
      return ResponseUtil.internalError(c, 'Failed to fetch API key');
    }
  }

  static async updateApiKey(c: Context) {
    try {
      const user = c.get('sessionUser');
      if (!user) {
        return ResponseUtil.unauthorized(c, 'Not authenticated');
      }
      const id = c.req.param('id');
      const data = await c.req.json() as UpdateApiKeyData;
      
      if (data.expiresAt) {
        data.expiresAt = new Date(data.expiresAt as any);
      }
      
      const apiKey = await ApiKeyService.updateApiKey(id, user.id, data);
      await invalidateApiKeyAuthCacheById(id);

      return ResponseUtil.success(c, {
        id: apiKey.id,
        name: apiKey.name,
        rateLimit: apiKey.rateLimit,
        expiresAt: apiKey.expiresAt,
        updatedAt: apiKey.updatedAt,
      });
    } catch (error: any) {
      logger.error({ error }, 'Failed to update API key');
      
      if (error.message === 'API key not found') {
        return ResponseUtil.notFound(c, error.message);
      }
      
      return ResponseUtil.internalError(c, 'Failed to update API key');
    }
  }

  static async deleteApiKey(c: Context) {
    try {
      const user = c.get('sessionUser');
      if (!user) {
        return ResponseUtil.unauthorized(c, 'Not authenticated');
      }
      const id = c.req.param('id');
      
      await ApiKeyService.deleteApiKey(id, user.id);
      await invalidateApiKeyAuthCacheById(id);

      return ResponseUtil.success(c, { message: 'API key revoked' });
    } catch (error: any) {
      logger.error({ error }, 'Failed to delete API key');
      
      if (error.message === 'API key not found') {
        return ResponseUtil.notFound(c, error.message);
      }
      
      return ResponseUtil.internalError(c, 'Failed to delete API key');
    }
  }

  static async toggleApiKey(c: Context) {
    try {
      const user = c.get('sessionUser');
      if (!user) {
        return ResponseUtil.unauthorized(c, 'Not authenticated');
      }
      const id = c.req.param('id');
      
      const isActive = await ApiKeyService.toggleApiKey(id, user.id);
      await invalidateApiKeyAuthCacheById(id);

      return ResponseUtil.success(c, { isActive });
    } catch (error: any) {
      logger.error({ error }, 'Failed to toggle API key');
      
      if (error.message === 'API key not found') {
        return ResponseUtil.notFound(c, error.message);
      }
      
      return ResponseUtil.internalError(c, 'Failed to toggle API key');
    }
  }

  static async regenerateApiKey(c: Context) {
    try {
      const user = c.get('sessionUser');
      if (!user) {
        return ResponseUtil.unauthorized(c, 'Not authenticated');
      }
      const id = c.req.param('id');

      const regenerated = await ApiKeyService.regenerateApiKey(id, user.id);
      await invalidateApiKeyAuthCacheById(id);
      await invalidateApiKeyAuthCacheByHash(hashApiKey(regenerated.apiKey));

      return ResponseUtil.success(c, {
        ...regenerated,
        warning: 'Save this regenerated API key securely. You will not be able to retrieve it again.',
      });
    } catch (error: any) {
      logger.error({ error }, 'Failed to regenerate API key');

      if (error.message === 'API key not found') {
        return ResponseUtil.notFound(c, error.message);
      }

      return ResponseUtil.internalError(c, 'Failed to regenerate API key');
    }
  }
}
