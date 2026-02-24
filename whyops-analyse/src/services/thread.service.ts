import { createServiceLogger } from '@whyops/shared/logger';
import { Entity, LLMEvent, Trace } from '@whyops/shared/models';
import { llmCostService } from '@whyops/shared/services';
import { Op, QueryTypes } from 'sequelize';

const logger = createServiceLogger('analyse:thread-service');

const totalTokensExpr = `
  COALESCE(
    NULLIF("metadata"->'usage'->>'totalTokens', '')::bigint,
    NULLIF("metadata"->'usage'->>'total_tokens', '')::bigint,
    NULLIF("metadata"->>'totalTokens', '')::bigint,
    NULLIF("metadata"->>'total_tokens', '')::bigint,
    NULLIF("content"->'usage'->>'totalTokens', '')::bigint,
    NULLIF("content"->'usage'->>'total_tokens', '')::bigint,
    NULLIF("content"->>'totalTokens', '')::bigint,
    NULLIF("content"->>'total_tokens', '')::bigint,
    0
  )
`;

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

export interface ThreadListItem {
  threadId: string;
  userId: string;
  providerId?: string;
  entityId?: string;
  entityName?: string;
  model?: string;
  systemPrompt?: string;
  tools?: any[];
  metadata?: Record<string, any>;
  lastActivity: Date;
  lastEventTimestamp?: Date;
  eventCount: number;
  duration?: number; // milliseconds
  firstEventTimestamp?: Date;
}

interface ThreadListRow {
  threadId: string;
  userId: string;
  providerId?: string;
  entityId?: string;
  entityName?: string;
  model?: string;
  systemPrompt?: string;
  tools?: any;
  metadata?: any;
  lastActivity: string | Date;
  lastEventTimestamp?: string | Date;
  eventCount: string | number;
  firstEventTimestamp?: string | Date;
  duration?: string | number;
}

interface ThreadCountRow {
  total: string | number;
}

export interface EventDetail {
  id: string;
  stepId: number;
  parentStepId?: number;
  spanId?: string;
  eventType: string;
  timestamp: Date;
  content?: any;
  metadata?: any;
  duration?: number; // Time from this event to next event in ms
  timeSinceStart?: number; // Time from thread start in ms
  isLateEvent?: boolean; // Event arrived after subsequent events
}

export interface ThreadDetail {
  threadId: string;
  userId: string;
  providerId?: string;
  entityId?: string;
  entityName?: string;
  lastActivity: Date;
  model?: string;
  systemPrompt?: string;
  tools?: any[];
  metadata?: Record<string, any>;
  // Timing
  firstEventTimestamp: Date;
  lastEventTimestamp: Date;
  duration: number; // milliseconds from first to last event
  // Statistics
  eventCount: number;
  totalTokens: number;
  totalLatency: number;
  avgLatency: number;
  errorCount: number;
  // Events with detailed timing
  events: EventDetail[];
  // Late events detection
  hasLateEvents: boolean;
  eventsPagination?: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
  cost?: any[];
}

export interface GraphNode {
  id: string;
  stepId: number;
  parentStepId?: number;
  type: string;
  model?: string;
  timestamp: Date;
  latencyMs?: number;
  hasError: boolean;
  duration?: number;
  timeSinceStart?: number;
}

export interface GraphEdge {
  from: string;
  to: string;
}

