import { zValidator } from '@hono/zod-validator';
import { createServiceLogger } from '@whyops/shared/logger';
import { Entity } from '@whyops/shared/models';
import { Hono } from 'hono';
import { z } from 'zod';
import { analyseAuthMiddleware } from '../middleware/auth';
import { EntityService } from '../services/entity.service';

const logger = createServiceLogger('analyse:entities');
const app = new Hono();

const entityInitSchema = z.object({
  agentName: z.string().min(1, 'Agent name is required').max(255),
  metadata: z.object({
    systemPrompt: z.string().min(1, 'metadata.systemPrompt is required'),
    tools: z.array(
      z.object({
        name: z.string().min(1, 'tool.name is required'),
        inputSchema: z.string().min(1, 'tool.inputSchema is required'),
        outputSchema: z.string().min(1, 'tool.outputSchema is required'),
        description: z.string().min(1, 'tool.description is required'),
      })
    ),
    description: z.string().optional(),
  }),
});

app.post('/init', analyseAuthMiddleware, zValidator('json', entityInitSchema), async (c) => {
  const data = c.req.valid('json');
  const auth = c.get('analyseAuth');

  if (!auth) {
    return c.json({ error: 'Unauthorized: valid API key required' }, 401);
  }

  try {
    const result = await EntityService.initAgentVersion({
      userId: auth.userId,
      projectId: auth.projectId,
      environmentId: auth.environmentId,
      agentName: data.agentName,
      metadata: data.metadata,
    });

    logger.info(
      { agentId: result.agentId, agentVersionId: result.agentVersionId, agentName: data.agentName, status: result.status },
      'Agent init completed'
    );

    return c.json(
      {
        agentId: result.agentId,
        agentVersionId: result.agentVersionId,
        status: result.status,
        versionHash: result.versionHash,
      },
      result.status === 'created' ? 201 : 200
    );

  } catch (error: any) {
    logger.error({ error, data }, 'Failed to init entity');
    return c.json({ error: 'Failed to initialize agent' }, 500);
  }
});

// GET /api/entities/:id
app.get('/:id', async (c) => {
    try {
        const id = c.req.param('id');
        const entity = await Entity.findByPk(id);
        if (!entity) return c.json({ error: 'Entity not found' }, 404);
        return c.json(entity);
    } catch (e) {
        return c.json({ error: 'Internal Error' }, 500);
    }
});

export default app;
