import { createServiceLogger } from '@whyops/shared/logger';
import { ApiKey, Entity, Environment, Project, Provider } from '@whyops/shared/models';
import { decrypt, encrypt, generateApiKey, hashApiKey } from '@whyops/shared/utils';

const logger = createServiceLogger('auth:apikey-service');

export interface CreateApiKeyData {
  userId: string;
  projectId: string;
  environmentId: string;
  name: string;
  providerId?: string;
  entityId?: string;
  rateLimit?: number;
  expiresAt?: Date;
  metadata?: Record<string, any>;
}

export interface UpdateApiKeyData {
  name?: string;
  rateLimit?: number;
  expiresAt?: Date;
  metadata?: Record<string, any>;
}

export interface RegeneratedApiKeyResult {
  id: string;
  name: string;
  keyPrefix: string;
  isActive: boolean;
  updatedAt: Date;
  apiKey: string;
}

export interface ApiKeyWithRelations extends ApiKey {
  apiKey?: string; // Only returned on creation
}

export interface CreatedApiKeyResult {
  id: string;
  name: string;
  apiKey: string;
  keyPrefix: string;
  projectId: string;
  environmentId: string;
  providerId?: string;
  entityId?: string;
  isMaster: boolean;
  rateLimit?: number;
  expiresAt?: Date;
  isActive: boolean;
  createdAt: Date;
}

export interface MaskedApiKeyByStage {
  id: string;
  name: string;
  projectId: string;
  projectName: string;
  environmentId: string;
  stage: string;
  keyPrefix: string;
  maskedKey: string;
  canReveal: boolean;
  isMaster: boolean;
  isActive: boolean;
  createdAt: Date;
  lastUsedAt?: Date;
  expiresAt?: Date;
}

function maskApiKey(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (trimmed.length <= 8) {
    return `${trimmed.slice(0, 2)}****`;
  }
  const visiblePrefix = trimmed.slice(0, 8);
  const visibleSuffix = trimmed.slice(-4);
  return `${visiblePrefix}****${visibleSuffix}`;
}

function buildFallbackMasked(prefix?: string): string {
  const trimmed = (prefix || '').trim();
  if (!trimmed) {
    return '****';
  }
  return `${trimmed}****`;
}

function isMissingEncryptedColumnError(error: any): boolean {
  const code = error?.original?.code || error?.parent?.code;
  const sql = String(error?.sql || error?.parent?.sql || '');
  return code === '42703' && sql.includes('"key_encrypted"');
}

function mapMaskedApiKeyRow(apiKey: ApiKey): MaskedApiKeyByStage {
  const rawEncrypted = (apiKey as any).keyEncrypted as string | undefined;
  const decrypted = rawEncrypted ? decrypt(rawEncrypted) : '';
  const maskedKey = decrypted ? maskApiKey(decrypted) : buildFallbackMasked(apiKey.keyPrefix);
  const project = (apiKey as any).project;
  const environment = (apiKey as any).environment;

  return {
    id: apiKey.id,
    name: apiKey.name,
    projectId: apiKey.projectId,
    projectName: project?.name || 'Unknown Project',
    environmentId: apiKey.environmentId,
    stage: environment?.name || 'UNKNOWN',
    keyPrefix: apiKey.keyPrefix,
    maskedKey,
    canReveal: Boolean(rawEncrypted),
    isMaster: apiKey.isMaster,
    isActive: apiKey.isActive,
    createdAt: apiKey.createdAt,
    lastUsedAt: apiKey.lastUsedAt,
    expiresAt: apiKey.expiresAt,
  };
}

export class ApiKeyService {
  /**
   * List API keys for a user
   */
  static async listApiKeys(
    userId: string,
    filters?: { projectId?: string; environmentId?: string }
  ): Promise<ApiKey[]> {
    const where: any = { userId };
    if (filters?.projectId) where.projectId = filters.projectId;
    if (filters?.environmentId) where.environmentId = filters.environmentId;

    const apiKeys = await ApiKey.findAll({
      where,
      include: [
        {
          model: Project,
          as: 'project',
          attributes: ['id', 'name'],
        },
        {
          model: Environment,
          as: 'environment',
          attributes: ['id', 'name'],
        },
        {
          model: Provider,
          as: 'provider',
          attributes: ['id', 'name', 'type'],
          required: false,
        },
        {
          model: Entity,
          as: 'entity',
          attributes: ['id', 'name'],
          required: false,
        },
      ],
      attributes: { exclude: ['keyHash', 'keyEncrypted'] },
      order: [['createdAt', 'DESC']],
    });

    return apiKeys;
  }

