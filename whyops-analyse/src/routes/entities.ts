import { zValidator } from '@hono/zod-validator';
import { createServiceLogger } from '@whyops/shared/logger';
import { Agent, Entity } from '@whyops/shared/models';
import {
  invalidateApiKeyAuthCacheById,
  prefixedRedisKey,
  redisDeleteByPattern,
  redisGetJson,
  redisSetJson,
} from '@whyops/shared/services';
import { Hono } from 'hono';
import { QueryTypes } from 'sequelize';
import { z } from 'zod';
import { EntityService } from '../services/entity.service';
import { getDefaultAgentRuntimeLimits, hasAgentRuntimeColumns } from '../utils/agent-runtime';
import { parseInclude } from '../utils/query';

const logger = createServiceLogger('analyse:entities');
const app = new Hono();
const ENTITIES_LIST_CACHE_TTL_MS = 15_000;
const entitiesListCache = new Map<string, { expiresAtMs: number; payload: unknown }>();

function getEntitiesListLocalCacheKey(input: {
  userId: string;
  projectId: string;
  environmentId: string;
  page: number;
  count: number;
  includeMetadata: boolean;
}): string {
  return `${input.userId}:${input.projectId}:${input.environmentId}:${input.page}:${input.count}:${input.includeMetadata ? 1 : 0}`;
}

function getEntitiesListRedisCacheKey(input: {
  userId: string;
  projectId: string;
  environmentId: string;
  page: number;
  count: number;
  includeMetadata: boolean;
}): string {
  return prefixedRedisKey(
    'analyse',
    'entities',
    input.userId,
    input.projectId,
    input.environmentId,
    input.page,
    input.count,
    input.includeMetadata ? 'metadata' : 'no-metadata'
  );
}

async function invalidateEntitiesCachesForUser(userId: string): Promise<void> {
  entitiesListCache.clear();
  await redisDeleteByPattern(prefixedRedisKey('analyse', 'entities', userId, '*'), 10_000);
}

interface EntityMetricRow {
  entityId: string;
  traceCount: string | number;
  totalEvents: string | number;
  errorEvents: string | number;
  lastActiveAt: string | Date | null;
}

interface EntityVersionRef {
  id: string;
  agentId?: string | null;
}

interface LatestEntityVersionRow {
  id: string;
  agentId: string;
  hash: string;
  metadata?: Record<string, any>;
  samplingRate: string | number;
  createdAt: string | Date;
  updatedAt: string | Date;
}

interface AggregatedAgentMetrics {
  traceCount: number;
  successPercentage: number;
  lastActive: string | null;
}

interface AgentRuntimeRow {
  id: string;
  maxTraces: string | number;
  maxSpans: string | number;
}

interface SingleAgentMetricRow {
  traceCount: string | number;
  lastActiveAt: string | Date | null;
}

interface SingleAgentDailySuccessRow {
  day: string;
  totalEvents: string | number;
  errorEvents: string | number;
}

interface SingleAgentDailyTraceRow {
  day: string;
  traceCount: string | number;
}