export class ThreadService {
  /**
   * List all threads with duration calculation
   */
  static async listThreads(filters: {
    userId: string;
    agentName?: string;
    page?: number;
    count?: number;
    includeSystemPrompt?: boolean;
    includeTools?: boolean;
    includeMetadata?: boolean;
    startDate?: Date;
    endDate?: Date;
  }): Promise<{ threads: ThreadListItem[]; pagination: { total: number; count: number; page: number; totalPages: number; hasMore: boolean } }> {
    const { userId, agentName, page = 1, count = 20, includeSystemPrompt = false, includeTools = false, includeMetadata = false, startDate, endDate } = filters;
    const offset = (page - 1) * count;

    try {
      const countRows = await Trace.sequelize!.query<ThreadCountRow>(
        `
          WITH event_stats AS (
            SELECT
              ev.trace_id AS trace_id,
              MAX(ev.timestamp) AS last_event_timestamp
            FROM trace_events ev
            WHERE (:startDate IS NULL OR ev.timestamp >= :startDate)
              AND (:endDate IS NULL OR ev.timestamp <= :endDate)
            GROUP BY ev.trace_id
          )
          SELECT COUNT(DISTINCT t.id) AS total
          FROM traces t
          LEFT JOIN entities e ON e.id = t.entity_id
          LEFT JOIN agents a ON a.id = e.agent_id
          LEFT JOIN event_stats es ON es.trace_id = t.id
          WHERE t.user_id = :userId
            AND (:agentName IS NULL OR a.name = :agentName)
            AND (:startDate IS NULL OR COALESCE(es.last_event_timestamp, t.created_at) >= :startDate)
            AND (:endDate IS NULL OR COALESCE(es.last_event_timestamp, t.created_at) <= :endDate)
        `,
        {
          replacements: {
            userId,
            agentName: agentName || null,
            startDate: startDate || null,
            endDate: endDate || null,
          },
          type: QueryTypes.SELECT,
        }
      );

      const total = Number(countRows[0]?.total || 0);

      const selectFields = [
        `t.id AS "threadId"`,
        `t.user_id AS "userId"`,
        `COALESCE(t.provider_id, le.provider_id) AS "providerId"`,
        `t.entity_id AS "entityId"`,
        `e.name AS "entityName"`,
        `COALESCE(
          t.model,
          NULLIF(le.metadata->>'model', ''),
          NULLIF(le.metadata->>'modelName', '')
        ) AS "model"`,
        `COALESCE(es.last_event_timestamp, t.created_at) AS "lastActivity"`,
        `es.last_event_timestamp AS "lastEventTimestamp"`,
        `COALESCE(es.event_count, 0) AS "eventCount"`,
        `es.first_event_timestamp AS "firstEventTimestamp"`,
        `CASE
          WHEN COALESCE(es.event_count, 0) > 0
            THEN EXTRACT(EPOCH FROM (es.last_event_timestamp - es.first_event_timestamp)) * 1000
          ELSE NULL
        END AS "duration"`,
      ];

      if (includeSystemPrompt) {
        selectFields.push(
          `COALESCE(
            t.system_message,
            NULLIF(e.metadata->>'systemPrompt', '')
          ) AS "systemPrompt"`
        );
      }

      if (includeTools) {
        selectFields.push(
          `COALESCE(
            t.tools,
            e.metadata->'tools'
          ) AS "tools"`
        );
      }

      if (includeMetadata) {
        selectFields.push(`t.metadata AS "metadata"`);
      }

      const rows = await Trace.sequelize!.query<ThreadListRow>(
        `
          WITH event_stats AS (
            SELECT
              ev.trace_id AS trace_id,
              MAX(ev.timestamp) AS last_event_timestamp,
              MIN(ev.timestamp) AS first_event_timestamp,
              COUNT(ev.id) AS event_count
            FROM trace_events ev
            WHERE (:startDate IS NULL OR ev.timestamp >= :startDate)
              AND (:endDate IS NULL OR ev.timestamp <= :endDate)
            GROUP BY ev.trace_id
          ),
          latest_event AS (
            SELECT DISTINCT ON (ev.trace_id)
              ev.trace_id,
              ev.provider_id,
              ev.metadata
            FROM trace_events ev
            ORDER BY ev.trace_id, ev.timestamp DESC
          )
          SELECT
            ${selectFields.join(',\n            ')}
          FROM traces t
          LEFT JOIN entities e ON e.id = t.entity_id
          LEFT JOIN agents a ON a.id = e.agent_id
          LEFT JOIN event_stats es ON es.trace_id = t.id
          LEFT JOIN latest_event le ON le.trace_id = t.id
          WHERE t.user_id = :userId
            AND (:agentName IS NULL OR a.name = :agentName)
            AND (:startDate IS NULL OR COALESCE(es.last_event_timestamp, t.created_at) >= :startDate)
            AND (:endDate IS NULL OR COALESCE(es.last_event_timestamp, t.created_at) <= :endDate)
          ORDER BY COALESCE(es.last_event_timestamp, t.created_at) DESC
          LIMIT :count OFFSET :offset
        `,
        {
          replacements: {
            userId,
            agentName: agentName || null,
            count,
            offset,
            startDate: startDate || null,
            endDate: endDate || null,
          },
          type: QueryTypes.SELECT,
        }
      );

      const threads: ThreadListItem[] = rows.map((row) => ({
        threadId: row.threadId,
        userId: row.userId,
        providerId: row.providerId,
        entityId: row.entityId,
        entityName: row.entityName,
        model: row.model,
        systemPrompt: row.systemPrompt,
        tools: row.tools,
        metadata: row.metadata,
        lastActivity: new Date(row.lastActivity),
        lastEventTimestamp: row.lastEventTimestamp ? new Date(row.lastEventTimestamp) : undefined,
        eventCount: Number(row.eventCount || 0),
        duration: row.duration === null || row.duration === undefined ? undefined : Number(row.duration),
        firstEventTimestamp: row.firstEventTimestamp ? new Date(row.firstEventTimestamp) : undefined,
      }));

      return {
        threads,
        pagination: {
          total,
          count,
          page,
          totalPages: Math.ceil(total / count),
          hasMore: page * count < total,
        },
      };
    } catch (error) {
      logger.error({ error, userId, agentName, page, count }, 'Failed to list threads');
      throw new Error('Failed to list threads');
    }
  }

