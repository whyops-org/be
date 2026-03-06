import { createServiceLogger } from '@whyops/shared/logger';
import env from '@whyops/shared/env';
import { Agent, Entity, Trace } from '@whyops/shared/models';
import CryptoJS from 'crypto-js';
import { QueryTypes } from 'sequelize';
import { getDefaultAgentRuntimeLimits, hasAgentRuntimeColumns } from '../utils/agent-runtime';

const logger = createServiceLogger('analyse:sampling-service');

export interface SamplingResult {
  shouldSample: boolean;
  samplingRate?: number;
  hashValue?: number;
  reason?: string;
}

export interface AgentSpanLimitResult {
  allowed: boolean;
  maxSpans?: number;
  currentSpans?: number;
  reason?: string;
}

export class SamplingService {
  private static async findAgentForLimits(input: {
    agentId: string;
    userId: string;
    projectId: string;
    environmentId: string;
    includeMaxSpans?: boolean;
  }): Promise<{ id: string; maxTraces?: number; maxSpans?: number } | null> {
    const runtimeColumnsAvailable = await hasAgentRuntimeColumns();
    const requestedRuntimeFields = [
      'maxTraces',
      ...(input.includeMaxSpans ? (['maxSpans'] as const) : []),
    ];

    const agent = await Agent.findOne({
      where: {
        id: input.agentId,
        userId: input.userId,
        projectId: input.projectId,
        environmentId: input.environmentId,
      },
      attributes: [
        'id',
        ...(runtimeColumnsAvailable ? requestedRuntimeFields : []),
        'userId',
        'projectId',
        'environmentId',
        'name',
        'createdAt',
        'updatedAt',
      ],
    });

    if (!agent) return null;

    return {
      id: agent.id,
      maxTraces: runtimeColumnsAvailable ? Number((agent as any).maxTraces || 0) : undefined,
      maxSpans: runtimeColumnsAvailable && input.includeMaxSpans
        ? Number((agent as any).maxSpans || 0)
        : undefined,
    };
  }

  /**
   * Determines if a trace should be sampled based on entity's sampling rate.
   * Uses deterministic hash-based sampling for consistency.
   * Trace-level sampling ensures all events in a sampled trace are kept.
   */
  static async shouldSampleTrace(
    userId: string,
    projectId: string,
    environmentId: string,
    entityName: string | undefined,
    traceHash: string
  ): Promise<SamplingResult> {
    // If no entity name, always sample
    if (!entityName) {
      return { shouldSample: true };
    }

    try {
      // Fetch entity with sampling configuration
      const entity = await Entity.findOne({
        where: { userId, projectId, environmentId, name: entityName },
        order: [['createdAt', 'DESC']],
      });

      if (entity) {
        const runtimeColumnsAvailable = await hasAgentRuntimeColumns();
        const runtimeDefaults = getDefaultAgentRuntimeLimits();

        const sampledTracesForEntity = await Trace.count({
          where: {
            entityId: entity.id,
            sampledIn: true,
          },
        });

        if (sampledTracesForEntity >= env.MAX_TRACES_PER_ENTITY) {
          return {
            shouldSample: false,
            samplingRate: Number(entity.samplingRate),
            reason: `Trace rejected by entity limit (${sampledTracesForEntity}/${env.MAX_TRACES_PER_ENTITY})`,
          };
        }

        if (entity.agentId && runtimeColumnsAvailable) {
          const agent = await this.findAgentForLimits({
            agentId: entity.agentId,
            userId,
            projectId,
            environmentId,
          });
          const maxTracesForAgent = Math.max(1, Number(agent?.maxTraces || runtimeDefaults.maxTraces));

          const rows = await Entity.sequelize!.query<{ traceCount: string | number }>(
            `
              SELECT COUNT(*)::bigint AS "traceCount"
              FROM traces t
              JOIN entities e ON e.id = t.entity_id
              WHERE e.agent_id = :agentId
                AND t.sampled_in = true
            `,
            {
              replacements: { agentId: entity.agentId },
              type: QueryTypes.SELECT,
            }
          );
          const sampledTracesForAgent = Number(rows[0]?.traceCount || 0);

          if (sampledTracesForAgent >= maxTracesForAgent) {
            return {
              shouldSample: false,
              samplingRate: Number(entity.samplingRate),
              reason: `Trace rejected by agent limit (${sampledTracesForAgent}/${maxTracesForAgent})`,
            };
          }
        }
      }

      // If entity not found or sampling rate is 1.0, always sample
      if (!entity || entity.samplingRate >= 1.0) {
        return { shouldSample: true, samplingRate: Number(entity?.samplingRate) };
      }

      // Generate deterministic value from hash (0-1 range)
      const hashValue = this.hashToNormalizedValue(traceHash);

      // Sample if hash value is within sampling rate
      const shouldSample = hashValue <= entity.samplingRate;

      logger.debug({
        entityId: entity.id,
        samplingRate: entity.samplingRate,
        hashValue: hashValue.toFixed(4),
        shouldSample,
      }, 'Sampling decision made');

      return {
        shouldSample,
        samplingRate: Number(entity.samplingRate),
        hashValue,
        reason: shouldSample 
          ? undefined 
          : `Trace rejected by sampling (rate: ${entity.samplingRate}, hash: ${hashValue.toFixed(4)})`,
      };
    } catch (error) {
      logger.error({ error, userId, projectId, environmentId, entityName }, 'Error in sampling decision, defaulting to sample');
      return { shouldSample: true, reason: 'Error in sampling, defaulting to accept' };
    }
  }