async function getEntityMetrics(entityIds: string[]): Promise<Map<string, EntityMetricRow>> {
  const metricsByEntityId = new Map<string, EntityMetricRow>();

  if (entityIds.length === 0) {
    return metricsByEntityId;
  }

  const rows = await Entity.sequelize!.query<EntityMetricRow>(
    `
      WITH trace_stats AS (
        SELECT
          t.entity_id AS "entityId",
          COUNT(*)::bigint AS "traceCount",
          MAX(t.created_at) AS "lastActiveAt"
        FROM traces t
        WHERE t.entity_id IN (:entityIds)
        GROUP BY t.entity_id
      ),
      event_stats AS (
        SELECT
          e.entity_id AS "entityId",
          COUNT(e.id)::bigint AS "totalEvents",
          COALESCE(SUM(CASE WHEN e.event_type = 'error' THEN 1 ELSE 0 END), 0)::bigint AS "errorEvents"
        FROM trace_events e
        WHERE e.entity_id IN (:entityIds)
        GROUP BY e.entity_id
        UNION ALL
        SELECT
          t.entity_id AS "entityId",
          COUNT(e.id)::bigint AS "totalEvents",
          COALESCE(SUM(CASE WHEN e.event_type = 'error' THEN 1 ELSE 0 END), 0)::bigint AS "errorEvents"
        FROM trace_events e
        JOIN traces t ON t.id = e.trace_id
        WHERE e.entity_id IS NULL
          AND t.entity_id IN (:entityIds)
        GROUP BY t.entity_id
      ),
      event_stats_agg AS (
        SELECT
          es."entityId",
          SUM(es."totalEvents")::bigint AS "totalEvents",
          SUM(es."errorEvents")::bigint AS "errorEvents"
        FROM event_stats es
        GROUP BY es."entityId"
      )
      SELECT
        ts."entityId",
        ts."traceCount",
        COALESCE(es."totalEvents", 0)::bigint AS "totalEvents",
        COALESCE(es."errorEvents", 0)::bigint AS "errorEvents",
        ts."lastActiveAt"
      FROM trace_stats ts
      LEFT JOIN event_stats_agg es ON es."entityId" = ts."entityId"
    `,
    {
      replacements: { entityIds },
      type: QueryTypes.SELECT,
    }
  );

  for (const row of rows) {
    metricsByEntityId.set(row.entityId, row);
  }

  return metricsByEntityId;
}

function buildAgentMetrics(
  versions: EntityVersionRef[],
  metricsByEntityId: Map<string, EntityMetricRow>
): Map<string, AggregatedAgentMetrics> {
  const statsByAgentId = new Map<string, { traceCount: number; totalEvents: number; errorEvents: number; lastActiveEpochMs: number | null }>();

  for (const version of versions) {
    if (!version.agentId) continue;

    const metric = metricsByEntityId.get(version.id);
    const traceCount = Number(metric?.traceCount || 0);
    const totalEvents = Number(metric?.totalEvents || 0);
    const errorEvents = Number(metric?.errorEvents || 0);
    const metricLastActive = metric?.lastActiveAt ? new Date(metric.lastActiveAt).getTime() : null;

    const existing = statsByAgentId.get(version.agentId) || { traceCount: 0, totalEvents: 0, errorEvents: 0, lastActiveEpochMs: null };
    existing.traceCount += traceCount;
    existing.totalEvents += totalEvents;
    existing.errorEvents += errorEvents;
    if (metricLastActive !== null) {
      existing.lastActiveEpochMs = existing.lastActiveEpochMs === null
        ? metricLastActive
        : Math.max(existing.lastActiveEpochMs, metricLastActive);
    }
    statsByAgentId.set(version.agentId, existing);
  }

  const result = new Map<string, AggregatedAgentMetrics>();
  for (const [agentId, stats] of statsByAgentId.entries()) {
    const successPercentage = stats.totalEvents > 0
      ? Math.round(((stats.totalEvents - stats.errorEvents) / stats.totalEvents) * 1000) / 10
      : 100;

    result.set(agentId, {
      traceCount: stats.traceCount,
      successPercentage,
      lastActive: stats.lastActiveEpochMs !== null ? new Date(stats.lastActiveEpochMs).toISOString() : null,
    });
  }

  return result;
}

async function getSingleAgentMetrics(entityIds: string[], periodDays: number): Promise<AggregatedAgentMetrics> {
  if (entityIds.length === 0) {
    return {
      traceCount: 0,
      successPercentage: 100,
      lastActive: null,
    };
  }

  const rows = await Entity.sequelize!.query<SingleAgentMetricRow>(
    `
      SELECT
        COUNT(DISTINCT t.id) AS "traceCount",
        MAX(t.created_at) AS "lastActiveAt"
      FROM traces t
      WHERE t.entity_id IN (:entityIds)
    `,
    {
      replacements: {
        entityIds,
      },
      type: QueryTypes.SELECT,
    }
  );

  const row = rows[0];
  const traceCount = Number(row?.traceCount || 0);

  return {
    traceCount,
    successPercentage: 100,
    lastActive: row?.lastActiveAt ? new Date(row.lastActiveAt).toISOString() : null,
  };
}