  /**
   * Get complete thread details with timing analysis
   */
  static async getThreadDetail(
    threadId: string,
    userId: string,
    options?: {
      includeSystemPrompt?: boolean;
      includeTools?: boolean;
      includeMetadata?: boolean;
      eventIncludeContent?: boolean;
      eventIncludeMetadata?: boolean;
      eventLimit?: number;
      eventOffset?: number;
    }
  ): Promise<ThreadDetail | null> {
    try {
      const includeSystemPrompt = options?.includeSystemPrompt ?? false;
      const includeTools = options?.includeTools ?? false;
      const includeMetadata = options?.includeMetadata ?? false;
      const eventIncludeContent = options?.eventIncludeContent ?? false;
      const eventIncludeMetadata = options?.eventIncludeMetadata ?? false;
      const eventLimit = Math.min(Math.max(options?.eventLimit ?? 200, 1), 1000);
      const eventOffset = Math.max(options?.eventOffset ?? 0, 0);

      // Get trace with entity information
      const trace = await Trace.findOne({
        where: {
          id: threadId,
          userId,
        },
        include: [
          {
            model: Entity,
            as: 'entity',
            attributes: ['id', 'name', 'metadata'],
            required: false,
          },
        ],
      });

      if (!trace) {
        return null;
      }

      interface ThreadSummaryRow {
        eventCount: string | number;
        firstEventTimestamp: string | Date | null;
        lastEventTimestamp: string | Date | null;
        totalTokens: string | number | null;
        totalLatency: string | number | null;
        errorCount: string | number | null;
      }

      const summaryRows = await LLMEvent.sequelize!.query<ThreadSummaryRow>(
        `
          SELECT
            COUNT(id) AS "eventCount",
            MIN(timestamp) AS "firstEventTimestamp",
            MAX(timestamp) AS "lastEventTimestamp",
            SUM(${totalTokensExpr}) AS "totalTokens",
            SUM(${latencyMsExpr}) AS "totalLatency",
            COALESCE(SUM(CASE WHEN event_type = 'error' THEN 1 ELSE 0 END), 0) AS "errorCount"
          FROM trace_events
          WHERE trace_id = :traceId
        `,
        {
          replacements: { traceId: threadId },
          type: QueryTypes.SELECT,
        }
      );

      const summary = summaryRows[0];
      const eventCount = Number(summary?.eventCount || 0);

      if (eventCount === 0 || !summary?.firstEventTimestamp || !summary?.lastEventTimestamp) {
        return null;
      }

      const firstEventTimestamp = new Date(summary.firstEventTimestamp);
      const lastEventTimestamp = new Date(summary.lastEventTimestamp);
      const duration = lastEventTimestamp.getTime() - firstEventTimestamp.getTime();
      const totalTokens = Number(summary.totalTokens || 0);
      const totalLatency = Number(summary.totalLatency || 0);
      const errorCount = Number(summary.errorCount || 0);

      const lateRows = await LLMEvent.sequelize!.query<{ hasLate: boolean }>(
        `
          SELECT EXISTS (
            SELECT 1
            FROM (
              SELECT
                step_id,
                MAX(step_id) OVER (ORDER BY timestamp) AS max_step
              FROM trace_events
              WHERE trace_id = :traceId
            ) s
            WHERE s.step_id < s.max_step
          ) AS "hasLate"
        `,
        {
          replacements: { traceId: threadId },
          type: QueryTypes.SELECT,
        }
      );
      const hasLateEvents = Boolean(lateRows[0]?.hasLate);

      const attributes = [
        'id',
        'stepId',
        'parentStepId',
        'spanId',
        'eventType',
        'timestamp',
      ] as const;
      const eventAttributes = [...attributes] as string[];
      if (eventIncludeContent) eventAttributes.push('content');
      if (eventIncludeMetadata) eventAttributes.push('metadata');

      const events = await LLMEvent.findAll({
        where: { traceId: threadId },
        attributes: eventAttributes,
        order: [['timestamp', 'ASC']],
        limit: eventLimit + 1,
        offset: eventOffset,
      });

      const hasMoreEvents = events.length > eventLimit;
      const pageEvents = hasMoreEvents ? events.slice(0, eventLimit) : events;
      const nextEventForLast = hasMoreEvents ? events[eventLimit] : undefined;

      let maxStepSeen = Number.MIN_SAFE_INTEGER;
      if (eventOffset > 0) {
        const maxStepRows = await LLMEvent.sequelize!.query<{ maxStep: string | number | null }>(
          `
            SELECT MAX(step_id) AS "maxStep"
            FROM (
              SELECT step_id
              FROM trace_events
              WHERE trace_id = :traceId
              ORDER BY timestamp ASC
              LIMIT :offset
            ) s
          `,
          {
            replacements: { traceId: threadId, offset: eventOffset },
            type: QueryTypes.SELECT,
          }
        );
        maxStepSeen = Number(maxStepRows[0]?.maxStep ?? Number.MIN_SAFE_INTEGER);
      }

      const eventDetails: EventDetail[] = pageEvents.map((event, index) => {
        const timeSinceStart =
          event.timestamp.getTime() - firstEventTimestamp.getTime();

        const nextEvent = index === pageEvents.length - 1 ? nextEventForLast : pageEvents[index + 1];
        const eventDuration = nextEvent
          ? nextEvent.timestamp.getTime() - event.timestamp.getTime()
          : undefined;

        const isLateEvent = event.stepId < maxStepSeen;
        if (event.stepId > maxStepSeen) {
          maxStepSeen = event.stepId;
        }

        return {
          id: event.id,
          stepId: event.stepId,
          parentStepId: event.parentStepId,
          spanId: event.spanId,
          eventType: event.eventType,
          timestamp: event.timestamp,
          content: eventIncludeContent ? (event as any).content : undefined,
          metadata: eventIncludeMetadata ? (event as any).metadata : undefined,
          duration: eventDuration,
          timeSinceStart,
          isLateEvent,
        };
      });

      const entityMetadata = (trace as any).entity?.metadata as Record<string, any> | undefined;
      const resolvedSystemPrompt = includeSystemPrompt
        ? (trace.systemMessage || entityMetadata?.systemPrompt || undefined)
        : undefined;
      const resolvedTools = includeTools
        ? (trace.tools || entityMetadata?.tools || undefined)
        : undefined;

      const modelForCost = trace.model || (trace.metadata as any)?.model;
      const cost = modelForCost ? await llmCostService.getCosts([modelForCost]) : [];

      return {
        threadId: trace.id,
        userId: trace.userId,
        providerId: trace.providerId,
        entityId: trace.entityId,
        entityName: (trace as any).entity?.name,
        lastActivity: lastEventTimestamp,
        model: trace.model || (trace.metadata as any)?.model,
        systemPrompt: resolvedSystemPrompt,
        tools: resolvedTools,
        metadata: includeMetadata ? trace.metadata : undefined,
        firstEventTimestamp,
        lastEventTimestamp,
        duration,
        eventCount,
        totalTokens,
        totalLatency,
        avgLatency: eventCount > 0 ? totalLatency / eventCount : 0,
        errorCount,
        events: eventDetails,
        hasLateEvents,
        eventsPagination: {
          total: eventCount,
          limit: eventLimit,
          offset: eventOffset,
          hasMore: eventOffset + eventLimit < eventCount,
        },
        cost,
      };
    } catch (error) {
      logger.error({ error, threadId }, 'Failed to get thread detail');
      throw new Error('Failed to get thread detail');
    }
  }

