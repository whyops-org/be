import { zValidator } from '@hono/zod-validator';
import { createServiceLogger } from '@whyops/shared/logger';
import { prefixedRedisKey, redisDeleteByPattern } from '@whyops/shared/services';
import { Hono } from 'hono';
import { z } from 'zod';
import { AgentSettingsService } from '../services/agent-settings.service';
import { UserRuntimePermissionsService } from '../services/user-runtime-permissions.service';

const logger = createServiceLogger('analyse:agent-settings-routes');
const app = new Hono();

const paramsSchema = z.object({
  id: z.string().uuid('Invalid agent id'),
});

const updateBodySchema = z
  .object({
    samplingRate: z.number().min(0).max(1).optional(),
    maxTraces: z.number().int().positive().optional(),
    maxSpans: z.number().int().positive().optional(),
  })
  .refine((value) => value.samplingRate !== undefined || value.maxTraces !== undefined || value.maxSpans !== undefined, {
    message: 'At least one settings field is required',
  });

async function invalidateEntitiesCachesForUser(userId: string): Promise<void> {
  await redisDeleteByPattern(prefixedRedisKey('analyse', 'entities', userId, '*'), 10_000);
}

// DELETE /api/agent-settings/:id (reset to defaults)
app.delete('/:id', zValidator('param', paramsSchema), async (c) => {
  const auth = c.get('whyopsAuth');

  if (!auth) {
    return c.json({ success: false, error: 'Unauthorized: authentication required' }, 401);
  }

  try {
    const { id } = c.req.valid('param');
    const permissions = await UserRuntimePermissionsService.getForUser(auth.userId);
    const settings = await AgentSettingsService.resetAgentSettings({
      userId: auth.userId,
      projectId: auth.projectId,
      environmentId: auth.environmentId,
      agentId: id,
      canChangeAgentMaxTraces: permissions.canChangeAgentMaxTraces,
      canChangeAgentMaxSpans: permissions.canChangeAgentMaxSpans,
    });

    if (!settings) {
      return c.json({ success: false, error: 'Agent not found' }, 404);
    }

    await invalidateEntitiesCachesForUser(auth.userId);

    return c.json({ success: true, settings }, 200);
  } catch (error: any) {
    logger.error({ error }, 'Failed to reset agent settings');
    return c.json({ success: false, error: 'Failed to reset agent settings' }, 500);
  }
});

// GET /api/agent-settings/limits
app.get('/limits', async (c) => {
  const auth = c.get('whyopsAuth');

  if (!auth) {
    return c.json({ success: false, error: 'Unauthorized: authentication required' }, 401);
  }

  const limits = AgentSettingsService.getGlobalRuntimeLimits();
  const permissions = await UserRuntimePermissionsService.getForUser(auth.userId);
  return c.json({ success: true, limits, permissions }, 200);
});

// GET /api/agent-settings/:id
app.get('/:id', zValidator('param', paramsSchema), async (c) => {
  const auth = c.get('whyopsAuth');

  if (!auth) {
    return c.json({ success: false, error: 'Unauthorized: authentication required' }, 401);
  }

  try {
    const { id } = c.req.valid('param');
    const settings = await AgentSettingsService.getAgentSettings({
      userId: auth.userId,
      projectId: auth.projectId,
      environmentId: auth.environmentId,
      agentId: id,
    });

    if (!settings) {
      return c.json({ success: false, error: 'Agent not found' }, 404);
    }

    return c.json({ success: true, settings }, 200);
  } catch (error: any) {
    logger.error({ error }, 'Failed to fetch agent settings');
    return c.json({ success: false, error: 'Failed to fetch agent settings' }, 500);
  }
});

// PATCH /api/agent-settings/:id
app.patch(
  '/:id',
  zValidator('param', paramsSchema),
  zValidator('json', updateBodySchema),
  async (c) => {
    const auth = c.get('whyopsAuth');

    if (!auth) {
      return c.json({ success: false, error: 'Unauthorized: authentication required' }, 401);
    }

    try {
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      const permissions = await UserRuntimePermissionsService.getForUser(auth.userId);

      const canChangeTraces = permissions.canChangeAgentMaxTraces;
      const canChangeSpans = permissions.canChangeAgentMaxSpans;

      const settings = await AgentSettingsService.updateAgentSettings({
        userId: auth.userId,
        projectId: auth.projectId,
        environmentId: auth.environmentId,
        agentId: id,
        samplingRate: body.samplingRate,
        maxTraces: canChangeTraces ? body.maxTraces : undefined,
        maxSpans: canChangeSpans ? body.maxSpans : undefined,
      });

      if (!settings) {
        return c.json({ success: false, error: 'Agent not found' }, 404);
      }

      await invalidateEntitiesCachesForUser(auth.userId);

      return c.json({ success: true, settings }, 200);
    } catch (error: any) {
      logger.error({ error }, 'Failed to update agent settings');
      return c.json({ success: false, error: 'Failed to update agent settings' }, 500);
    }
  }
);

export default app;