async function getSingleAgentDailySuccessPercentage(entityIds: string[], periodDays: number): Promise<Record<string, number>> {
  const result: Record<string, number> = {};

  if (entityIds.length === 0) {
    return result;
  }

  const now = new Date();
  const since = new Date(now);
  since.setUTCDate(since.getUTCDate() - (periodDays - 1));
  since.setUTCHours(0, 0, 0, 0);

  const rows = await Entity.sequelize!.query<SingleAgentDailySuccessRow>(
    `
      SELECT
        TO_CHAR(DATE_TRUNC('day', e.timestamp AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS "day",
        COUNT(*) AS "totalEvents",
        COALESCE(SUM(CASE WHEN e.event_type = 'error' THEN 1 ELSE 0 END), 0) AS "errorEvents"
      FROM traces t
      JOIN trace_events e ON e.trace_id = t.id
      WHERE t.entity_id IN (:entityIds)
        AND e.timestamp >= :since
      GROUP BY 1
      ORDER BY 1 ASC
    `,
    {
      replacements: {
        entityIds,
        since,
      },
      type: QueryTypes.SELECT,
    }
  );

  const byDay = new Map<string, { total: number; errors: number }>();
  for (const row of rows) {
    byDay.set(row.day, {
      total: Number(row.totalEvents || 0),
      errors: Number(row.errorEvents || 0),
    });
  }

  for (let i = 0; i < periodDays; i++) {
    const dayDate = new Date(since);
    dayDate.setUTCDate(since.getUTCDate() + i);
    const dayKey = dayDate.toISOString().slice(0, 10);
    const stat = byDay.get(dayKey);
    const percentage = stat && stat.total > 0
      ? Math.round(((stat.total - stat.errors) / stat.total) * 1000) / 10
      : 0;
    result[dayKey] = percentage;
  }

  return result;
}

async function getSingleAgentDailyTraceCounts(entityIds: string[], periodDays: number): Promise<Record<string, number>> {
  const result: Record<string, number> = {};

  if (entityIds.length === 0) {
    return result;
  }

  const now = new Date();
  const since = new Date(now);
  since.setUTCDate(since.getUTCDate() - (periodDays - 1));
  since.setUTCHours(0, 0, 0, 0);

  const rows = await Entity.sequelize!.query<SingleAgentDailyTraceRow>(
    `
      SELECT
        TO_CHAR(DATE_TRUNC('day', t.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS "day",
        COUNT(DISTINCT t.id) AS "traceCount"
      FROM traces t
      WHERE t.entity_id IN (:entityIds)
        AND t.created_at >= :since
      GROUP BY 1
      ORDER BY 1 ASC
    `,
    {
      replacements: {
        entityIds,
        since,
      },
      type: QueryTypes.SELECT,
    }
  );

  const byDay = new Map<string, number>();
  for (const row of rows) {
    byDay.set(row.day, Number(row.traceCount || 0));
  }

  for (let i = 0; i < periodDays; i++) {
    const dayDate = new Date(since);
    dayDate.setUTCDate(since.getUTCDate() + i);
    const dayKey = dayDate.toISOString().slice(0, 10);
    result[dayKey] = byDay.get(dayKey) ?? 0;
  }

  return result;
}

const entityInitSchema = z.object({
  agentName: z.string().min(1, 'Agent name is required').max(255),
  metadata: z.object({
    systemPrompt: z.string().min(1, 'metadata.systemPrompt is required'),
    tools: z.array(
      z.object({
        name: z.string().min(1, 'tool.name is required'),
        inputSchema: z.string().min(1, 'tool.inputSchema is required'),
        outputSchema: z.string().min(1, 'tool.outputSchema is required'),
        description: z.string().min(1, 'tool.description is required'),
      })
    ),
    description: z.string().optional(),
  }),
});

