import type { ApiKeyAuthContext } from '@whyops/shared/middleware';
import type { Context, Next } from 'hono';
import { createServiceLogger } from '@whyops/shared/logger';
import { checkRedisFixedWindowRateLimit, prefixedRedisKey } from '@whyops/shared/services';
import env from '@whyops/shared/env';

const logger = createServiceLogger('proxy:ratelimit');

const rateLimitStore = new Map<string, { count: number; resetAt: number }>();

export async function rateLimitMiddleware(c: Context, next: Next) {
  const auth = c.get('whyopsAuth') as ApiKeyAuthContext | undefined;
  if (!auth || auth.authType !== 'api_key') {
    return await next();
  }

  const key = `ratelimit:${auth.apiKeyId}`;
  const now = Date.now();
  const windowMs = env.RATE_LIMIT_WINDOW_MS;
  const maxRequests = env.RATE_LIMIT_MAX_REQUESTS;

  const redisResult = await checkRedisFixedWindowRateLimit(
    prefixedRedisKey('ratelimit', auth.apiKeyId),
    maxRequests,
    windowMs
  );

  if (redisResult) {
    c.header('X-RateLimit-Limit', maxRequests.toString());
    c.header('X-RateLimit-Remaining', redisResult.remaining.toString());
    c.header('X-RateLimit-Reset', new Date(redisResult.resetAtEpochMs).toISOString());
    c.header('X-RateLimit-Backend', 'redis');

    if (!redisResult.allowed) {
      logger.warn(
        { apiKeyId: auth.apiKeyId, count: redisResult.count, source: redisResult.source },
        'Rate limit exceeded'
      );
      return c.json(
        {
          error: 'Rate limit exceeded',
          message: `Too many requests. Limit: ${maxRequests} requests per ${windowMs / 1000} seconds`,
          retryAfter: new Date(redisResult.resetAtEpochMs).toISOString(),
        },
        429
      );
    }

    await next();
    return;
  }

  let record = rateLimitStore.get(key);

  if (!record || now > record.resetAt) {
    // Create new window
    record = {
      count: 0,
      resetAt: now + windowMs,
    };
    rateLimitStore.set(key, record);
  }

  record.count++;

  // Set rate limit headers
  c.header('X-RateLimit-Limit', maxRequests.toString());
  c.header('X-RateLimit-Remaining', Math.max(0, maxRequests - record.count).toString());
  c.header('X-RateLimit-Reset', new Date(record.resetAt).toISOString());
  c.header('X-RateLimit-Backend', 'memory');

  if (record.count > maxRequests) {
    logger.warn(
      { apiKeyId: auth.apiKeyId, count: record.count },
      'Rate limit exceeded'
    );
    return c.json(
      {
        error: 'Rate limit exceeded',
        message: `Too many requests. Limit: ${maxRequests} requests per ${windowMs / 1000} seconds`,
        retryAfter: new Date(record.resetAt).toISOString(),
      },
      429
    );
  }

  await next();
}

// Cleanup old entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, record] of rateLimitStore.entries()) {
    if (now > record.resetAt + 300000) {
      // 5 minutes after reset
      rateLimitStore.delete(key);
    }
  }
}, 300000);