  static async checkAgentSpanLimit(
    userId: string,
    projectId: string,
    environmentId: string,
    entityName: string | undefined,
    traceId: string,
    spanId?: string
  ): Promise<AgentSpanLimitResult> {
    if (!entityName) {
      return { allowed: true };
    }

    try {
      const runtimeColumnsAvailable = await hasAgentRuntimeColumns();
      const runtimeDefaults = getDefaultAgentRuntimeLimits();

      if (!runtimeColumnsAvailable) {
        return {
          allowed: true,
          maxSpans: runtimeDefaults.maxSpans,
        };
      }

      const entity = await Entity.findOne({
        where: { userId, projectId, environmentId, name: entityName },
        order: [['createdAt', 'DESC']],
        attributes: ['id', 'agentId'],
      });

      if (!entity?.agentId) {
        return { allowed: true };
      }

      const agent = await this.findAgentForLimits({
        agentId: entity.agentId,
        userId,
        projectId,
        environmentId,
        includeMaxSpans: true,
      });

      if (!agent) {
        return { allowed: true };
      }

      const maxSpans = Math.max(1, Number(agent.maxSpans || runtimeDefaults.maxSpans));

      if (spanId) {
        const existingSpanRows = await Trace.sequelize!.query<{ exists: boolean }>(
          `
            SELECT EXISTS (
              SELECT 1
              FROM trace_events e
              JOIN traces t ON t.id = e.trace_id
              JOIN entities en ON en.id = t.entity_id
              WHERE en.agent_id = :agentId
                AND e.span_id = :spanId
            ) AS "exists"
          `,
          {
            replacements: { agentId: agent.id, spanId },
            type: QueryTypes.SELECT,
          }
        );

        if (Boolean(existingSpanRows[0]?.exists)) {
          return {
            allowed: true,
            maxSpans,
          };
        }
      }

      const currentSpans = await Trace.sequelize!.query<{ spanCount: string | number }>(
        `
          SELECT COUNT(DISTINCT e.span_id)::bigint AS "spanCount"
          FROM trace_events e
          JOIN traces t ON t.id = e.trace_id
          JOIN entities en ON en.id = t.entity_id
          WHERE en.agent_id = :agentId
            AND e.span_id IS NOT NULL
            AND e.span_id <> ''
        `,
        {
          replacements: { agentId: agent.id },
          type: QueryTypes.SELECT,
        }
      );

      const spanCount = Number(currentSpans[0]?.spanCount || 0);
      if (spanCount >= maxSpans) {
        return {
          allowed: false,
          maxSpans,
          currentSpans: spanCount,
          reason: `Span rejected by agent limit (${spanCount}/${maxSpans})`,
        };
      }

      return {
        allowed: true,
        maxSpans,
        currentSpans: spanCount,
      };
    } catch (error) {
      logger.error(
        { error, userId, projectId, environmentId, entityName, traceId },
        'Error while checking span limits, defaulting to allow'
      );
      return {
        allowed: true,
        reason: 'Error in span limit check, defaulting to allow',
      };
    }
  }

  /**
   * Backward-compatible alias.
   * Deprecated: use shouldSampleTrace for trace-level sampling semantics.
   */
  static async shouldSampleEvent(
    userId: string,
    projectId: string,
    environmentId: string,
    entityName: string | undefined,
    eventHash: string
  ): Promise<SamplingResult> {
    return this.shouldSampleTrace(userId, projectId, environmentId, entityName, eventHash);
  }

  /**
   * Converts a hash string to a normalized value between 0 and 1
   * Uses first 8 hex characters for deterministic distribution
   */
  private static hashToNormalizedValue(hash: string): number {
    const hashPrefix = hash.substring(0, 8);
    const hashInt = parseInt(hashPrefix, 16);
    return hashInt / 0xffffffff; // Normalize to [0, 1]
  }

  /**
   * Generates a content hash for an event
   */
  static generateContentHash(data: {
    traceId: string;
    eventType: string;
    userId: string;
    parentStepId?: number;
    content?: any;
  }): string {
    const payload = {
      traceId: data.traceId,
      eventType: data.eventType,
      userId: data.userId,
      parentStepId: data.parentStepId,
      content: data.content,
    };
    const rawString = JSON.stringify(payload);
    return CryptoJS.SHA256(rawString).toString();
  }

  /**
   * Generates a trace-level hash used for sampling decisions.
   */
  static generateTraceHash(data: {
    traceId: string;
    userId: string;
    environmentId: string;
    agentName?: string;
  }): string {
    const payload = {
      traceId: data.traceId,
      userId: data.userId,
      environmentId: data.environmentId,
      agentName: data.agentName,
    };
    const rawString = JSON.stringify(payload);
    return CryptoJS.SHA256(rawString).toString();
  }
}
