import { createServiceLogger } from '@whyops/shared/logger';
import { Agent, Entity } from '@whyops/shared/models';
import { createHash } from 'crypto';

const logger = createServiceLogger('analyse:entity-service');

export class EntityService {
  /**
   * Creates a hash for entity metadata to detect configuration changes
   */
  private static createMetadataHash(metadata: Record<string, any>): string {
    const hash = createHash('sha256');
    hash.update(JSON.stringify(metadata));
    return hash.digest('hex').substring(0, 32);
  }

  static async initAgentVersion(input: {
    userId: string;
    projectId: string;
    environmentId: string;
    agentName: string;
    metadata: Record<string, any>;
  }): Promise<{
    agentId: string;
    agentVersionId: string;
    versionHash: string;
    status: 'created' | 'existing';
  }> {
    const versionHash = this.createMetadataHash(input.metadata || {});

    const [agent] = await Agent.findOrCreate({
      where: {
        userId: input.userId,
        projectId: input.projectId,
        environmentId: input.environmentId,
        name: input.agentName,
      },
      defaults: {
        userId: input.userId,
        projectId: input.projectId,
        environmentId: input.environmentId,
        name: input.agentName,
      },
    });

    const latestVersion = await Entity.findOne({
      where: {
        agentId: agent.id,
      },
      order: [['createdAt', 'DESC']],
    });

    if (latestVersion && latestVersion.hash === versionHash) {
      return {
        agentId: agent.id,
        agentVersionId: latestVersion.id,
        versionHash,
        status: 'existing',
      };
    }

    const newVersion = await Entity.create({
      agentId: agent.id,
      userId: input.userId,
      projectId: input.projectId,
      environmentId: input.environmentId,
      name: input.agentName,
      hash: versionHash,
      metadata: input.metadata || {},
      samplingRate: latestVersion ? Number(latestVersion.samplingRate) : 1.0,
    });

    logger.info(
      {
        agentId: agent.id,
        agentVersionId: newVersion.id,
        agentName: input.agentName,
        isFirstVersion: !latestVersion,
      },
      'Agent version initialized'
    );

    return {
      agentId: agent.id,
      agentVersionId: newVersion.id,
      versionHash,
      status: 'created',
    };
  }

  static async resolveLatestAgentVersionByName(
    userId: string,
    projectId: string,
    environmentId: string,
    agentName: string
  ): Promise<{ agentId: string; agentVersionId: string; version: Entity } | null> {
    try {
      const agent = await Agent.findOne({
        where: {
          userId,
          projectId,
          environmentId,
          name: agentName,
        },
      });

      if (!agent) {
        return null;
      }

      const latestVersion = await Entity.findOne({
        where: {
          agentId: agent.id,
        },
        order: [['createdAt', 'DESC']],
      });

      if (!latestVersion) {
        return null;
      }

      return {
        agentId: agent.id,
        agentVersionId: latestVersion.id,
        version: latestVersion,
      };
    } catch (error) {
      logger.error({ error, userId, projectId, environmentId, agentName }, 'Failed to resolve latest agent version');
      return null;
    }
  }

  /**
   * Resolves entity ID by user ID, project ID, environment ID, and entity name
   * Creates the entity if it doesn't exist
   * Returns the latest version of the entity (or creates a new version if metadata changed)
   */
  static async resolveEntityId(
    userId: string,
    projectId: string,
    environmentId: string,
    entityName?: string,
    metadata?: Record<string, any>
  ): Promise<string | undefined> {
    if (!entityName) return undefined;

    try {
      if (metadata) {
        const initResult = await this.initAgentVersion({
          userId,
          projectId,
          environmentId,
          agentName: entityName,
          metadata,
        });
        return initResult.agentVersionId;
      }

      const latest = await this.resolveLatestAgentVersionByName(
        userId,
        projectId,
        environmentId,
        entityName
      );

      return latest?.agentVersionId;
    } catch (error) {
      logger.error({ error, userId, projectId, environmentId, entityName }, 'Failed to resolve entity ID');
      return undefined;
    }
  }

  /**
   * Gets entity by environment ID and name (latest version)
   */
  static async getEntity(
    environmentId: string,
    entityName: string
  ): Promise<Entity | null> {
    try {
      return await Entity.findOne({
        where: { environmentId, name: entityName },
        order: [['createdAt', 'DESC']],
      });
    } catch (error) {
      logger.error({ error, environmentId, entityName }, 'Failed to get entity');
      return null;
    }
  }

  /**
   * Gets or creates an entity by user ID, project ID, environment ID, and name
   * This ensures the entity exists, creating it if necessary
   */
  static async getOrCreateEntity(
    userId: string,
    projectId: string,
    environmentId: string,
    entityName: string,
    metadata?: Record<string, any>
  ): Promise<Entity | null> {
    try {
      const entityId = await this.resolveEntityId(userId, projectId, environmentId, entityName, metadata);
      if (!entityId) return null;

      return await Entity.findByPk(entityId);
    } catch (error) {
      logger.error({ error, userId, projectId, environmentId, entityName }, 'Failed to get or create entity');
      return null;
    }
  }
}