const updateSamplingRateSchema = z.object({
  samplingRate: z
    .number({ required_error: 'samplingRate is required' })
    .min(0, 'samplingRate must be >= 0')
    .max(1, 'samplingRate must be <= 1'),
});

const versionIdParamsSchema = z.object({
  versionId: z.string().uuid('Invalid versionId'),
});

const agentIdParamsSchema = z.object({
  id: z.string().uuid('Invalid agent id'),
});

app.post('/init', zValidator('json', entityInitSchema), async (c) => {
  const data = c.req.valid('json');
  const auth = c.get('whyopsAuth');

  if (!auth) {
    return c.json({ success: false, error: 'Unauthorized: authentication required' }, 401);
  }

  try {
    const result = await EntityService.initAgentVersion({
      userId: auth.userId,
      projectId: auth.projectId,
      environmentId: auth.environmentId,
      agentName: data.agentName,
      metadata: data.metadata,
    });

    logger.info(
      { agentId: result.agentId, agentVersionId: result.agentVersionId, agentName: data.agentName, status: result.status },
      'Agent init completed'
    );

    await invalidateEntitiesCachesForUser(auth.userId);

    return c.json(
      {
        success: true,
        agentId: result.agentId,
        agentVersionId: result.agentVersionId,
        status: result.status,
        versionHash: result.versionHash,
      },
      result.status === 'created' ? 201 : 200
    );

  } catch (error: any) {
    if (
      error?.code === EntityService.ACCOUNT_AGENT_LIMIT_REACHED ||
      error?.message?.includes('Agent limit reached for account')
    ) {
      return c.json(
        {
          success: false,
          error: `Account agent limit reached (${error?.message || 'too many agents'})`,
        },
        409
      );
    }

    logger.error({ error, data }, 'Failed to init entity');
    return c.json({ success: false, error: 'Failed to initialize agent' }, 500);
  }
});

// PATCH /api/entities/:id/sampling-rate
app.patch('/:id/sampling-rate', zValidator('json', updateSamplingRateSchema), async (c) => {
  const auth = c.get('whyopsAuth');

  if (!auth) {
    return c.json({ success: false, error: 'Unauthorized: authentication required' }, 401);
  }

  try {
    const id = c.req.param('id');
    const data = c.req.valid('json');

    const result = await EntityService.updateAgentSamplingRate({
      userId: auth.userId,
      projectId: auth.projectId,
      environmentId: auth.environmentId,
      agentId: id,
      samplingRate: data.samplingRate,
    });

    if (!result) {
      return c.json({ success: false, error: 'Agent not found' }, 404);
    }

    await invalidateEntitiesCachesForUser(auth.userId);

    return c.json({
      success: true,
      agentId: result.agent.id,
      samplingRate: Number(result.latestVersion.samplingRate),
      updatedVersions: result.updatedVersions,
      latestVersionId: result.latestVersion.id,
      updatedAt: result.latestVersion.updatedAt.toISOString(),
    });
  } catch (error: any) {
    logger.error({ error }, 'Failed to update agent sampling rate');
    return c.json({ success: false, error: 'Failed to update sampling rate' }, 500);
  }
});

// DELETE /api/entities/:id - hard delete an agent and all linked runtime data
app.delete('/:id', zValidator('param', agentIdParamsSchema), async (c) => {
  const auth = c.get('whyopsAuth');

  if (!auth) {
    return c.json({ success: false, error: 'Unauthorized: authentication required' }, 401);
  }

  try {
    const { id } = c.req.valid('param');

    const result = await EntityService.deleteAgentAndLinkedData({
      userId: auth.userId,
      projectId: auth.projectId,
      environmentId: auth.environmentId,
      agentId: id,
    });

    if (!result) {
      return c.json({ success: false, error: 'Agent not found' }, 404);
    }

    await invalidateEntitiesCachesForUser(auth.userId);
    await Promise.all(
      result.invalidatedApiKeyIds.map((apiKeyId) => invalidateApiKeyAuthCacheById(apiKeyId))
    );

    return c.json({
      success: true,
      agentId: result.agentId,
      deletedTraceEvents: result.deletedTraceEvents,
      deletedTraces: result.deletedTraces,
      deletedEntities: result.deletedEntities,
      deletedApiKeys: result.deletedApiKeys,
    });
  } catch (error: any) {
    logger.error({ error }, 'Failed to delete agent');
    return c.json({ success: false, error: 'Failed to delete agent' }, 500);
  }
});