  /**
   * Get thread decision graph
   */
  static async getThreadGraph(
    threadId: string,
    options?: { startDate?: Date; endDate?: Date }
  ): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] } | null> {
    try {
      const startDate = options?.startDate;
      const endDate = options?.endDate;

      const where: any = { traceId: threadId };
      if (startDate || endDate) {
        where.timestamp = {};
        if (startDate) where.timestamp[Op.gte] = startDate;
        if (endDate) where.timestamp[Op.lte] = endDate;
      }

      const events = await LLMEvent.findAll({
        where,
        attributes: ['id', 'stepId', 'parentStepId', 'eventType', 'timestamp', 'metadata'],
        order: [['timestamp', 'ASC']],
      });

      if (events.length === 0) {
        return null;
      }

      const firstEventTimestamp = events[0].timestamp.getTime();

      // Build nodes with timing information
      const nodes: GraphNode[] = events.map((e, index) => {
        const nextEvent = events[index + 1];
        const duration = nextEvent
          ? nextEvent.timestamp.getTime() - e.timestamp.getTime()
          : undefined;

        return {
          id: e.id,
          stepId: e.stepId,
          parentStepId: e.parentStepId,
          type: e.eventType,
          model: e.metadata?.model,
          timestamp: e.timestamp,
          latencyMs: e.metadata?.latencyMs,
          hasError: e.eventType === 'error',
          duration,
          timeSinceStart: e.timestamp.getTime() - firstEventTimestamp,
        };
      });

      // Build edges based on parentStepId relationships
      const edges: GraphEdge[] = events
        .filter((e) => e.parentStepId !== null && e.parentStepId !== undefined)
        .map((e) => {
          const parent = events.find((p) => p.stepId === e.parentStepId);
          return parent
            ? {
                from: parent.id,
                to: e.id,
              }
            : null;
        })
        .filter((edge): edge is GraphEdge => edge !== null);

      return { nodes, edges };
    } catch (error) {
      logger.error({ error, threadId }, 'Failed to build thread graph');
      throw new Error('Failed to build thread graph');
    }
  }

  /**
   * Match messages to existing thread
   */
  static async matchThread(
    messages: any[],
    providerId: string
  ): Promise<{ found: boolean; traceId?: string; matchEventId?: string; reason?: string }> {
    if (!messages || !Array.isArray(messages) || messages.length < 2) {
      return { found: false, reason: 'Insufficient history' };
    }

    // Find the last assistant message as anchor
    let anchorMessage = null;
    for (let i = messages.length - 2; i >= 0; i--) {
      if (messages[i].role === 'assistant') {
        anchorMessage = messages[i];
        break;
      }
    }

    if (!anchorMessage || !anchorMessage.content) {
      return { found: false, reason: 'No anchor message found' };
    }

    try {
      const matchedEvent = await LLMEvent.findOne({
        where: {
          providerId,
          eventType: 'llm_response',
          content: {
            [Op.contains]: { content: anchorMessage.content },
          } as any,
        },
        order: [['timestamp', 'DESC']],
      });

      if (matchedEvent) {
        return {
          found: true,
          traceId: matchedEvent.traceId,
          matchEventId: matchedEvent.id,
        };
      }

      return { found: false, reason: 'No matching thread found' };
    } catch (error) {
      logger.error({ error, providerId }, 'Failed to match thread');
      throw new Error('Failed to match thread');
    }
  }
}
