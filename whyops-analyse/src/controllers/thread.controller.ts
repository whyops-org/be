import { createServiceLogger } from '@whyops/shared/logger';
import { Context } from 'hono';
import { ThreadService } from '../services/thread.service';
import { parseInclude } from '../utils/query';

const logger = createServiceLogger('analyse:thread-controller');

export class ThreadController {
  /**
   * List all threads
   */
  static async listThreads(c: Context) {
    try {
      const auth = c.get('whyopsAuth');
      if (!auth) {
        return c.json({ success: false, error: 'Unauthorized: authentication required' }, 401);
      }

      const count = Math.min(Math.max(parseInt(c.req.query('count') || '20', 10) || 20, 1), 100);
      const page = Math.max(parseInt(c.req.query('page') || '1', 10) || 1, 1);
      const agentName = c.req.query('agentName')?.trim() || undefined;
      const include = parseInclude(c.req.query('include'));
      const startDateParam = c.req.query('startDate');
      const endDateParam = c.req.query('endDate');

      const startDate = startDateParam ? new Date(startDateParam) : undefined;
      if (startDateParam && Number.isNaN(startDate!.getTime())) {
        return c.json({ success: false, error: 'Invalid startDate' }, 400);
      }
      const endDate = endDateParam ? new Date(endDateParam) : undefined;
      if (endDateParam && Number.isNaN(endDate!.getTime())) {
        return c.json({ success: false, error: 'Invalid endDate' }, 400);
      }

      const result = await ThreadService.listThreads({
        userId: auth.userId,
        agentName,
        page,
        count,
        includeSystemPrompt: include.has('systemPrompt'),
        includeTools: include.has('tools'),
        includeMetadata: include.has('metadata'),
        startDate,
        endDate,
      });

      return c.json({
        success: true,
        ...result,
      });
    } catch (error: any) {
      logger.error({ error }, 'Failed to list threads');
      return c.json({ success: false, error: 'Failed to list threads' }, 500);
    }
  }

  /**
   * Get complete thread details
   */
  static async getThreadDetail(c: Context) {
    try {
      const auth = c.get('whyopsAuth');
      if (!auth) {
        return c.json({ success: false, error: 'Unauthorized: authentication required' }, 401);
      }

      const threadId = c.req.param('threadId');
      if (!threadId) {
        return c.json({ success: false, error: 'Missing route parameter: threadId' }, 400);
      }
      const include = parseInclude(c.req.query('include'));
      const eventInclude = parseInclude(c.req.query('eventInclude'));
      const eventLimit = Math.min(Math.max(parseInt(c.req.query('eventLimit') || '200', 10) || 200, 1), 1000);
      const eventOffset = Math.max(parseInt(c.req.query('eventOffset') || '0', 10) || 0, 0);

      const thread = await ThreadService.getThreadDetail(threadId, auth.userId, {
        includeSystemPrompt: include.has('systemPrompt'),
        includeTools: include.has('tools'),
        includeMetadata: include.has('metadata'),
        eventIncludeContent: eventInclude.has('content'),
        eventIncludeMetadata: eventInclude.has('metadata'),
        eventLimit,
        eventOffset,
      });

      if (!thread) {
        return c.json({ success: false, error: 'Thread not found' }, 404);
      }

      if (thread.sampledIn === false) {
        return c.json({
          success: true,
          sampledOut: true,
          sampledIn: false,
          ...thread,
        });
      }

      return c.json({
        success: true,
        sampledOut: false,
        sampledIn: thread.sampledIn,
        ...thread,
      });
    } catch (error: any) {
      logger.error({ error }, 'Failed to get thread detail');
      return c.json({ success: false, error: 'Failed to get thread detail' }, 500);
    }
  }

  /**
   * Get thread decision graph
   */
  static async getThreadGraph(c: Context) {
    try {
      const threadId = c.req.param('threadId');
      if (!threadId) {
        return c.json({ error: 'Missing route parameter: threadId' }, 400);
      }
      const startDateParam = c.req.query('startDate');
      const endDateParam = c.req.query('endDate');

      const startDate = startDateParam ? new Date(startDateParam) : undefined;
      if (startDateParam && Number.isNaN(startDate!.getTime())) {
        return c.json({ error: 'Invalid startDate' }, 400);
      }
      const endDate = endDateParam ? new Date(endDateParam) : undefined;
      if (endDateParam && Number.isNaN(endDate!.getTime())) {
        return c.json({ error: 'Invalid endDate' }, 400);
      }

      const graph = await ThreadService.getThreadGraph(threadId, { startDate, endDate });

      if (!graph) {
        return c.json({ error: 'Thread not found' }, 404);
      }

      return c.json({
        threadId,
        graph,
      });
    } catch (error: any) {
      logger.error({ error }, 'Failed to build thread graph');
      return c.json({ error: 'Failed to build thread graph' }, 500);
    }
  }

  /**
   * Match messages to existing thread
   */
  static async matchThread(c: Context) {
    try {
      const auth = c.get('whyopsAuth');
      if (!auth) {
        return c.json({ error: 'Unauthorized: authentication required' }, 401);
      }

      const { messages, providerId } = await c.req.json();
      const result = await ThreadService.matchThread(auth.userId, messages, providerId);
      return c.json(result);
    } catch (error: any) {
      logger.error({ error }, 'Failed to match thread');
      return c.json({ error: 'Failed to match thread' }, 500);
    }
  }
}
