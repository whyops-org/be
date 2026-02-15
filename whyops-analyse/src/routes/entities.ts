import { zValidator } from '@hono/zod-validator';
import { createServiceLogger } from '@whyops/shared/logger';
import { Agent, Entity } from '@whyops/shared/models';
import { Hono } from 'hono';
import { QueryTypes } from 'sequelize';
import { z } from 'zod';
import { EntityService } from '../services/entity.service';

const logger = createServiceLogger('analyse:entities');
const app = new Hono();

interface EntityMetricRow {
  entityId: string;
  traceCount: string | number;
  totalEvents: string | number;
  errorEvents: string | number;
  lastActiveAt: string | Date | null;
}

interface AggregatedAgentMetrics {
  traceCount: number;
  successPercentage: number;
  lastActive: string | null;
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

async function getEntityMetrics(entityIds: string[]): Promise<Map<string, EntityMetricRow>> {
  const metricsByEntityId = new Map<string, EntityMetricRow>();

  if (entityIds.length === 0) {
    return metricsByEntityId;
  }

  const rows = await Entity.sequelize!.query<EntityMetricRow>(
    `
      SELECT
        t.entity_id AS "entityId",
        COUNT(DISTINCT t.id) AS "traceCount",
        COUNT(e.id) AS "totalEvents",
        COALESCE(SUM(CASE WHEN e.event_type = 'error' THEN 1 ELSE 0 END), 0) AS "errorEvents",
        MAX(t.created_at) AS "lastActiveAt"
      FROM traces t
      LEFT JOIN trace_events e ON e.trace_id = t.id
      WHERE t.entity_id IN (:entityIds)
      GROUP BY t.entity_id
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
  versions: Entity[],
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

app.post('/init', zValidator('json', entityInitSchema), async (c) => {
  const data = c.req.valid('json');
  const auth = c.get('analyseAuth');

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
    logger.error({ error, data }, 'Failed to init entity');
    return c.json({ success: false, error: 'Failed to initialize agent' }, 500);
  }
});

// GET /api/entities - List all agents with their stats
app.get('/', async (c) => {
  const auth = c.get('analyseAuth');

  if (!auth) {
    return c.json({ success: false, error: 'Unauthorized: authentication required' }, 401);
  }

  try {
    const count = Math.min(Math.max(parseInt(c.req.query('count') || '20', 10) || 20, 1), 100);
    const page = Math.max(parseInt(c.req.query('page') || '1', 10) || 1, 1);
    const offset = (page - 1) * count;

    const { rows: agents, count: total } = await Agent.findAndCountAll({
      where: {
        userId: auth.userId,
        projectId: auth.projectId,
        environmentId: auth.environmentId,
      },
      attributes: ['id', 'userId', 'projectId', 'environmentId', 'name', 'createdAt', 'updatedAt'],
      order: [['createdAt', 'DESC']],
      limit: count,
      offset,
    });

    const agentIds = agents.map((agent) => agent.id);

    const versions = agentIds.length > 0
      ? await Entity.findAll({
          where: { agentId: agentIds },
          attributes: ['id', 'agentId', 'name', 'hash', 'metadata', 'samplingRate', 'createdAt', 'updatedAt'],
          order: [['createdAt', 'DESC']],
        })
      : [];

    const entityIds = versions.map((version) => version.id);
    const metricsByEntityId = await getEntityMetrics(entityIds);
    const agentMetrics = buildAgentMetrics(versions, metricsByEntityId);

    const latestVersionByAgentId = new Map<string, Entity>();
    for (const version of versions) {
      if (!version.agentId) continue;
      if (!latestVersionByAgentId.has(version.agentId)) {
        latestVersionByAgentId.set(version.agentId, version);
      }
    }

    const items = agents.map((agent) => {
      const latestVersion = latestVersionByAgentId.get(agent.id);
      const metrics = agentMetrics.get(agent.id);

      return {
        id: agent.id,
        userId: agent.userId,
        projectId: agent.projectId,
        environmentId: agent.environmentId,
        name: agent.name,
        traceCount: metrics?.traceCount ?? 0,
        successPercentage: metrics?.successPercentage ?? 100,
        lastActive: metrics?.lastActive ?? null,
        createdAt: agent.createdAt.toISOString(),
        updatedAt: agent.updatedAt.toISOString(),
        latestVersion: latestVersion
          ? {
              id: latestVersion.id,
              hash: latestVersion.hash,
              metadata: latestVersion.metadata,
              samplingRate: Number(latestVersion.samplingRate),
              createdAt: latestVersion.createdAt.toISOString(),
              updatedAt: latestVersion.updatedAt.toISOString(),
            }
          : null,
      };
    });

    return c.json({
      success: true,
      agents: items,
      pagination: {
        total,
        count,
        page,
        totalPages: Math.ceil(total / count),
        hasMore: page * count < total,
      },
    });
  } catch (error: any) {
    logger.error({ error }, 'Failed to list agents');
    return c.json({ success: false, error: 'Failed to list agents' }, 500);
  }
});

// GET /api/entities/:id
app.get('/:id', async (c) => {
    try {
        const auth = c.get('analyseAuth');
        if (!auth) {
      return c.json({ success: false, error: 'Unauthorized: authentication required' }, 401);
        }

        const successRatePeriod = Math.min(
          Math.max(parseInt(c.req.query('successRatePeriod') || '7', 10) || 7, 1),
          3650
        );

        const id = c.req.param('id');
        const agent = await Agent.findOne({
            where: {
                id,
                userId: auth.userId,
                projectId: auth.projectId,
                environmentId: auth.environmentId,
            },
            attributes: ['id', 'userId', 'projectId', 'environmentId', 'name', 'createdAt', 'updatedAt'],
        });

        if (!agent) return c.json({ success: false, error: 'Agent not found' }, 404);

        const versions = await Entity.findAll({
            where: { agentId: agent.id },
            attributes: ['id', 'agentId', 'name', 'hash', 'metadata', 'samplingRate', 'createdAt', 'updatedAt'],
            order: [['createdAt', 'DESC']],
        });

        const entityIds = versions.map((version) => version.id);
        const agentMetrics = await getSingleAgentMetrics(entityIds, successRatePeriod);
        const successPercentageByDate = await getSingleAgentDailySuccessPercentage(entityIds, successRatePeriod);

        return c.json({
          success: true,
            id: agent.id,
            userId: agent.userId,
            projectId: agent.projectId,
            environmentId: agent.environmentId,
            name: agent.name,
            traceCount: agentMetrics.traceCount,
            successPercentage: successPercentageByDate,
            successRatePeriod,
            lastActive: agentMetrics.lastActive,
            createdAt: agent.createdAt.toISOString(),
            updatedAt: agent.updatedAt.toISOString(),
            latestVersion: versions[0]
              ? {
                  id: versions[0].id,
                  hash: versions[0].hash,
                  metadata: versions[0].metadata,
                  samplingRate: Number(versions[0].samplingRate),
                  createdAt: versions[0].createdAt.toISOString(),
                  updatedAt: versions[0].updatedAt.toISOString(),
                }
              : null,
            versions: versions.map((version) => ({
                id: version.id,
                hash: version.hash,
                metadata: version.metadata,
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