  /**
   * Get API key by ID
   */
  static async getApiKeyById(apiKeyId: string, userId: string): Promise<ApiKey | null> {
    const apiKey = await ApiKey.findOne({
      where: { id: apiKeyId, userId },
      include: [
        {
          model: Project,
          as: 'project',
          attributes: ['id', 'name'],
        },
        {
          model: Environment,
          as: 'environment',
          attributes: ['id', 'name'],
        },
        {
          model: Provider,
          as: 'provider',
          attributes: ['id', 'name', 'type'],
          required: false,
        },
        {
          model: Entity,
          as: 'entity',
          attributes: ['id', 'name'],
          required: false,
        },
      ],
      attributes: { exclude: ['keyHash', 'keyEncrypted'] },
    });

    return apiKey;
  }

  /**
   * List API keys with masked values and stage information
   */
  static async listApiKeysMaskedByStage(userId: string): Promise<MaskedApiKeyByStage[]> {
    try {
      const apiKeys = await ApiKey.findAll({
        where: { userId },
        include: [
          {
            model: Project,
            as: 'project',
            attributes: ['id', 'name'],
          },
          {
            model: Environment,
            as: 'environment',
            attributes: ['id', 'name'],
          },
        ],
        attributes: [
          'id',
          'name',
          'projectId',
          'environmentId',
          'keyPrefix',
          'keyEncrypted',
          'isMaster',
          'isActive',
          'createdAt',
          'lastUsedAt',
          'expiresAt',
        ],
        order: [
          [{ model: Environment, as: 'environment' }, 'name', 'ASC'],
          ['createdAt', 'DESC'],
        ],
      });
      return apiKeys.map(mapMaskedApiKeyRow);
    } catch (error: any) {
      if (!isMissingEncryptedColumnError(error)) {
        throw error;
      }

      // Backward compatibility for DBs where key_encrypted migration is not applied yet.
      const apiKeys = await ApiKey.findAll({
        where: { userId },
        include: [
          {
            model: Project,
            as: 'project',
            attributes: ['id', 'name'],
          },
          {
            model: Environment,
            as: 'environment',
            attributes: ['id', 'name'],
          },
        ],
        attributes: [
          'id',
          'name',
          'projectId',
          'environmentId',
          'keyPrefix',
          'isMaster',
          'isActive',
          'createdAt',
          'lastUsedAt',
          'expiresAt',
        ],
        order: [
          [{ model: Environment, as: 'environment' }, 'name', 'ASC'],
          ['createdAt', 'DESC'],
        ],
      });
      return apiKeys.map(mapMaskedApiKeyRow);
    }
  }

  /**
   * Reveal API key by ID for authenticated owner
   */
  static async getUnmaskedApiKeyById(apiKeyId: string, userId: string): Promise<string> {
    let apiKey: ApiKey | null = null;
    try {
      apiKey = await ApiKey.findOne({
        where: { id: apiKeyId, userId },
        attributes: ['id', 'keyEncrypted'],
      });
    } catch (error: any) {
      if (isMissingEncryptedColumnError(error)) {
        throw new Error(
          'API key reveal is not available yet. Please run the latest database migration first.'
        );
      }
      throw error;
    }

    if (!apiKey) {
      throw new Error('API key not found');
    }

    const encrypted = (apiKey as any).keyEncrypted as string | undefined;
    if (!encrypted) {
      throw new Error('API key cannot be revealed. Rotate/regenerate this key.');
    }

    return decrypt(encrypted);
  }

  /**
   * Create a new API key
   */
  static async createApiKey(data: CreateApiKeyData): Promise<CreatedApiKeyResult> {
    // Verify project and environment belong to user
    const project = await Project.findOne({
      where: { id: data.projectId, userId: data.userId },
    });

    if (!project) {
      throw new Error('Project not found');
    }

    const environment = await Environment.findOne({
      where: { id: data.environmentId, projectId: data.projectId },
    });

    if (!environment) {
      throw new Error('Environment not found');
    }

    // If providerId is specified, verify it belongs to user
    if (data.providerId) {
      const provider = await Provider.findOne({
        where: { id: data.providerId, userId: data.userId },
      });

      if (!provider) {
        throw new Error('Provider not found');
      }
    }

    // If entityId is specified, verify it belongs to the environment
    if (data.entityId) {
      const entity = await Entity.findOne({
        where: { id: data.entityId, environmentId: data.environmentId, userId: data.userId },
      });

      if (!entity) {
        throw new Error('Entity not found in this environment');
      }
    }

    // Generate API key with YOPS- prefix
    const apiKey = generateApiKey('YOPS-');
    const keyHash = hashApiKey(apiKey);
    const keyPrefix = apiKey.substring(0, 12);

    // Create API key record
    let apiKeyRecord: ApiKey;
    try {
      apiKeyRecord = await ApiKey.create({
        userId: data.userId,
        projectId: data.projectId,
        environmentId: data.environmentId,
        providerId: data.providerId,
        entityId: data.entityId,
        name: data.name,
        keyHash,
        keyEncrypted: encrypt(apiKey),
        keyPrefix,
        isMaster: false,
        rateLimit: data.rateLimit,
        expiresAt: data.expiresAt,
        metadata: data.metadata,
        isActive: true,
      });
    } catch (error: any) {
      if (!isMissingEncryptedColumnError(error)) {
        throw error;
      }

      // Backward compatibility for DBs where key_encrypted migration is not applied yet.
      apiKeyRecord = await ApiKey.create({
        userId: data.userId,
        projectId: data.projectId,
        environmentId: data.environmentId,
        providerId: data.providerId,
        entityId: data.entityId,
        name: data.name,
        keyHash,
        keyPrefix,
        isMaster: false,
        rateLimit: data.rateLimit,
        expiresAt: data.expiresAt,
        metadata: data.metadata,
        isActive: true,
      });
    }

    logger.info(
      {
        apiKeyId: apiKeyRecord.id,
        userId: data.userId,
        projectId: data.projectId,
        environmentId: data.environmentId,
      },
      'API key created'
    );

    // Return with the actual key (only on creation)
    return {
      id: apiKeyRecord.id,
      name: apiKeyRecord.name,
      projectId: apiKeyRecord.projectId,
      environmentId: apiKeyRecord.environmentId,
      providerId: apiKeyRecord.providerId,
      entityId: apiKeyRecord.entityId,
      keyPrefix: apiKeyRecord.keyPrefix,
      isMaster: apiKeyRecord.isMaster,
      rateLimit: apiKeyRecord.rateLimit,
      expiresAt: apiKeyRecord.expiresAt,
      isActive: apiKeyRecord.isActive,
      createdAt: apiKeyRecord.createdAt,
      apiKey,
    };
  }

