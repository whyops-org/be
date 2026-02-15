import { createServiceLogger } from '@whyops/shared/logger';
import { Entity, LLMEvent, Trace } from '@whyops/shared/models';
import { Op, QueryTypes } from 'sequelize';

const logger = createServiceLogger('analyse:thread-service');

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
  content: any;
  metadata: any;
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
  }): Promise<{ threads: ThreadListItem[]; pagination: { total: number; count: number; page: number; totalPages: number; hasMore: boolean } }> {
    const { userId, agentName, page = 1, count = 20 } = filters;
    const offset = (page - 1) * count;

    try {
      const countRows = await Trace.sequelize!.query<ThreadCountRow>(
        `
          SELECT COUNT(DISTINCT t.id) AS total
          FROM traces t
          LEFT JOIN entities e ON e.id = t.entity_id
          LEFT JOIN agents a ON a.id = e.agent_id
          WHERE t.user_id = :userId
            AND (:agentName IS NULL OR a.name = :agentName)
        `,
        {
          replacements: {
            userId,
            agentName: agentName || null,
          },
          type: QueryTypes.SELECT,
        }
      );

      const total = Number(countRows[0]?.total || 0);

      const rows = await Trace.sequelize!.query<ThreadListRow>(
        `
          WITH event_stats AS (
            SELECT
              ev.trace_id AS trace_id,
              MAX(ev.timestamp) AS last_event_timestamp,
              MIN(ev.timestamp) AS first_event_timestamp,
              COUNT(ev.id) AS event_count
            FROM trace_events ev
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
            t.id AS "threadId",
            t.user_id AS "userId",
            COALESCE(t.provider_id, le.provider_id) AS "providerId",
            t.entity_id AS "entityId",
            e.name AS "entityName",
            COALESCE(
              t.model,
              NULLIF(le.metadata->>'model', ''),
              NULLIF(le.metadata->>'modelName', '')
            ) AS "model",
            COALESCE(
              t.system_message,
              NULLIF(e.metadata->>'systemPrompt', '')
            ) AS "systemPrompt",
            COALESCE(
              t.tools,
              e.metadata->'tools'
            ) AS "tools",
            t.metadata AS "metadata",
            COALESCE(es.last_event_timestamp, t.created_at) AS "lastActivity",
            es.last_event_timestamp AS "lastEventTimestamp",
            COALESCE(es.event_count, 0) AS "eventCount",
            es.first_event_timestamp AS "firstEventTimestamp",
            CASE
              WHEN COALESCE(es.event_count, 0) > 0
                THEN EXTRACT(EPOCH FROM (es.last_event_timestamp - es.first_event_timestamp)) * 1000
              ELSE NULL
            END AS "duration"
          FROM traces t
          LEFT JOIN entities e ON e.id = t.entity_id
          LEFT JOIN agents a ON a.id = e.agent_id
          LEFT JOIN event_stats es ON es.trace_id = t.id
          LEFT JOIN latest_event le ON le.trace_id = t.id
          WHERE t.user_id = :userId
            AND (:agentName IS NULL OR a.name = :agentName)
          ORDER BY COALESCE(es.last_event_timestamp, t.created_at) DESC
          LIMIT :count OFFSET :offset
        `,
        {
          replacements: {
            userId,
            agentName: agentName || null,
            count,
            offset,
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
  static async getThreadDetail(threadId: string, userId: string): Promise<ThreadDetail | null> {
    try {
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
            attributes: ['id', 'name'],
            required: false,
          },
        ],
      });

      if (!trace) {
        return null;
      }

      // Get all events ordered by timestamp (natural order)
      const events = await LLMEvent.findAll({
        where: { traceId: threadId },
        order: [['timestamp', 'ASC']],
      });

      if (events.length === 0) {
        return null;
      }

      const firstEvent = events[0];
      const lastEvent = events[events.length - 1];
      const duration = lastEvent.timestamp.getTime() - firstEvent.timestamp.getTime();

      // Detect late events in O(n) after timestamp ordering
      let hasLateEvents = false;
      let maxStepSeen = Number.MIN_SAFE_INTEGER;
      const eventDetails: EventDetail[] = events.map((event, index) => {
        const timeSinceStart =
          event.timestamp.getTime() - firstEvent.timestamp.getTime();

        // Calculate duration to next event
        const nextEvent = events[index + 1];
        const eventDuration = nextEvent
          ? nextEvent.timestamp.getTime() - event.timestamp.getTime()
          : undefined;

        // Late event: lower step appears after higher step in timestamp-sorted stream
        const isLateEvent = event.stepId < maxStepSeen;
        if (event.stepId > maxStepSeen) {
          maxStepSeen = event.stepId;
        }

        if (isLateEvent) hasLateEvents = true;

        return {
          id: event.id,
          stepId: event.stepId,
          parentStepId: event.parentStepId,
          spanId: event.spanId,
          eventType: event.eventType,
          timestamp: event.timestamp,
          content: event.content,
          metadata: event.metadata,
          duration: eventDuration,
          timeSinceStart,
          isLateEvent,
        };
      });

      // Calculate statistics
      const totalTokens = events.reduce((sum, e) => {
        const usage = e.metadata?.usage || e.content?.usage || {};
        const total = usage?.totalTokens ?? usage?.total_tokens ?? 0;
        return sum + Number(total || 0);
      }, 0);

      const totalLatency = events.reduce(
        (sum, e) => sum + Number(e.metadata?.latencyMs || 0),
        0
      );

      const errorCount = events.filter((e) => e.eventType === 'error').length;

      return {
        threadId: trace.id,
        userId: trace.userId,
        providerId: trace.providerId,
        entityId: trace.entityId,
        entityName: (trace as any).entity?.name,
        lastActivity: lastEvent.timestamp,
        model: trace.model,
        systemPrompt: trace.systemMessage,
        tools: trace.tools,
        metadata: trace.metadata,
        firstEventTimestamp: firstEvent.timestamp,
        lastEventTimestamp: lastEvent.timestamp,
        duration,
        eventCount: events.length,
        totalTokens,
        totalLatency,
        avgLatency: totalLatency / events.length,
        errorCount,
        events: eventDetails,
        hasLateEvents,
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
    threadId: string
  ): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] } | null> {
    try {
      const events = await LLMEvent.findAll({
        where: { traceId: threadId },
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
