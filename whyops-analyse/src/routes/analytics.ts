import { createServiceLogger } from '@whyops/shared/logger';
import { Agent, Entity, LLMEvent, Trace } from '@whyops/shared/models';
import { Hono } from 'hono';
import { Op, QueryTypes } from 'sequelize';

const logger = createServiceLogger('analyse:analytics');
const app = new Hono();

interface DashboardDailySuccessRow {
  day: string;
  totalEvents: string | number;
  errorEvents: string | number;
}

const providerExpr = `COALESCE(NULLIF("metadata"->>'provider', ''), 'unknown')`;
const modelExpr = `COALESCE(NULLIF("metadata"->>'model', ''), 'unknown')`;
const totalTokensExpr = `COALESCE(NULLIF("metadata"->'usage'->>'totalTokens', '')::bigint, NULLIF("metadata"->>'totalTokens', '')::bigint, 0)`;
const latencyMsExpr = `
  NULLIF(
    REGEXP_REPLACE(
      COALESCE(
        "metadata"->>'latencyMs',
        "metadata"->>'latency_ms',
        "content"->>'latencyMs',
        "content"->>'latency_ms',
        ''
      ),
      '[^0-9.]',
      '',
      'g'
    ),
    ''
  )::numeric
`;

// GET /api/analytics/usage - Get usage statistics
app.get('/usage', async (c) => {
  try {
    const userId = c.req.query('userId');
    const providerId = c.req.query('providerId');
    const startDate = c.req.query('startDate');
    const endDate = c.req.query('endDate');

    const where: any = {};
    if (userId) where.userId = userId;
    if (providerId) where.providerId = providerId;
    
    if (startDate || endDate) {
      where.timestamp = {};
      if (startDate) where.timestamp[Op.gte] = new Date(startDate);
      if (endDate) where.timestamp[Op.lte] = new Date(endDate);
    }

    const stats = await LLMEvent.findAll({
      attributes: [
        [LLMEvent.sequelize!.literal(providerExpr), 'provider'],
        [LLMEvent.sequelize!.literal(modelExpr), 'model'],
        [LLMEvent.sequelize!.fn('COUNT', LLMEvent.sequelize!.col('id')), 'requestCount'],
        [LLMEvent.sequelize!.fn('SUM', LLMEvent.sequelize!.literal(totalTokensExpr)), 'totalTokens'],
        [LLMEvent.sequelize!.literal(`AVG(${latencyMsExpr})`), 'avgLatency'],
        [LLMEvent.sequelize!.fn('SUM', LLMEvent.sequelize!.literal(`CASE WHEN "event_type" = 'error' THEN 1 ELSE 0 END`)), 'errorCount'],
      ],
      where,
      group: [providerExpr, modelExpr],
      raw: true,
    });

    return c.json({ stats });
  } catch (error: any) {
    logger.error({ error }, 'Failed to fetch analytics');
    return c.json({ error: 'Failed to fetch analytics' }, 500);
  }
});

// GET /api/analytics/timeline - Get timeline data
app.get('/timeline', async (c) => {
  try {
    const userId = c.req.query('userId');
    const providerId = c.req.query('providerId');
    const startDate = c.req.query('startDate');
    const endDate = c.req.query('endDate');
    const interval = c.req.query('interval') || 'hour'; // hour, day, week

    const where: any = {};
    if (userId) where.userId = userId;
    if (providerId) where.providerId = providerId;
    
    if (startDate || endDate) {
      where.timestamp = {};
      if (startDate) where.timestamp[Op.gte] = new Date(startDate);
      if (endDate) where.timestamp[Op.lte] = new Date(endDate);
    }

    // Determine date truncation based on interval
    let dateTrunc = "date_trunc('hour', timestamp)";
    if (interval === 'day') {
      dateTrunc = "date_trunc('day', timestamp)";
    } else if (interval === 'week') {
      dateTrunc = "date_trunc('week', timestamp)";
    }

    const timeline = await LLMEvent.findAll({
      attributes: [
        [LLMEvent.sequelize!.literal(dateTrunc), 'interval'],
        [LLMEvent.sequelize!.fn('COUNT', LLMEvent.sequelize!.col('id')), 'requestCount'],
        [LLMEvent.sequelize!.fn('SUM', LLMEvent.sequelize!.literal("(usage->>'totalTokens')::int")), 'totalTokens'],
      ],
      where,
      group: ['interval'],
      order: [[LLMEvent.sequelize!.literal(dateTrunc), 'ASC']],
      raw: true,
    });

    return c.json({ timeline });
  } catch (error: any) {
    logger.error({ error }, 'Failed to fetch timeline');
    return c.json({ error: 'Failed to fetch timeline' }, 500);
  }
});

