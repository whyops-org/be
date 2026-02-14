import { createServiceLogger } from '@whyops/shared/logger';
import { LLMEvent } from '@whyops/shared/models';
import { nanoid } from 'nanoid';
import { Op } from 'sequelize';
import { traceQueue } from '../utils/queue';
import { SamplingService } from './sampling.service';
import { TraceService } from './trace.service';

const logger = createServiceLogger('analyse:event-service');

export interface EventData {
  eventType: 'user_message' | 'llm_response' | 'tool_call' | 'tool_call_request' | 'tool_call_response' | 'error';
  traceId: string;
  agentName: string;
  spanId?: string;
  stepId?: number;
  parentStepId?: number;
  userId: string;
  projectId: string;
  environmentId: string;
  providerId?: string;
  timestamp?: string;
  content?: any;
  metadata?: Record<string, any>;
  idempotencyKey?: string;
}

export interface EventProcessResult {
  id: string | null;
  status: 'saved' | 'skipped' | 'sampled_out';
  stepId?: number;
  parentStepId?: number;
  spanId?: string;
  message?: string;
}

export interface EventListFilters {
  traceId?: string;
  userId?: string;
  providerId?: string;
  limit?: number;
  offset?: number;
}

export class EventService {
  /**
   * Process and save an event with idempotency, sampling, and step management
   */
  static async processEvent(data: EventData): Promise<EventProcessResult> {
    // Wrap in per-trace queue for sequential processing
    return traceQueue.getQueue(data.traceId).add(async () => {
      // 1. Ensure Trace Exists
      await TraceService.ensureTraceExists({
        traceId: data.traceId,
        userId: data.userId,
        projectId: data.projectId,
        environmentId: data.environmentId,
        providerId: data.providerId,
        agentName: data.agentName,
        content: data.content,
        metadata: data.metadata,
        timestamp: data.timestamp,
      });

      // 2. Sampling Check
      const eventHash = SamplingService.generateContentHash({
        traceId: data.traceId,
        eventType: data.eventType,
        userId: data.userId,
        parentStepId: data.parentStepId,
        content: data.content,
      });

      const samplingResult = await SamplingService.shouldSampleEvent(
        data.userId,
        data.environmentId,
        data.agentName,
        eventHash
      );

      if (!samplingResult.shouldSample) {
        logger.debug(
          {
            traceId: data.traceId,
            samplingRate: samplingResult.samplingRate,
            hashValue: samplingResult.hashValue,
          },
          'Event rejected by sampling'
        );

        return {
          id: null,
          status: 'sampled_out',
          message: samplingResult.reason,
        };
      }

      // 3. Idempotency Check
      const idempotencyKey = data.idempotencyKey || `hash_${eventHash}`;

      const existingEvent = await LLMEvent.findOne({
        where: {
          traceId: data.traceId,
          metadata: {
            [Op.contains]: { idempotencyKey },
          } as any,
        },
      });

      if (existingEvent) {
        logger.info(
          {
            traceId: data.traceId,
            idempotencyKey,
            existingEventId: existingEvent.id,
          },
          'Idempotent duplicate detected, skipping'
        );

        return {
          id: existingEvent.id,
          status: 'skipped',
          stepId: existingEvent.stepId,
          parentStepId: existingEvent.parentStepId,
          spanId: existingEvent.spanId,
          message: 'Event already exists (idempotency check)',
        };
      }

      // 4. Step Resolution
      const { stepId, parentStepId, spanId } = await this.resolveStepInfo(
        data.traceId,
        data.stepId,
        data.parentStepId,
        data.spanId
      );

      // 5. Create Event
      const finalMetadata = {
        ...(data.metadata || {}),
        idempotencyKey,
      };

      const event = await LLMEvent.create({
        eventType: data.eventType,
        traceId: data.traceId,
        stepId,
        parentStepId,
        spanId,
        timestamp: data.timestamp ? new Date(data.timestamp) : new Date(),
        content: data.content,
        metadata: finalMetadata,
        userId: data.userId,
        providerId: data.providerId,
      });

      logger.info(
        {
          eventId: event.id,
          traceId: data.traceId,
          stepId,
          eventType: data.eventType,
          spanId,
        },
        'Event saved'
      );

      // 6. Auto-create tool_call_request event if LLM response contains tool calls
      if (data.eventType === 'llm_response' && this.hasToolCalls(data.content)) {
        await this.createToolCallRequestEvent({
          traceId: data.traceId,
          userId: data.userId,
          providerId: data.providerId,
          parentStepId: stepId,
          timestamp: data.timestamp,
          content: data.content,
          metadata: data.metadata,
        });
      }

      return {
        id: event.id,
        status: 'saved',
        stepId,
        parentStepId,
        spanId,
      };
    });
  }

