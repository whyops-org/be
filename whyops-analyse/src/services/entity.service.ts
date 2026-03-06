import { createServiceLogger } from '@whyops/shared/logger';
import env from '@whyops/shared/env';
import { Agent, ApiKey, Entity, LLMEvent, Project, Trace } from '@whyops/shared/models';
import { createHash } from 'crypto';
import { Op } from 'sequelize';
import { getDefaultAgentRuntimeLimits, hasAgentRuntimeColumns } from '../utils/agent-runtime';

const logger = createServiceLogger('analyse:entity-service');

export class EntityService {
  static readonly PROJECT_AGENT_LIMIT_REACHED = 'PROJECT_AGENT_LIMIT_REACHED';
  static readonly ACCOUNT_AGENT_LIMIT_REACHED = 'ACCOUNT_AGENT_LIMIT_REACHED';

  private static readonly TRACE_DELETE_CHUNK_SIZE = 1000;

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
    const defaultSamplingRate = Math.max(
      0,
      Math.min(1, Number(env.DEFAULT_TRACE_SAMPLING_RATE.toFixed(2)))
    );

    return Agent.sequelize!.transaction(async (transaction) => {
      await Project.findOne({
        where: {
          id: input.projectId,
          userId: input.userId,
        },
        attributes: ['id'],
        transaction,
        lock: transaction.LOCK.UPDATE,
      });

      let agent = await Agent.findOne({
        where: {
          userId: input.userId,
          projectId: input.projectId,
          environmentId: input.environmentId,
          name: input.agentName,
        },
        attributes: ['id', 'userId', 'projectId', 'environmentId', 'name', 'createdAt', 'updatedAt'],
        transaction,
        lock: transaction.LOCK.UPDATE,
      });

      if (!agent) {
        const projectAgentCount = await Agent.count({
          where: {
            userId: input.userId,
          },
          transaction,
        });

        const accountAgentLimit = Math.max(
          1,
          Number(env.MAX_AGENTS_PER_ACCOUNT || env.MAX_AGENTS_PER_PROJECT)
        );

        if (projectAgentCount >= accountAgentLimit) {
          const error = new Error(
            `Agent limit reached for account (max: ${accountAgentLimit})`
          ) as Error & { code?: string };
          error.code = EntityService.ACCOUNT_AGENT_LIMIT_REACHED;
          throw error;
        }

        const runtimeDefaults = getDefaultAgentRuntimeLimits();
        const runtimeColumnsAvailable = await hasAgentRuntimeColumns();

        agent = await Agent.create(
          {
            userId: input.userId,
            projectId: input.projectId,
            environmentId: input.environmentId,
            name: input.agentName,
            ...(runtimeColumnsAvailable
              ? {
                  maxTraces: runtimeDefaults.maxTraces,
                  maxSpans: runtimeDefaults.maxSpans,
                }
              : {}),
          },
          { transaction }
        );
      }

      const latestVersion = await Entity.findOne({
        where: {
          agentId: agent.id,
        },
        order: [['createdAt', 'DESC']],
        transaction,
      });

      if (latestVersion && latestVersion.hash === versionHash) {
        return {
          agentId: agent.id,
          agentVersionId: latestVersion.id,
          versionHash,
          status: 'existing' as const,
        };
      }

      const newVersion = await Entity.create(
        {
          agentId: agent.id,
          userId: input.userId,
          projectId: input.projectId,
          environmentId: input.environmentId,
          name: input.agentName,
          hash: versionHash,
          metadata: input.metadata || {},
          samplingRate: latestVersion
            ? Number(latestVersion.samplingRate)
            : defaultSamplingRate,
        },
        { transaction }
      );

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
        status: 'created' as const,
      };
    });
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
        attributes: ['id', 'userId', 'projectId', 'environmentId', 'name', 'createdAt', 'updatedAt'],
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

  static async updateAgentSamplingRate(input: {
    userId: string;
    projectId: string;
    environmentId: string;
    agentId: string;
    samplingRate: number;
  }): Promise<{
    agent: Agent;
    latestVersion: Entity;
    updatedVersions: number;
  } | null> {
    try {
      const agent = await Agent.findOne({
        where: {
          id: input.agentId,
          userId: input.userId,
          projectId: input.projectId,
          environmentId: input.environmentId,
        },
        attributes: ['id', 'userId', 'projectId', 'environmentId', 'name', 'createdAt', 'updatedAt'],
      });

      if (!agent) {
        return null;
      }

      const nextRate = Math.max(0, Math.min(1, Number(input.samplingRate.toFixed(2))));

      const [updatedVersions] = await Entity.update(
        { samplingRate: nextRate },
        { where: { agentId: agent.id } }
      );

      const latestVersion = await Entity.findOne({
        where: { agentId: agent.id },
        order: [['createdAt', 'DESC']],
      });

      if (!latestVersion) {
        return null;
      }

      return {
        agent,
        latestVersion,
        updatedVersions,
      };
    } catch (error) {
      logger.error(
        {
          error,
          userId: input.userId,
          projectId: input.projectId,
          environmentId: input.environmentId,
          agentId: input.agentId,
          samplingRate: input.samplingRate,
        },
        'Failed to update agent sampling rate'
      );
      throw error;
    }
  }

  static async deleteAgentAndLinkedData(input: {
    userId: string;
    projectId: string;
    environmentId: string;
    agentId: string;
  }): Promise<{
    agentId: string;
    deletedTraceEvents: number;
    deletedTraces: number;
    deletedEntities: number;
    deletedApiKeys: number;
    invalidatedApiKeyIds: string[];
  } | null> {
    try {
      return await Agent.sequelize!.transaction(async (transaction) => {
        const agent = await Agent.findOne({
          where: {
            id: input.agentId,
            userId: input.userId,
            projectId: input.projectId,
            environmentId: input.environmentId,
          },
          attributes: ['id', 'userId', 'projectId', 'environmentId', 'name', 'createdAt', 'updatedAt'],
          transaction,
          lock: transaction.LOCK.UPDATE,
        });

        if (!agent) {
          return null;
        }

        const versions = await Entity.findAll({
          where: {
            agentId: agent.id,
          },
          attributes: ['id'],
          transaction,
        });
        const entityIds = versions.map((version) => version.id);

        const apiKeys = entityIds.length
          ? await ApiKey.findAll({
              where: {
                entityId: { [Op.in]: entityIds },
              },
              attributes: ['id'],
              transaction,
            })
          : [];
        const invalidatedApiKeyIds = apiKeys.map((key) => key.id);

        const traces = entityIds.length
          ? await Trace.findAll({
              where: {
                entityId: { [Op.in]: entityIds },
              },
              attributes: ['id'],
              transaction,
            })
          : [];
        const traceIds = traces.map((trace) => trace.id);

        let deletedTraceEvents = 0;
        for (const chunk of this.chunkArray(traceIds, this.TRACE_DELETE_CHUNK_SIZE)) {
          deletedTraceEvents += await LLMEvent.destroy({
            where: {
              traceId: { [Op.in]: chunk },
            },
            transaction,
          });
        }

        if (entityIds.length > 0) {
          deletedTraceEvents += await LLMEvent.destroy({
            where: {
              entityId: { [Op.in]: entityIds },
            },
            transaction,
          });
        }

        const deletedTraces = entityIds.length
          ? await Trace.destroy({
              where: {
                entityId: { [Op.in]: entityIds },
              },
              transaction,
            })
          : 0;

        const deletedEntities = entityIds.length
          ? await Entity.destroy({
              where: {
                id: { [Op.in]: entityIds },
              },
              transaction,
            })
          : 0;

        await agent.destroy({ transaction });

        return {
          agentId: agent.id,
          deletedTraceEvents,
          deletedTraces,
          deletedEntities,
          deletedApiKeys: invalidatedApiKeyIds.length,
          invalidatedApiKeyIds,
        };
      });
    } catch (error) {
      logger.error(
        {
          error,
          userId: input.userId,
          projectId: input.projectId,
          environmentId: input.environmentId,
          agentId: input.agentId,
        },
        'Failed to delete agent and linked data'
      );
      throw error;
    }
  }

  private static chunkArray<T>(items: T[], chunkSize: number): T[][] {
    if (items.length === 0) return [];
    const chunks: T[][] = [];
    for (let i = 0; i < items.length; i += chunkSize) {
      chunks.push(items.slice(i, i + chunkSize));
    }
    return chunks;
  }
}