// GET /api/analytics/summary - Get high-level summary
app.get('/summary', async (c) => {
  const auth = c.get('analyseAuth');

  if (!auth) {
    return c.json({ error: 'Unauthorized: authentication required' }, 401);
  }

  try {
    const userId = c.req.query('userId') || auth.userId;
    const providerId = c.req.query('providerId');

    const where: any = { userId };
    if (providerId) where.providerId = providerId;

    const summary = await LLMEvent.findOne({
      attributes: [
        [LLMEvent.sequelize!.fn('COUNT', LLMEvent.sequelize!.col('id')), 'totalRequests'],
        [LLMEvent.sequelize!.fn('COUNT', LLMEvent.sequelize!.fn('DISTINCT', LLMEvent.sequelize!.col('trace_id'))), 'totalThreads'],
        [LLMEvent.sequelize!.fn('SUM', LLMEvent.sequelize!.literal(totalTokensExpr)), 'totalTokens'],
        [LLMEvent.sequelize!.literal(`AVG(${latencyMsExpr})`), 'avgLatency'],
        [LLMEvent.sequelize!.fn('SUM', LLMEvent.sequelize!.literal(`CASE WHEN "event_type" = 'error' THEN 1 ELSE 0 END`)), 'errorCount'],
      ],
      where,
      raw: true,
    });

    return c.json({ summary });
  } catch (error: any) {
    logger.error({ error }, 'Failed to fetch summary');
    return c.json({ error: 'Failed to fetch summary' }, 500);
  }
});

// GET /api/analytics/dashboard - Get dashboard-specific stats
app.get('/dashboard', async (c) => {
  const auth = c.get('analyseAuth');

  if (!auth) {
    return c.json({ error: 'Unauthorized: authentication required' }, 401);
  }

  try {
    // Get all agents for the user
    const agents = await Agent.findAll({
      where: {
        userId: auth.userId,
        projectId: auth.projectId,
        environmentId: auth.environmentId,
      },
    });

    const agentIds = agents.map(a => a.id);

    // Get all entity IDs for these agents
    const entities = await Entity.findAll({
      where: { agentId: agentIds },
      attributes: ['id'],
    });

    const entityIds = entities.map(e => e.id);

    // Get total traces count
    const totalTraces = await Trace.count({
      where: { entityId: entityIds },
    });

    // Get traces in last 24 hours (active traces)
    const oneDayAgo = new Date();
    oneDayAgo.setDate(oneDayAgo.getDate() - 1);

    const activeTraces = await Trace.count({
      where: {
        entityId: entityIds,
        createdAt: { [Op.gte]: oneDayAgo },
      },
    });

    // Get all traces for error calculation
    const traces = await Trace.findAll({
      where: { entityId: entityIds },
      attributes: ['id'],
    });
    const traceIds = traces.map(t => t.id);

    // Calculate error rate from events
    const totalEvents = await LLMEvent.count({
      where: { traceId: traceIds },
    });

    const errorEvents = await LLMEvent.count({
      where: {
        traceId: traceIds,
        eventType: 'error',
      },
    });

    const successRate = totalEvents > 0
      ? Math.round(((totalEvents - errorEvents) / totalEvents) * 1000) / 10
      : 100;

    // Get average latency
    const latencyStats = await LLMEvent.findOne({
      attributes: [
        [LLMEvent.sequelize!.literal(`AVG(${latencyMsExpr})`), 'avgLatency'],
      ],
      where: { traceId: traceIds },
      raw: true,
    });

    const avgLatencyMs = Number((latencyStats as any)?.avgLatency) || 0;
    const avgLatency = avgLatencyMs > 1000
      ? `${(avgLatencyMs / 1000).toFixed(1)}s`
      : `${Math.round(avgLatencyMs)}ms`;

    // Get success rate timeline for chart (last 7 days)
    const since = new Date();
    since.setDate(since.getDate() - 6);
    since.setHours(0, 0, 0, 0);

    const dailyRows = traceIds.length > 0
      ? await LLMEvent.sequelize!.query<DashboardDailySuccessRow>(
          `
            SELECT
              TO_CHAR(DATE_TRUNC('day', e.timestamp AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS "day",
              COUNT(*) AS "totalEvents",
              COALESCE(SUM(CASE WHEN e.event_type = 'error' THEN 1 ELSE 0 END), 0) AS "errorEvents"
            FROM trace_events e
            WHERE e.trace_id IN (:traceIds)
              AND e.timestamp >= :since
            GROUP BY 1
            ORDER BY 1 ASC
          `,
          {
            replacements: {
              traceIds,
              since,
            },
            type: QueryTypes.SELECT,
          }
        )
      : [];

    const byDay = new Map<string, { total: number; errors: number }>();
    for (const row of dailyRows) {
      byDay.set(row.day, {
        total: Number(row.totalEvents || 0),
        errors: Number(row.errorEvents || 0),
      });
    }

    const timelineData = [];
    for (let i = 0; i < 7; i++) {
      const dayDate = new Date(since);
      dayDate.setDate(since.getDate() + i);
      const dayKey = dayDate.toISOString().slice(0, 10);
      const stats = byDay.get(dayKey);
      const daySuccess = stats && stats.total > 0
        ? Math.round(((stats.total - stats.errors) / stats.total) * 100)
        : 0;

      timelineData.push({
        day: dayDate.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase(),
        value: daySuccess,
      });
    }

    return c.json({
      totalAgents: agents.length,
      activeTraces,
      successRate,
      avgLatency,
      timeline: timelineData,
    });
  } catch (error: any) {
    logger.error({ error }, 'Failed to fetch dashboard stats');
    return c.json({ error: 'Failed to fetch dashboard stats' }, 500);
  }
});

export default app;