  /**
   * Update API key
   */
  static async updateApiKey(
    apiKeyId: string,
    userId: string,
    data: UpdateApiKeyData
  ): Promise<ApiKey> {
    const apiKey = await ApiKey.findOne({
      where: { id: apiKeyId, userId },
    });

    if (!apiKey) {
      throw new Error('API key not found');
    }

    // Update fields
    if (data.name !== undefined) apiKey.name = data.name;
    if (data.rateLimit !== undefined) apiKey.rateLimit = data.rateLimit;
    if (data.expiresAt !== undefined) apiKey.expiresAt = data.expiresAt;
    if (data.metadata !== undefined) apiKey.metadata = data.metadata;

    await apiKey.save();

    logger.info({ apiKeyId }, 'API key updated');

    return apiKey;
  }

  /**
   * Regenerate API key value for an existing key record
   */
  static async regenerateApiKey(apiKeyId: string, userId: string): Promise<RegeneratedApiKeyResult> {
    const apiKeyRecord = await ApiKey.findOne({
      where: { id: apiKeyId, userId },
      attributes: ['id', 'name', 'keyPrefix', 'isActive', 'updatedAt'],
    });

    if (!apiKeyRecord) {
      throw new Error('API key not found');
    }

    const nextApiKey = generateApiKey('YOPS-');
    const nextKeyHash = hashApiKey(nextApiKey);
    const nextKeyPrefix = nextApiKey.substring(0, 12);

    try {
      await ApiKey.update(
        {
          keyHash: nextKeyHash,
          keyPrefix: nextKeyPrefix,
          keyEncrypted: encrypt(nextApiKey),
          isActive: true,
        } as any,
        { where: { id: apiKeyId, userId } }
      );
    } catch (error: any) {
      if (!isMissingEncryptedColumnError(error)) {
        throw error;
      }

      // Backward compatibility for DBs where key_encrypted migration is not applied yet.
      await ApiKey.update(
        {
          keyHash: nextKeyHash,
          keyPrefix: nextKeyPrefix,
          isActive: true,
        },
        { where: { id: apiKeyId, userId } }
      );
    }

    const refreshed = await ApiKey.findOne({
      where: { id: apiKeyId, userId },
      attributes: ['id', 'name', 'keyPrefix', 'isActive', 'updatedAt'],
    });

    if (!refreshed) {
      throw new Error('API key not found');
    }

    logger.info({ apiKeyId, userId }, 'API key regenerated');

    return {
      id: refreshed.id,
      name: refreshed.name,
      keyPrefix: refreshed.keyPrefix,
      isActive: refreshed.isActive,
      updatedAt: refreshed.updatedAt,
      apiKey: nextApiKey,
    };
  }

  /**
   * Delete API key
   */
  static async deleteApiKey(apiKeyId: string, userId: string): Promise<void> {
    const apiKey = await ApiKey.findOne({
      where: { id: apiKeyId, userId },
    });

    if (!apiKey) {
      throw new Error('API key not found');
    }

    await apiKey.destroy();

    logger.info({ apiKeyId }, 'API key deleted');
  }

  /**
   * Toggle API key active status
   */
  static async toggleApiKey(apiKeyId: string, userId: string): Promise<boolean> {
    const apiKey = await ApiKey.findOne({
      where: { id: apiKeyId, userId },
    });

    if (!apiKey) {
      throw new Error('API key not found');
    }

    apiKey.isActive = !apiKey.isActive;
    await apiKey.save();

    logger.info({ apiKeyId, isActive: apiKey.isActive }, 'API key toggled');

    return apiKey.isActive;
  }
}
