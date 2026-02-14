import { createServiceLogger } from '@whyops/shared/logger';
import { Context } from 'hono';
import { CreateProviderData, ProviderService, UpdateProviderData } from '../services';
import { ResponseUtil } from '../utils';
import { testProvider } from '../providers';

const logger = createServiceLogger('auth:provider-controller');

export class ProviderController {
  /**
   * List all providers for user
   */
  static async listProviders(c: Context) {
    try {
      const user = c.get('user');
      const providers = await ProviderService.listProviders(user.id);
      return ResponseUtil.success(c, { providers });
    } catch (error: any) {
      logger.error({ error }, 'Failed to fetch providers');
      return ResponseUtil.internalError(c, 'Failed to fetch providers');
    }
  }

  /**
   * Create a new provider
   */
  static async createProvider(c: Context) {
    try {
      const user = c.get('user');
      const data = await c.req.json();

      const provider = await ProviderService.createProvider({
        userId: user.id,
        ...data,
      } as CreateProviderData);

      return ResponseUtil.created(c, {
        id: provider.id,
        name: provider.name,
        slug: provider.slug,
        type: provider.type,
        baseUrl: provider.baseUrl,
        isActive: provider.isActive,
        createdAt: provider.createdAt,
      });
    } catch (error: any) {
      logger.error({ error }, 'Failed to create provider');

      // Return specific error messages
      if (error.message === 'A provider with this name already exists') {
        return ResponseUtil.conflict(c, error.message);
      }

      // Connection failed error
      if (error.message.startsWith('Connection failed:')) {
        return ResponseUtil.badRequest(c, error.message);
      }

      return ResponseUtil.internalError(c, 'Failed to create provider');
    }
  }

  /**
   * Get a single provider
   */
  static async getProvider(c: Context) {
    try {
      const user = c.get('user');
      const id = c.req.param('id');

      const provider = await ProviderService.getProviderById(id, user.id);

      if (!provider) {
        return ResponseUtil.notFound(c, 'Provider not found');
      }

      return ResponseUtil.success(c, provider);
    } catch (error: any) {
      logger.error({ error }, 'Failed to fetch provider');
      return ResponseUtil.internalError(c, 'Failed to fetch provider');
    }
  }

  /**
   * Update a provider
   */
  static async updateProvider(c: Context) {
    try {
      const user = c.get('user');
      const id = c.req.param('id');
      const data = await c.req.json() as UpdateProviderData;

      const provider = await ProviderService.updateProvider(id, user.id, data);

      return ResponseUtil.success(c, {
        id: provider.id,
        name: provider.name,
        type: provider.type,
        baseUrl: provider.baseUrl,
        isActive: provider.isActive,
        updatedAt: provider.updatedAt,
      });
    } catch (error: any) {
      logger.error({ error }, 'Failed to update provider');

      if (error.message === 'Provider not found') {
        return ResponseUtil.notFound(c, error.message);
      }

      return ResponseUtil.internalError(c, 'Failed to update provider');
    }
  }

  /**
   * Delete a provider
   */
  static async deleteProvider(c: Context) {
    try {
      const user = c.get('user');
      const id = c.req.param('id');

      await ProviderService.deleteProvider(id, user.id);

      return ResponseUtil.success(c, { message: 'Provider deleted' });
    } catch (error: any) {
      logger.error({ error }, 'Failed to delete provider');

      if (error.message === 'Provider not found') {
        return ResponseUtil.notFound(c, error.message);
      }

      return ResponseUtil.internalError(c, 'Failed to delete provider');
    }
  }

  /**
   * Toggle provider active status
   */
  static async toggleProvider(c: Context) {
    try {
      const user = c.get('user');
      const id = c.req.param('id');

      const isActive = await ProviderService.toggleProvider(id, user.id);

      return ResponseUtil.success(c, { isActive });
    } catch (error: any) {
      logger.error({ error }, 'Failed to toggle provider');

      if (error.message === 'Provider not found') {
        return ResponseUtil.notFound(c, error.message);
      }

      return ResponseUtil.internalError(c, 'Failed to toggle provider');
    }
  }

  /**
   * Test provider connection
   */
  static async testProvider(c: Context) {
    try {
      const data = await c.req.json();
      const { type, baseUrl, apiKey, model } = data;

      if (!model) {
        return ResponseUtil.badRequest(c, 'Model is required for testing');
      }

      // Use the scalable provider test implementation
      const result = await testProvider(type, {
        baseUrl,
        apiKey,
        model,
      });

      if (result.success) {
        return ResponseUtil.success(c, { success: true, message: result.message });
      } else {
        return ResponseUtil.badRequest(c, result.message);
      }
    } catch (error: any) {
      logger.error({ error }, 'Failed to test provider connection');

      if (error.name === 'TimeoutError' || error.code === 'ETIMEDOUT') {
        return ResponseUtil.badRequest(c, 'Connection timeout - check base URL');
      } else if (error.cause?.code === 'ENOTFOUND') {
        return ResponseUtil.badRequest(c, 'Invalid base URL - host not found');
      }

      return ResponseUtil.internalError(c, 'Connection test failed');
    }
  }
}
