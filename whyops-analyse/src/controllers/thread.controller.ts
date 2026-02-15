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
      const auth = c.get('analyseAuth');
      if (!auth) {
        return c.json({ success: false, error: 'Unauthorized: authentication required' }, 401);
      }

      const count = Math.min(Math.max(parseInt(c.req.query('count') || '20', 10) || 20, 1), 100);
      const page = Math.max(parseInt(c.req.query('page') || '1', 10) || 1, 1);
      const agentName = c.req.query('agentName')?.trim() || undefined;

      const result = await ThreadService.listThreads({
        userId: auth.userId,
        agentName,
        page,
        count,
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
      const auth = c.get('analyseAuth');
      if (!auth) {
        return c.json({ success: false, error: 'Unauthorized: authentication required' }, 401);
      }

      const threadId = c.req.param('threadId');
      const thread = await ThreadService.getThreadDetail(threadId, auth.userId);

      if (!thread) {
        return c.json({ success: false, error: 'Thread not found' }, 404);
      }

      return c.json({
        success: true,
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