// GET /api/entities/:id/version-ids - list entity version ids for an agent
app.get('/:id/version-ids', zValidator('param', agentIdParamsSchema), async (c) => {
  const auth = c.get('whyopsAuth');

  if (!auth) {
    return c.json({ success: false, error: 'Unauthorized: authentication required' }, 401);
  }

  try {
    const { id } = c.req.valid('param');

    const agent = await Agent.findOne({
      where: {
        id,
        userId: auth.userId,
        projectId: auth.projectId,
        environmentId: auth.environmentId,
      },
      attributes: ['id', 'name'],
    });

    if (!agent) {
      return c.json({ success: false, error: 'Agent not found' }, 404);
    }

    const versions = await Entity.findAll({
      where: {
        agentId: agent.id,
        userId: auth.userId,
        projectId: auth.projectId,
        environmentId: auth.environmentId,
      },
      attributes: ['id', 'hash', 'createdAt', 'updatedAt'],
      order: [['createdAt', 'DESC']],
    });

    return c.json({
      success: true,
      agentId: agent.id,
      versionIds: versions.map((version) => version.id),
      versions: versions.map((version) => ({
        id: version.id,
        hash: version.hash,
        createdAt: version.createdAt.toISOString(),
        updatedAt: version.updatedAt.toISOString(),
      })),
    });
  } catch (error: any) {
    logger.error({ error }, 'Failed to fetch entity version ids');
    return c.json({ success: false, error: 'Failed to fetch entity version ids' }, 500);
  }
});

// GET /api/entities/versions/:versionId - get details for a single entity version
app.get('/versions/:versionId', zValidator('param', versionIdParamsSchema), async (c) => {
  const auth = c.get('whyopsAuth');

  if (!auth) {
    return c.json({ success: false, error: 'Unauthorized: authentication required' }, 401);
  }

  try {
    const { versionId } = c.req.valid('param');

    const version = await Entity.findOne({
      where: {
        id: versionId,
        userId: auth.userId,
        projectId: auth.projectId,
        environmentId: auth.environmentId,
      },
      attributes: ['id', 'agentId', 'name', 'hash', 'metadata', 'samplingRate', 'createdAt', 'updatedAt'],
    });

    if (!version) {
      return c.json({ success: false, error: 'Entity version not found' }, 404);
    }

    const metadata = (version.metadata && typeof version.metadata === 'object') ? version.metadata : {};
    const systemPrompt = typeof (metadata as any).systemPrompt === 'string'
      ? (metadata as any).systemPrompt
      : '';
    const tools = Array.isArray((metadata as any).tools) ? (metadata as any).tools : [];

    return c.json({
      success: true,
      version: {
        id: version.id,
        agentId: version.agentId,
        name: version.name,
        hash: version.hash,
        samplingRate: Number(version.samplingRate),
        systemPrompt,
        tools,
        metadata,
        createdAt: version.createdAt.toISOString(),
        updatedAt: version.updatedAt.toISOString(),
      },
    });
  } catch (error: any) {
    logger.error({ error }, 'Failed to fetch entity version detail');
    return c.json({ success: false, error: 'Failed to fetch entity version detail' }, 500);
  }
});

