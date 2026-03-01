import env from '@whyops/shared/env';
import { createServiceLogger } from '@whyops/shared/logger';
import { enqueueRedisStreamEvent } from '@whyops/shared/services';

const logger = createServiceLogger('proxy:analyse');

type EventType = 'user_message' | 'llm_response' | 'llm_thinking' | 'tool_call' | 'tool_call_request' | 'tool_call_response' | 'tool_result' | 'error';

export interface TraceEventPayload {
  // Required fields
  eventType: EventType;
  // Optional common fields
  traceId?: string;
  spanId?: string;
  stepId?: number;
  parentStepId?: number;
  providerId?: string;
  agentName?: string;
  entityName?: string;
  timestamp?: string;
  content?: unknown;
  metadata?: Record<string, unknown>;
  // Allow additional fields for flexibility
  [key: string]: unknown;
}

/**
 * Send trace event data to the analyse service (non-blocking)
 * Only forwards the API key - all auth info is extracted by the events API
 */
export async function sendToAnalyse(
  apiKey: string,
  payload: TraceEventPayload
): Promise<void> {
  try {
    const queued = await enqueueRedisStreamEvent(
      env.EVENTS_STREAM_NAME,
      {
        apiKey,
        payload: {
          ...payload,
          timestamp: payload.timestamp || new Date().toISOString(),
        },
        source: 'proxy',
        retryCount: 0,
        enqueuedAt: new Date().toISOString(),
      },
      { maxLen: env.EVENTS_STREAM_MAX_LEN }
    );

    if (queued.queued) {
      logger.debug(
        {
          traceId: payload.traceId,
          eventType: payload.eventType,
          messageId: queued.messageId,
        },
        'Event queued to Redis stream'
      );
      return;
    }

    const analyseUrl = `${env.ANALYSE_URL}/api/events/ingest`;

    // Fire-and-forget request - only forward API key
    fetch(analyseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        ...payload,
        timestamp: payload.timestamp || new Date().toISOString(),
      }),
      // Use keepalive to allow request to continue even if response is not read
      // @ts-ignore - keepalive is valid but not in TypeScript types yet
      keepalive: true,
    }).catch((error) => {
      // Log error but don't throw - this is non-blocking
      logger.error({ error, traceId: payload.traceId }, 'Failed to send to analyse service');
    });

    logger.debug({ traceId: payload.traceId, eventType: payload.eventType }, 'Event sent to analyse service');
  } catch (error) {
    // Never throw errors - this is non-blocking
    logger.error({ error }, 'Error in sendToAnalyse');
  }
}
