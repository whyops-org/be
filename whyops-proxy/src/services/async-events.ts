import { createServiceLogger } from '@whyops/shared/logger';
import { sendToAnalyse, type TraceEventPayload } from './analyse';

const logger = createServiceLogger('proxy:async-events');

export function dispatchAnalyseEvent(apiKey: string, payload: TraceEventPayload): void {
  queueMicrotask(() => {
    sendToAnalyse(apiKey, payload).catch((error) => {
      logger.error(
        { error, traceId: payload.traceId, eventType: payload.eventType },
        'Failed to dispatch analyse event'
      );
    });
  });
}
