import env from '@whyops/shared/env';
import { createServiceLogger } from '@whyops/shared/logger';

const logger = createServiceLogger('proxy:analyse');

interface TraceEventPayload {
  traceId: string;
  spanId?: string;
  stepId?: number; // Optional, can be resolved by analyse
  parentStepId?: number; // Optional
  eventType: 'user_message' | 'llm_response' | 'tool_call' | 'tool_call_request' | 'tool_call_response' | 'error';
  userId: string;
  providerId: string;
  timestamp?: string;
  content: any;
  metadata?: Record<string, any>;
}

/**
 * Send trace event data to the analyse service (non-blocking)
 * This is fire-and-forget to ensure zero latency impact on proxy
 */
export async function sendToAnalyse(payload: TraceEventPayload): Promise<void> {
  try {
    const analyseUrl = `${env.ANALYSE_URL}/api/events`;
    
    // Fire-and-forget request
    fetch(analyseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service': 'proxy',
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
