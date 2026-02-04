import { createServiceLogger } from '@whyops/shared/logger';
import { Context } from 'hono';
import { ThreadService } from '../services/thread.service';

const logger = createServiceLogger('analyse:thread-controller');

export class ThreadController {
  /**
   * List all threads
   */
  static async listThreads(c: Context) {
    try {
      const userId = c.req.query('userId');
      const limit = parseInt(c.req.query('limit') || '50');
      const offset = parseInt(c.req.query('offset') || '0');

      const result = await ThreadService.listThreads({ userId, limit, offset });
      return c.json(result);
    } catch (error: any) {
      logger.error({ error }, 'Failed to list threads');
      return c.json({ error: 'Failed to list threads' }, 500);
    }
  }

  /**
   * Get complete thread details
   */
  static async getThreadDetail(c: Context) {
    try {
      const threadId = c.req.param('threadId');
      const thread = await ThreadService.getThreadDetail(threadId);

      if (!thread) {
        return c.json({ error: 'Thread not found' }, 404);
      }

      return c.json(thread);
    } catch (error: any) {
      logger.error({ error }, 'Failed to get thread detail');
      return c.json({ error: 'Failed to get thread detail' }, 500);
    }
  }

  /**
   * Get thread decision graph
   */
  static async getThreadGraph(c: Context) {
    try {
      const threadId = c.req.param('threadId');
      const graph = await ThreadService.getThreadGraph(threadId);

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
      const { messages, providerId } = await c.req.json();
      const result = await ThreadService.matchThread(messages, providerId);
      return c.json(result);
    } catch (error: any) {
      logger.error({ error }, 'Failed to match thread');
      return c.json({ error: 'Failed to match thread' }, 500);
    }
  }
}
