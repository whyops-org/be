import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';
import { ProviderController } from '../controllers';

const app = new Hono();

// Provider schema
const providerSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1),
  type: z.enum(['openai', 'anthropic']),
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  metadata: z.record(z.any()).optional(),
});

// Test provider schema
const testProviderSchema = z.object({
  type: z.enum(['openai', 'anthropic']),
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  model: z.string().min(1),
});

// GET /api/providers - List all providers for user
app.get('/', ProviderController.listProviders);

// POST /api/providers - Create new provider
app.post('/', zValidator('json', providerSchema), ProviderController.createProvider);

// POST /api/providers/test - Test provider connection
app.post('/test', zValidator('json', testProviderSchema), ProviderController.testProvider);

// GET /api/providers/:id - Get single provider
app.get('/:id', ProviderController.getProvider);

// PUT /api/providers/:id - Update provider
app.put('/:id', zValidator('json', providerSchema.partial()), ProviderController.updateProvider);

// DELETE /api/providers/:id - Delete provider
app.delete('/:id', ProviderController.deleteProvider);

// PATCH /api/providers/:id/toggle - Toggle provider active status
app.patch('/:id/toggle', ProviderController.toggleProvider);

export default app;
