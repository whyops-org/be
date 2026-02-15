import { zValidator } from '@hono/zod-validator';
import { createServiceLogger } from '@whyops/shared/logger';
import { Hono } from 'hono';
import { z } from 'zod';
import { EventController } from '../controllers';

const logger = createServiceLogger('analyse:events-routes');
const app = new Hono();

// Validation schemas - userId, projectId, environmentId are optional (extracted from headers)
const eventSchema = z.object({
  eventType: z.enum(['user_message', 'llm_response', 'tool_call', 'tool_call_request', 'tool_call_response', 'error'], {
    errorMap: () => ({ message: "Invalid event type. Must be one of: 'user_message', 'llm_response', 'tool_call', 'tool_call_request', 'tool_call_response', 'error'" }),
  }),
  traceId: z.string().min(1).max(128, "Trace ID must be between 1 and 128 characters"),
  spanId: z.string().max(128, "Span ID must be at most 128 characters").optional(),
  stepId: z.number().int().min(1, "Step ID must be a positive integer").optional(),
  parentStepId: z.number().int().min(1, "Parent Step ID must be a positive integer").optional(),
  // These are optional - will be extracted from headers/API key if not provided
  userId: z.string().uuid("Invalid User ID format (UUID required)").optional(),
  projectId: z.string().uuid("Invalid Project ID format (UUID required)").optional(),
  environmentId: z.string().uuid("Invalid Environment ID format (UUID required)").optional(),
  providerId: z.string().uuid("Invalid Provider ID format (UUID required)").optional(),
  agentName: z.string().min(1, 'agentName is required').max(255),
  timestamp: z.string().datetime({ message: "Invalid timestamp format (ISO 8601 required)" }).optional(),
  content: z.any().optional(),
  metadata: z.record(z.any()).optional(),
  idempotencyKey: z.string().max(128, "Idempotency Key must be at most 128 characters").optional(),
});

const batchEventSchema = z.union([eventSchema, z.array(eventSchema)]);

// Schema for tool result endpoint (eventType is automatic)
const toolResultSchema = z.object({
  traceId: z.string().min(1).max(128, "Trace ID must be between 1 and 128 characters"),
  spanId: z.string().max(128, "Span ID must be at most 128 characters").optional(),
  stepId: z.number().int().min(1, "Step ID must be a positive integer").optional(),
  parentStepId: z.number().int().min(1, "Parent Step ID must be a positive integer").optional(),
  userId: z.string().uuid("Invalid User ID format (UUID required)").optional(),
  projectId: z.string().uuid("Invalid Project ID format (UUID required)").optional(),
  environmentId: z.string().uuid("Invalid Environment ID format (UUID required)").optional(),
  providerId: z.string().uuid("Invalid Provider ID format (UUID required)").optional(),
  agentName: z.string().min(1, 'agentName is required').max(255),
  timestamp: z.string().datetime({ message: "Invalid timestamp format (ISO 8601 required)" }).optional(),
  content: z.any().optional(),
  metadata: z.record(z.any()).optional(),
  idempotencyKey: z.string().max(128, "Idempotency Key must be at most 128 characters").optional(),
});

const batchToolResultSchema = z.union([toolResultSchema, z.array(toolResultSchema)]);

// Helper to process data and extract auth info
function processEventData(
  data: any,
  auth: any,
  headers: { userId?: string; projectId?: string; environmentId?: string; providerId?: string }
) {
  const processItem = (item: any) => ({
    ...item,
    agentName: item.agentName || item.entityName,
    userId: item.userId || auth?.userId || headers.userId,
    projectId: item.projectId || auth?.projectId || headers.projectId,
    environmentId: item.environmentId || auth?.environmentId || headers.environmentId,
    providerId: item.providerId || auth?.providerId || headers.providerId,
  });

  return Array.isArray(data) ? data.map(processItem) : processItem(data);
}

// POST /api/events/tool-result - Create tool call response event(s) with automatic eventType
app.post(
  '/tool-result',
  zValidator('json', batchToolResultSchema, (result, c) => {
    if (!result.success) {
      const errors = result.error.errors.map((e) => ({
        field: e.path.join('.'),
        message: e.message,
        code: e.code,
      }));
      logger.warn({ errors }, 'Tool result validation failed');
      return c.json({ error: 'Validation failed', details: errors }, 400);
    }
  }),
  async (c) => {
    const data = await c.req.json();
    const auth = c.get('analyseAuth');

    // Extract auth info from headers or auth middleware
    const headers = {
      userId: c.req.header('X-User-Id'),
      projectId: c.req.header('X-Project-Id'),
      environmentId: c.req.header('X-Environment-Id'),
      providerId: c.req.header('X-Provider-Id'),
    };

    const processedData = processEventData(data, auth, headers);
    const withEventType = Array.isArray(processedData)
      ? processedData.map((item: any) => ({ ...item, eventType: 'tool_call_response' as const }))
      : { ...processedData, eventType: 'tool_call_response' as const };

    // Set req.json to return processed data
    (c as any).req.parsedData = withEventType;

    return EventController.createEvent(c);
  }
);

// POST /api/events - Create a new event (or batch of events)
app.post(
  '/',
  zValidator('json', batchEventSchema, (result, c) => {
    if (!result.success) {
      const errors = result.error.errors.map((e) => ({
        field: e.path.join('.'),
        message: e.message,
        code: e.code,
      }));
      logger.warn({ errors }, 'Event validation failed');
      return c.json({ error: 'Validation failed', details: errors }, 400);
    }
  }),
  async (c) => {
    const data = await c.req.json();
    const auth = c.get('analyseAuth');

    // Extract auth info from headers or auth middleware
    const headers = {
      userId: c.req.header('X-User-Id'),
      projectId: c.req.header('X-Project-Id'),
      environmentId: c.req.header('X-Environment-Id'),
      providerId: c.req.header('X-Provider-Id'),
    };

    const processedData = processEventData(data, auth, headers);

    // Override req.json to return processed data
    (c as any).req.parsedData = processedData;

    return EventController.createEvent(c);
  }
);

// GET /api/events - List events (with filters)
app.get('/', EventController.listEvents);

// GET /api/events/:id - Get single event
app.get('/:id', EventController.getEvent);

export default app;
