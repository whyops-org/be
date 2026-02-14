import { createServiceLogger } from '@whyops/shared/logger';
import { Entity, LLMEvent, Trace } from '@whyops/shared/models';
import { Op } from 'sequelize';

const logger = createServiceLogger('analyse:thread-service');

export interface ThreadListItem {
  threadId: string;
  userId: string;
  providerId?: string;
  entityId?: string;
  entityName?: string;
  lastActivity: Date;
  eventCount: number;
  duration?: number; // milliseconds
  firstEventTimestamp?: Date;
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
    userId?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ threads: ThreadListItem[]; total?: number }> {
    const { userId, limit = 50, offset = 0 } = filters;

    const where: any = {};
    if (userId) where.userId = userId;

    try {
      // Get all traces with their first and last event timestamps
      const traces = await Trace.findAll({
        where,
        include: [
          {
            model: Entity,
            as: 'entity',
            attributes: ['id', 'name'],
            required: false,
          },
        ],
        limit,
        offset,
        order: [['createdAt', 'DESC']],
      });

      const threads: ThreadListItem[] = await Promise.all(
        traces.map(async (trace) => {
          const events = await LLMEvent.findAll({
            where: { traceId: trace.id },
            attributes: ['timestamp'],
            order: [['timestamp', 'ASC']],
          });

          const eventCount = events.length;
          const firstEvent = events[0]?.timestamp;
          const lastEvent = events[eventCount - 1]?.timestamp;
          const duration =
            firstEvent && lastEvent
              ? lastEvent.getTime() - firstEvent.getTime()
              : undefined;

          return {
            threadId: trace.id,
            userId: trace.userId,
            providerId: trace.providerId,
            entityId: trace.entityId,
            entityName: (trace as any).entity?.name,
            lastActivity: lastEvent || trace.createdAt,
            eventCount,
            duration,
            firstEventTimestamp: firstEvent,
          };
        })
      );

      return { threads };
    } catch (error) {
      logger.error({ error, userId }, 'Failed to list threads');
      throw new Error('Failed to list threads');
    }
  }

  /**
   * Get complete thread details with timing analysis
   */
  static async getThreadDetail(threadId: string): Promise<ThreadDetail | null> {
    try {
      // Get trace with entity information
      const trace = await Trace.findByPk(threadId, {
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

      // Detect late events (events with earlier stepId but later timestamp)
      let hasLateEvents = false;
      const eventDetails: EventDetail[] = events.map((event, index) => {
        const timeSinceStart =
          event.timestamp.getTime() - firstEvent.timestamp.getTime();

        // Calculate duration to next event
        const nextEvent = events[index + 1];
        const eventDuration = nextEvent
          ? nextEvent.timestamp.getTime() - event.timestamp.getTime()
          : undefined;

        // Detect if this is a late event (arrived after an event with higher stepId)
        const isLateEvent = events.some(
          (e, i) =>
            i < index &&
            e.stepId > event.stepId &&
            e.timestamp < event.timestamp
        );

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
        const usage = e.metadata?.usage || e.content?.usage;
        return sum + (usage?.totalTokens || 0);
      }, 0);

      const totalLatency = events.reduce(
        (sum, e) => sum + (e.metadata?.latencyMs || 0),
        0
      );

      const errorCount = events.filter((e) => e.eventType === 'error').length;

      return {
        threadId: trace.id,
        userId: trace.userId,
        providerId: trace.providerId,
        entityId: trace.entityId,
        entityName: (trace as any).entity?.name,
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
