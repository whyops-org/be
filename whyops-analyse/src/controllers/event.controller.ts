import { createServiceLogger } from '@whyops/shared/logger';
import { Context } from 'hono';
import { EventData, EventService } from '../services';

const logger = createServiceLogger('analyse:event-controller');

export class EventController {
  /**
   * Create a new event or batch of events
   */
  static async createEvent(c: Context) {
    // Get data from parsed body (set by route after header merging)
    const data = (c.req as any).parsedData || await c.req.json();

    const ensureRequiredContext = (item: any) => {
      if (!item.userId || !item.projectId || !item.environmentId) {
        throw new Error('MISSING_AUTH_CONTEXT');
      }
    };

    try {
      if (Array.isArray(data)) {
        data.forEach(ensureRequiredContext);
        const results = await EventService.processBatchEvents(data);
        return c.json(results, 201);
      } else {
        ensureRequiredContext(data);
        const result = await EventService.processEvent(data as EventData);
        return c.json(result, 201);
      }
    } catch (error: any) {
      if (error?.message === 'MISSING_AUTH_CONTEXT') {
        return c.json({ error: 'Missing auth context. Provide API key or X-User-Id, X-Project-Id, X-Environment-Id headers.' }, 400);
      }

      if (error?.message === 'TRACE_AGENT_CONFLICT') {
        return c.json({ error: 'Trace is already bound to a different agent/version for this traceId' }, 409);
      }

      if (typeof error?.message === 'string' && error.message.includes('not initialized')) {
        return c.json({ error: error.message }, 400);
      }

      logger.error({ error, data }, 'Failed to save event(s)');
      return c.json({ error: 'Failed to save event(s)' }, 500);
    }
  }

  /**
   * List events with filters
   */
  static async listEvents(c: Context) {
    try {
      const traceId = c.req.query('traceId') || c.req.query('threadId');
      const userId = c.req.query('userId');
      const providerId = c.req.query('providerId');
      const limit = parseInt(c.req.query('limit') || '100');
      const offset = parseInt(c.req.query('offset') || '0');

      const result = await EventService.listEvents({
        traceId,
        userId,
        providerId,
        limit,
        offset,
      });

      return c.json(result);
    } catch (error: any) {
      logger.error({ error }, 'Failed to fetch events');
      return c.json({ error: 'Failed to fetch events' }, 500);
    }
  }

  /**
   * Get single event by ID
   */
  static async getEvent(c: Context) {
    try {
      const id = c.req.param('id');
      const event = await EventService.getEventById(id);

      if (!event) {
        return c.json({ error: 'Event not found' }, 404);
      }

      return c.json(event);
    } catch (error: any) {
      logger.error({ error }, 'Failed to fetch event');
      return c.json({ error: 'Failed to fetch event' }, 500);
    }
  }
}