// GET /api/entities - List all agents with their stats
app.get('/', async (c) => {
  const auth = c.get('whyopsAuth');

  if (!auth) {
    return c.json({ success: false, error: 'Unauthorized: authentication required' }, 401);
  }

  try {
    const endpointStartedAt = performance.now();
    const count = Math.min(Math.max(parseInt(c.req.query('count') || '20', 10) || 20, 1), 100);
    const page = Math.max(parseInt(c.req.query('page') || '1', 10) || 1, 1);
    const offset = (page - 1) * count;
    const include = parseInclude(c.req.query('include'));
    const includeMetadata = include.has('metadata');
    const localCacheKey = getEntitiesListLocalCacheKey({
      userId: auth.userId,
      projectId: auth.projectId,
      environmentId: auth.environmentId,
      page,
      count,
      includeMetadata,
    });
    const redisCacheKey = getEntitiesListRedisCacheKey({
      userId: auth.userId,
      projectId: auth.projectId,
      environmentId: auth.environmentId,
      page,
      count,
      includeMetadata,
    });

    const cached = entitiesListCache.get(localCacheKey);
    if (cached && Date.now() <= cached.expiresAtMs) {
      const endpointMs = performance.now() - endpointStartedAt;
      c.header('Server-Timing', `entities-cache-local;dur=0, entities-total;dur=${endpointMs.toFixed(1)}`);
      return c.json(cached.payload);
    }

    const redisCached = await redisGetJson<unknown>(redisCacheKey);
    if (redisCached) {
      entitiesListCache.set(localCacheKey, {
        expiresAtMs: Date.now() + ENTITIES_LIST_CACHE_TTL_MS,
        payload: redisCached,
      });
      const endpointMs = performance.now() - endpointStartedAt;
      c.header('Server-Timing', `entities-cache-redis;dur=0, entities-total;dur=${endpointMs.toFixed(1)}`);
      return c.json(redisCached);
    }

    const dbStartedAt = performance.now();

    const attributes = ['id', 'userId', 'projectId', 'environmentId', 'name', 'createdAt', 'updatedAt'] as const;
    let { rows: agents, count: total } = await Agent.findAndCountAll({
      where: {
        userId: auth.userId,
        projectId: auth.projectId,
        environmentId: auth.environmentId,
      },
      attributes: [...attributes],
      order: [['createdAt', 'DESC']],
      limit: count,
      offset,
    });

    // Session scope can drift from where agents were originally ingested.
    // If strict project/environment scope is empty, fall back to user scope.
    if (total === 0) {
      const fallback = await Agent.findAndCountAll({
        where: { userId: auth.userId },
        attributes: [...attributes],
        order: [['createdAt', 'DESC']],
        limit: count,
        offset,
      });

      if (fallback.count > 0) {
        logger.warn(
          {
            userId: auth.userId,
            projectId: auth.projectId,
            environmentId: auth.environmentId,
            fallbackTotal: fallback.count,
          },
          'No agents found in scoped project/environment; falling back to user scope'
        );
        agents = fallback.rows;
        total = fallback.count;
      }
    }

    const agentIds = agents.map((agent) => agent.id);
    const hasRuntimeColumns = await hasAgentRuntimeColumns();
    const defaultRuntimeLimits = getDefaultAgentRuntimeLimits();

    const metricVersions = agentIds.length > 0
      ? await Entity.findAll({
          where: { agentId: agentIds },
          attributes: ['id', 'agentId'],
        })
      : [];

    const latestVersionRows = agentIds.length > 0
      ? await Entity.sequelize!.query<LatestEntityVersionRow>(
          `
            SELECT DISTINCT ON (e.agent_id)
              e.id,
              e.agent_id AS "agentId",
              e.hash,
              e.sampling_rate AS "samplingRate",
              e.created_at AS "createdAt",
              e.updated_at AS "updatedAt"
              ${includeMetadata ? ', e.metadata AS "metadata"' : ''}
            FROM entities e
            WHERE e.agent_id IN (:agentIds)
            ORDER BY e.agent_id, e.created_at DESC
          `,
          {
            replacements: { agentIds },
            type: QueryTypes.SELECT,
          }
        )
      : [];

    const entityIds = metricVersions.map((version) => version.id);
    const metricsByEntityId = await getEntityMetrics(entityIds);
    const agentMetrics = buildAgentMetrics(metricVersions, metricsByEntityId);

    const latestVersionByAgentId = new Map<string, LatestEntityVersionRow>();
    for (const version of latestVersionRows) {
      if (!version.agentId) continue;
      if (!latestVersionByAgentId.has(version.agentId)) {
        latestVersionByAgentId.set(version.agentId, version);
      }
    }

    let runtimeByAgentId = new Map<string, AgentRuntimeRow>();

    if (hasRuntimeColumns && agentIds.length > 0) {
      const agentRuntimeRows = await Agent.findAll({
        where: { id: agentIds },
        attributes: ['id', 'maxTraces', 'maxSpans'],
      });
      runtimeByAgentId = new Map<string, AgentRuntimeRow>(
        agentRuntimeRows.map((row) => [
          row.id,
          {
            id: row.id,
            maxTraces: Number((row as any).maxTraces || defaultRuntimeLimits.maxTraces),
            maxSpans: Number((row as any).maxSpans || defaultRuntimeLimits.maxSpans),
          },
        ])
      );
    }

    const items = agents.map((agent) => {
      const latestVersion = latestVersionByAgentId.get(agent.id);
      const metrics = agentMetrics.get(agent.id);
      const runtime = runtimeByAgentId.get(agent.id);

      return {
        id: agent.id,
        userId: agent.userId,
        projectId: agent.projectId,
        environmentId: agent.environmentId,
        name: agent.name,
        maxTraces: runtime ? Number(runtime.maxTraces) : defaultRuntimeLimits.maxTraces,
        maxSpans: runtime ? Number(runtime.maxSpans) : defaultRuntimeLimits.maxSpans,
        traceCount: metrics?.traceCount ?? 0,
        successPercentage: metrics?.successPercentage ?? 100,
        lastActive: metrics?.lastActive ?? null,
        createdAt: agent.createdAt.toISOString(),
        updatedAt: agent.updatedAt.toISOString(),
        latestVersion: latestVersion
          ? {
              id: latestVersion.id,
              hash: latestVersion.hash,
              metadata: includeMetadata ? latestVersion.metadata : undefined,
              samplingRate: Number(latestVersion.samplingRate),
              createdAt: new Date(latestVersion.createdAt).toISOString(),
              updatedAt: new Date(latestVersion.updatedAt).toISOString(),
            }
          : null,
      };
    });

    const payload = {
      success: true,
      agents: items,
      pagination: {
        total,
        count,
        page,
        totalPages: Math.ceil(total / count),
        hasMore: page * count < total,
      },
    };

    entitiesListCache.set(localCacheKey, {
      expiresAtMs: Date.now() + ENTITIES_LIST_CACHE_TTL_MS,
      payload,
    });

    await redisSetJson(redisCacheKey, payload, Math.ceil(ENTITIES_LIST_CACHE_TTL_MS / 1000));

    const dbMs = performance.now() - dbStartedAt;
    const endpointMs = performance.now() - endpointStartedAt;
    c.header('Server-Timing', `entities-db;dur=${dbMs.toFixed(1)}, entities-total;dur=${endpointMs.toFixed(1)}`);

    return c.json(payload);
  } catch (error: any) {
    logger.error({ error }, 'Failed to list agents');
    return c.json({ success: false, error: 'Failed to list agents' }, 500);
  }
});

