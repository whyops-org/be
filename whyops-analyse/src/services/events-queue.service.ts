import env from '@whyops/shared/env';
import { createServiceLogger } from '@whyops/shared/logger';
import type { ApiKeyAuthContext, UnifiedAuthContext } from '@whyops/shared/middleware';
import { validateApiKey } from '@whyops/shared/middleware';
import {
  ackRedisStreamMessage,
  enqueueRedisStreamEvent,
  ensureRedisConsumerGroup,
  readRedisStreamGroup,
} from '@whyops/shared/services';
import { EventService, type EventData } from './event.service';

const logger = createServiceLogger('analyse:events-queue');

interface QueuedEventEnvelope {
  apiKey?: string;
  payload: Record<string, unknown>;
  source?: string;
  retryCount?: number;
  enqueuedAt?: string;
  lastError?: string;
}

function toEventData(
  payload: Record<string, unknown>,
  auth?: UnifiedAuthContext
): EventData {
  const eventType = payload.eventType as EventData['eventType'];
  const traceId = String(payload.traceId || '');
  const agentName = String(payload.agentName || payload.entityName || '');

  if (!traceId || !agentName || !eventType) {
    throw new Error('INVALID_EVENT_PAYLOAD');
  }

  return {
    ...(payload as unknown as Partial<EventData>),
    eventType,
    traceId,
    agentName,
    userId: String(payload.userId || auth?.userId || ''),
    projectId: String(payload.projectId || auth?.projectId || ''),
    environmentId: String(payload.environmentId || auth?.environmentId || ''),
    providerId: String(payload.providerId || auth?.providerId || '') || undefined,
  };
}

async function processQueuedEnvelope(envelope: QueuedEventEnvelope): Promise<void> {
  let authContext: UnifiedAuthContext | undefined;

  if (envelope.apiKey) {
    const authResult = await validateApiKey(envelope.apiKey);
    if (!authResult.valid || !authResult.context) {
      throw new Error(`AUTH_FAILED:${authResult.error || 'Invalid API key'}`);
    }
    authContext = authResult.context;
  }

  const event = toEventData(envelope.payload, authContext);
  await EventService.processEvent(event);
}

async function handleMessage(
  messageId: string,
  envelope: QueuedEventEnvelope,
  consumer: string
): Promise<void> {
  try {
    await processQueuedEnvelope(envelope);
    await ackRedisStreamMessage(env.EVENTS_STREAM_NAME, env.EVENTS_STREAM_GROUP, messageId);
  } catch (error: any) {
    const retryCount = (envelope.retryCount || 0) + 1;
    const shouldDeadLetter = retryCount > env.EVENTS_STREAM_RETRY_MAX;

    const destinationStream = shouldDeadLetter
      ? env.EVENTS_DLQ_STREAM_NAME
      : env.EVENTS_STREAM_NAME;

    const nextEnvelope: QueuedEventEnvelope = {
      ...envelope,
      retryCount,
      lastError: error?.message || String(error),
    };

    const requeued = await enqueueRedisStreamEvent(
      destinationStream,
      nextEnvelope as unknown as Record<string, unknown>,
      { maxLen: env.EVENTS_STREAM_MAX_LEN }
    );

    if (requeued.queued) {
      await ackRedisStreamMessage(env.EVENTS_STREAM_NAME, env.EVENTS_STREAM_GROUP, messageId);
      logger.warn(
        {
          messageId,
          retryCount,
          destinationStream,
          consumer,
          errorMessage: error?.message || String(error),
        },
        shouldDeadLetter ? 'Event moved to DLQ' : 'Event re-queued for retry'
      );
      return;
    }

    logger.error(
      {
        messageId,
        retryCount,
        consumer,
        errorMessage: error?.message || String(error),
      },
      'Failed to re-queue event after processing failure'
    );
  }
}

export async function enqueueAnalyseEventPayload(
  payload: Record<string, unknown>,
  auth: UnifiedAuthContext
): Promise<boolean> {
  const envelope: QueuedEventEnvelope = {
    payload: {
      ...payload,
      userId: payload.userId || auth.userId,
      projectId: payload.projectId || auth.projectId,
      environmentId: payload.environmentId || auth.environmentId,
      providerId: payload.providerId || auth.providerId,
      agentName: payload.agentName || payload.entityName,
    },
    source: 'analyse-http',
    retryCount: 0,
    enqueuedAt: new Date().toISOString(),
  };

  if ((auth as ApiKeyAuthContext).authType === 'api_key') {
    envelope.apiKey = (auth as ApiKeyAuthContext).apiKey;
  }

  const queued = await enqueueRedisStreamEvent(
    env.EVENTS_STREAM_NAME,
    envelope as unknown as Record<string, unknown>,
    { maxLen: env.EVENTS_STREAM_MAX_LEN }
  );

  return queued.queued;
}

export async function startAnalyseEventsWorker(): Promise<void> {
  if (!env.EVENTS_WORKER_ENABLED) {
    logger.info('Analyse events worker disabled by configuration');
    return;
  }

  const groupReady = await ensureRedisConsumerGroup(
    env.EVENTS_STREAM_NAME,
    env.EVENTS_STREAM_GROUP
  );

  if (!groupReady) {
    logger.warn('Analyse events worker not started (Redis group unavailable)');
    return;
  }

  const consumer = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

  logger.info(
    {
      stream: env.EVENTS_STREAM_NAME,
      group: env.EVENTS_STREAM_GROUP,
      consumer,
      batchSize: env.EVENTS_STREAM_BATCH_SIZE,
      blockMs: env.EVENTS_STREAM_BLOCK_MS,
      retryMax: env.EVENTS_STREAM_RETRY_MAX,
    },
    'Analyse events worker started'
  );

  const loop = async () => {
    while (true) {
      try {
        const messages = await readRedisStreamGroup<QueuedEventEnvelope>(
          env.EVENTS_STREAM_NAME,
          env.EVENTS_STREAM_GROUP,
          consumer,
          env.EVENTS_STREAM_BATCH_SIZE,
          env.EVENTS_STREAM_BLOCK_MS
        );

        if (messages.length === 0) {
          continue;
        }

        await Promise.all(
          messages.map((message) =>
            handleMessage(message.id, message.payload, consumer)
          )
        );
      } catch (error) {
        logger.error({ error, consumer }, 'Analyse events worker loop error');
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  };

  void loop();
}
