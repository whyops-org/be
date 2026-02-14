import env from '@whyops/shared/env';
import { createServiceLogger } from '@whyops/shared/logger';
import { Hono } from 'hono';

const logger = createServiceLogger('proxy:agents');
const app = new Hono();

app.post('/agents/init', async (c) => {
  const auth = c.get('auth');

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  try {
    const response = await fetch(`${env.ANALYSE_URL}/api/entities/init`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${auth.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(env.PROXY_TIMEOUT_MS),
    });

    const contentType = response.headers.get('content-type') || 'application/json';
    const payloadText = await response.text();

    return new Response(payloadText, {
      status: response.status,
      headers: {
        'Content-Type': contentType,
      },
    });
  } catch (error: any) {
    logger.error({ error }, 'Failed to tunnel agent init request');
    return c.json({ error: 'Failed to initialize agent via proxy' }, 500);
  }
});

export default app;