  /**
   * Process multiple events in batch
   */
  static async processBatchEvents(events: EventData[]): Promise<EventProcessResult[]> {
    return Promise.all(events.map((event) => this.processEvent(event)));
  }

  /**
   * List events with filters and pagination
   */
  static async listEvents(filters: EventListFilters) {
    const { traceId, userId, providerId, limit = 100, offset = 0 } = filters;

    const where: any = {};
    if (traceId) where.traceId = traceId;
    if (userId) where.userId = userId;
    if (providerId) where.providerId = providerId;

    const events = await LLMEvent.findAll({
      where,
      limit,
      offset,
      order: [['timestamp', 'DESC']],
    });

    const total = await LLMEvent.count({ where });

    return {
      events,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + limit < total,
      },
    };
  }

  /**
   * Get event by ID
   */
  static async getEventById(id: string): Promise<LLMEvent | null> {
    return LLMEvent.findByPk(id);
  }

  /**
   * Check if event content contains tool calls
   */
  private static hasToolCalls(content: any): boolean {
    if (!content) return false;
    
    // Check for OpenAI format
    if (content.toolCalls && Array.isArray(content.toolCalls) && content.toolCalls.length > 0) {
      return true;
    }
    
    // Check for Anthropic format
    if (content.tool_use || content.tool_calls) {
      return true;
    }
    
    return false;
  }

  /**
   * Create a tool_call_request event to track tool execution time
   */
  private static async createToolCallRequestEvent(data: {
    traceId: string;
    userId: string;
    providerId?: string;
    parentStepId: number;
    timestamp?: string;
    content: any;
    metadata?: Record<string, any>;
  }): Promise<void> {
    try {
      const toolCalls = data.content.toolCalls || data.content.tool_calls || [];
      
      // Get the next step ID
      const lastEvent = await LLMEvent.findOne({
        where: { traceId: data.traceId },
        order: [['stepId', 'DESC']],
      });
      
      const stepId = lastEvent ? lastEvent.stepId + 1 : 1;
      const spanId = `span_${nanoid()}`;
      
      // Create tool_call_request event with same timestamp as LLM response
      const toolCallRequestEvent = await LLMEvent.create({
        eventType: 'tool_call_request',
        traceId: data.traceId,
        stepId,
        parentStepId: data.parentStepId,
        spanId,
        timestamp: data.timestamp ? new Date(data.timestamp) : new Date(),
        content: {
          toolCalls,
          requestedAt: data.timestamp || new Date().toISOString(),
        },
        metadata: {
          ...data.metadata,
          autoGenerated: true,
          toolCallCount: toolCalls.length,
        },
        userId: data.userId,
        providerId: data.providerId,
      });
      
      logger.info(
        {
          eventId: toolCallRequestEvent.id,
          traceId: data.traceId,
          stepId,
          parentStepId: data.parentStepId,
          toolCallCount: toolCalls.length,
        },
        'Tool call request event auto-created'
      );
    } catch (error) {
      logger.error(
        { error, traceId: data.traceId },
        'Failed to create tool_call_request event'
      );
      // Don't throw - this is optional tracking
    }
  }

  /**
   * Resolve step information for an event
   */
  private static async resolveStepInfo(
    traceId: string,
    stepId?: number,
    parentStepId?: number,
    spanId?: string
  ): Promise<{ stepId: number; parentStepId?: number; spanId: string }> {
    let resolvedStepId = stepId;
    let resolvedParentStepId = parentStepId;
    const resolvedSpanId = spanId || `span_${nanoid()}`;

    if (!resolvedStepId) {
      const lastEvent = await LLMEvent.findOne({
        where: { traceId },
        order: [['stepId', 'DESC']],
      });

      if (lastEvent) {
        resolvedStepId = lastEvent.stepId + 1;
        resolvedParentStepId = lastEvent.stepId;
      } else {
        resolvedStepId = 1;
        resolvedParentStepId = undefined;
      }
    } else if (!resolvedParentStepId && resolvedStepId > 1) {
      resolvedParentStepId = resolvedStepId - 1;
    }

    return {
      stepId: resolvedStepId,
      parentStepId: resolvedParentStepId,
      spanId: resolvedSpanId,
    };
  }
}