// GET /api/entities/:id
app.get('/:id', async (c) => {
    try {
        const auth = c.get('whyopsAuth');
        if (!auth) {
      return c.json({ success: false, error: 'Unauthorized: authentication required' }, 401);
        }

        const hasRuntimeColumns = await hasAgentRuntimeColumns();
        const defaultRuntimeLimits = getDefaultAgentRuntimeLimits();

        const successRatePeriod = Math.min(
          Math.max(parseInt(c.req.query('successRatePeriod') || '7', 10) || 7, 1),
          3650
        );
        const traceCountPeriod = Math.min(
          Math.max(parseInt(c.req.query('traceCountPeriod') || '7', 10) || 7, 1),
          3650
        );
        const include = parseInclude(c.req.query('include'));
        const includeMetadata = include.has('metadata');

        const id = c.req.param('id');
        let agent = await Agent.findOne({
            where: {
                id,
                userId: auth.userId,
                projectId: auth.projectId,
                environmentId: auth.environmentId,
            },
            attributes: [
              'id',
              'userId',
              'projectId',
              'environmentId',
              'name',
              ...(hasRuntimeColumns ? (['maxTraces', 'maxSpans'] as const) : []),
              'createdAt',
              'updatedAt',
            ],
        });

        if (!agent) {
          const fallbackAgent = await Agent.findOne({
            where: {
              id,
              userId: auth.userId,
            },
            attributes: [
              'id',
              'userId',
              'projectId',
              'environmentId',
              'name',
              ...(hasRuntimeColumns ? (['maxTraces', 'maxSpans'] as const) : []),
              'createdAt',
              'updatedAt',
            ],
          });

          if (fallbackAgent) {
            logger.warn(
              {
                userId: auth.userId,
                projectId: auth.projectId,
                environmentId: auth.environmentId,
                agentId: id,
                fallbackProjectId: fallbackAgent.projectId,
                fallbackEnvironmentId: fallbackAgent.environmentId,
              },
              'Agent not found in scoped project/environment; falling back to user scope'
            );
            agent = fallbackAgent;
          }
        }

        if (!agent) return c.json({ success: false, error: 'Agent not found' }, 404);

        const versions = await Entity.findAll({
            where: { agentId: agent.id },
            attributes: ['id', 'agentId', 'name', 'hash', 'metadata', 'samplingRate', 'createdAt', 'updatedAt'],
            order: [['createdAt', 'DESC']],
        });

        const entityIds = versions.map((version) => version.id);
        const agentMetrics = await getSingleAgentMetrics(entityIds, successRatePeriod);
        const successPercentageByDate = await getSingleAgentDailySuccessPercentage(entityIds, successRatePeriod);
        const traceCountsByDate = await getSingleAgentDailyTraceCounts(entityIds, traceCountPeriod);

        return c.json({
          success: true,
            id: agent.id,
            userId: agent.userId,
            projectId: agent.projectId,
            environmentId: agent.environmentId,
            name: agent.name,
            maxTraces: hasRuntimeColumns
              ? Number((agent as any).maxTraces || defaultRuntimeLimits.maxTraces)
              : defaultRuntimeLimits.maxTraces,
            maxSpans: hasRuntimeColumns
              ? Number((agent as any).maxSpans || defaultRuntimeLimits.maxSpans)
              : defaultRuntimeLimits.maxSpans,
            traceCount: agentMetrics.traceCount,
            successPercentage: successPercentageByDate,
            successRatePeriod,
            traceCounts: traceCountsByDate,
            traceCountPeriod,
            lastActive: agentMetrics.lastActive,
            createdAt: agent.createdAt.toISOString(),
            updatedAt: agent.updatedAt.toISOString(),
            latestVersion: versions[0]
              ? {
                  id: versions[0].id,
                  hash: versions[0].hash,
                  metadata: includeMetadata ? versions[0].metadata : undefined,
                  samplingRate: Number(versions[0].samplingRate),
                  createdAt: versions[0].createdAt.toISOString(),
                  updatedAt: versions[0].updatedAt.toISOString(),
                }
              : null,
            versions: versions.map((version) => ({
                id: version.id,
                hash: version.hash,
                metadata: includeMetadata ? version.metadata : undefined,
                samplingRate: Number(version.samplingRate),
                createdAt: version.createdAt.toISOString(),
                updatedAt: version.updatedAt.toISOString(),
            })),
        });
    } catch (e) {
          return c.json({ success: false, error: 'Internal Error' }, 500);
    }
});

export default app;
