import env from '../config/env';
import logger from '../utils/logger';
import { createClient, type RedisClientType } from 'redis';

type JsonRecord = Record<string, unknown>;

type AnyRedisClient = RedisClientType<any, any, any>;

let redisClient: AnyRedisClient | null = null;
let redisConnectPromise: Promise<AnyRedisClient | null> | null = null;

function isRedisConfigured(): boolean {
  return Boolean(env.REDIS_URL && env.REDIS_URL.trim().length > 0);
}

export async function getRedisClient(): Promise<AnyRedisClient | null> {
  if (!isRedisConfigured()) {
    return null;
  }

  if (redisClient?.isOpen) {
    return redisClient;
  }

  if (redisConnectPromise) {
    return redisConnectPromise;
  }

  redisConnectPromise = (async () => {
    try {
      const client = createClient({
        url: env.REDIS_URL,
      });

      client.on('error', (error) => {
        logger.error({ error }, 'Redis client error');
      });

      await client.connect();
      redisClient = client;
      logger.info('Redis connected');
      return redisClient;
    } catch (error) {
      logger.warn({ error }, 'Redis unavailable, falling back to non-Redis mode');
      redisClient = null;
      return null;
    } finally {
      redisConnectPromise = null;
    }
  })();

  return redisConnectPromise;
}

export function prefixedRedisKey(...parts: Array<string | number | undefined | null>): string {
  const values = parts
    .filter((part) => part !== undefined && part !== null && String(part).length > 0)
    .map((part) => String(part));

  return `${env.REDIS_KEY_PREFIX}:${values.join(':')}`;
}

export async function redisGetJson<T>(key: string): Promise<T | null> {
  const client = await getRedisClient();
  if (!client) return null;

  try {
    const value = await client.get(key);
    if (!value) return null;
    return JSON.parse(value) as T;
  } catch (error) {
    logger.warn({ error, key }, 'Failed to read Redis JSON key');
    return null;
  }
}

export async function redisSetJson(
  key: string,
  value: unknown,
  ttlSeconds?: number
): Promise<boolean> {
  const client = await getRedisClient();
  if (!client) return false;

  try {
    const payload = JSON.stringify(value);
    if (ttlSeconds && ttlSeconds > 0) {
      await client.set(key, payload, { EX: ttlSeconds });
    } else {
      await client.set(key, payload);
    }
    return true;
  } catch (error) {
    logger.warn({ error, key }, 'Failed to write Redis JSON key');
    return false;
  }
}

export async function redisDeleteKeys(...keys: string[]): Promise<number> {
  const client = await getRedisClient();
  if (!client || keys.length === 0) return 0;

  try {
    return await client.del(keys);
  } catch (error) {
    logger.warn({ error, keys }, 'Failed to delete Redis keys');
    return 0;
  }
}

export async function redisDeleteByPattern(pattern: string, limit = 1000): Promise<number> {
  const client = await getRedisClient();
  if (!client) return 0;

  let cursor = 0;
  let deleted = 0;

  try {
    do {
      const result = await client.scan(cursor, { MATCH: pattern, COUNT: 100 });
      cursor = result.cursor;
      const keys = result.keys.slice(0, limit - deleted);
      if (keys.length > 0) {
        deleted += await client.del(keys);
      }
      if (deleted >= limit) break;
    } while (cursor !== 0);

    return deleted;
  } catch (error) {
    logger.warn({ error, pattern }, 'Failed to delete Redis keys by pattern');
    return deleted;
  }
}

export async function claimRedisThrottleGate(key: string, ttlSeconds: number): Promise<boolean> {
  const client = await getRedisClient();
  if (!client) return true;

  try {
    const result = await client.set(key, '1', { EX: Math.max(1, ttlSeconds), NX: true });
    return result === 'OK';
  } catch (error) {
    logger.warn({ error, key }, 'Failed to claim Redis throttle gate');
    return true;
  }
}

export interface RedisRateLimitResult {
  source: 'redis' | 'memory';
  allowed: boolean;
  count: number;
  limit: number;
  remaining: number;
  resetAtEpochMs: number;
}

export async function checkRedisFixedWindowRateLimit(
  key: string,
  limit: number,
  windowMs: number
): Promise<RedisRateLimitResult | null> {
  const client = await getRedisClient();
  if (!client) return null;

  try {
    const nextCount = await client.incr(key);
    if (nextCount === 1) {
      await client.pExpire(key, windowMs);
    }

    let ttlMs = await client.pTTL(key);
    if (ttlMs < 0) ttlMs = windowMs;
    const resetAtEpochMs = Date.now() + ttlMs;

    return {
      source: 'redis',
      allowed: nextCount <= limit,
      count: nextCount,
      limit,
      remaining: Math.max(0, limit - nextCount),
      resetAtEpochMs,
    };
  } catch (error) {
    logger.warn({ error, key }, 'Failed Redis rate limit check');
    return null;
  }
}

export interface EnqueueStreamOptions {
  maxLen?: number;
}

export async function enqueueRedisStreamEvent(
  stream: string,
  payload: JsonRecord,
  options?: EnqueueStreamOptions
): Promise<{ queued: boolean; messageId?: string }> {
  const client = await getRedisClient();
  if (!client) return { queued: false };

  try {
    const messageId = await client.xAdd(
      stream,
      '*',
      {
        payload: JSON.stringify(payload),
      },
      options?.maxLen
        ? {
            TRIM: {
              strategy: 'MAXLEN',
              strategyModifier: '~',
              threshold: options.maxLen,
            },
          }
        : undefined
    );

    return { queued: true, messageId };
  } catch (error) {
    logger.warn({ error, stream }, 'Failed to enqueue Redis stream event');
    return { queued: false };
  }
}

export async function ensureRedisConsumerGroup(stream: string, group: string): Promise<boolean> {
  const client = await getRedisClient();
  if (!client) return false;

  try {
    await client.xGroupCreate(stream, group, '0', { MKSTREAM: true });
    return true;
  } catch (error: any) {
    const message = String(error?.message || '');
    if (message.includes('BUSYGROUP')) {
      return true;
    }
    logger.warn({ error, stream, group }, 'Failed to ensure Redis consumer group');
    return false;
  }
}

export interface RedisStreamMessage<T> {
  id: string;
  payload: T;
}

export async function readRedisStreamGroup<T = JsonRecord>(
  stream: string,
  group: string,
  consumer: string,
  count: number,
  blockMs: number
): Promise<Array<RedisStreamMessage<T>>> {
  const client = await getRedisClient();
  if (!client) return [];

  try {
    const rows = await client.xReadGroup(
      group,
      consumer,
      { key: stream, id: '>' },
      { COUNT: count, BLOCK: blockMs }
    );

    if (!rows || rows.length === 0) return [];

    const result: Array<RedisStreamMessage<T>> = [];
    for (const row of rows) {
      for (const message of row.messages) {
        const payloadRaw = message.message.payload;
        if (!payloadRaw) continue;
        try {
          result.push({
            id: message.id,
            payload: JSON.parse(payloadRaw) as T,
          });
        } catch (error) {
          logger.warn({ error, messageId: message.id }, 'Failed to parse Redis stream payload');
        }
      }
    }
    return result;
  } catch (error) {
    logger.warn({ error, stream, group, consumer }, 'Failed to read Redis stream group');
    return [];
  }
}

export async function ackRedisStreamMessage(
  stream: string,
  group: string,
  messageId: string
): Promise<boolean> {
  const client = await getRedisClient();
  if (!client) return false;

  try {
    await client.xAck(stream, group, messageId);
    return true;
  } catch (error) {
    logger.warn({ error, stream, group, messageId }, 'Failed to ack Redis stream message');
    return false;
  }
}

export interface ApiKeyAuthCachePayload {
  cacheVersion: 1;
  apiKeyId: string;
  keyHash: string;
  expiresAt?: string | null;
  context: Record<string, unknown>;
}

export function getApiKeyAuthCacheKey(keyHash: string): string {
  return prefixedRedisKey('auth', 'apikey', 'hash', keyHash);
}

export function getApiKeyAuthMappingKey(apiKeyId: string): string {
  return prefixedRedisKey('auth', 'apikey', 'id', apiKeyId);
}

export async function cacheApiKeyAuthContext(payload: ApiKeyAuthCachePayload): Promise<void> {
  await redisSetJson(getApiKeyAuthCacheKey(payload.keyHash), payload, env.AUTH_APIKEY_CACHE_TTL_SEC);
  await redisSetJson(
    getApiKeyAuthMappingKey(payload.apiKeyId),
    { keyHash: payload.keyHash },
    env.AUTH_APIKEY_CACHE_TTL_SEC
  );
}

export async function getCachedApiKeyAuthContext(
  keyHash: string
): Promise<ApiKeyAuthCachePayload | null> {
  return redisGetJson<ApiKeyAuthCachePayload>(getApiKeyAuthCacheKey(keyHash));
}

export async function invalidateApiKeyAuthCacheById(apiKeyId: string): Promise<void> {
  const mapping = await redisGetJson<{ keyHash?: string }>(getApiKeyAuthMappingKey(apiKeyId));
  if (mapping?.keyHash) {
    await redisDeleteKeys(getApiKeyAuthCacheKey(mapping.keyHash));
  }
  await redisDeleteKeys(getApiKeyAuthMappingKey(apiKeyId));
}

export async function invalidateApiKeyAuthCacheByHash(keyHash: string): Promise<void> {
  await redisDeleteKeys(getApiKeyAuthCacheKey(keyHash));
}

export function getProviderCacheKey(userId: string, providerSlug: string): string {
  return prefixedRedisKey('provider', userId, providerSlug);
}

export interface CachedProviderLookup<T> {
  hit: boolean;
  provider: T | null;
}

export async function getCachedProvider<T>(userId: string, providerSlug: string): Promise<CachedProviderLookup<T>> {
  const raw = await redisGetJson<any>(getProviderCacheKey(userId, providerSlug));
  if (raw === null) {
    return { hit: false, provider: null };
  }

  if (raw && typeof raw === 'object' && raw.__whyopsCachedNull === true) {
    return { hit: true, provider: null };
  }

  return { hit: true, provider: raw as T };
}

export async function cacheProvider<T>(userId: string, providerSlug: string, provider: T | null): Promise<void> {
  await redisSetJson(
    getProviderCacheKey(userId, providerSlug),
    provider === null ? { __whyopsCachedNull: true } : provider,
    env.PROVIDER_CACHE_TTL_SEC
  );
}

export async function invalidateProviderCacheForUser(userId: string): Promise<void> {
  await redisDeleteByPattern(prefixedRedisKey('provider', userId, '*'));
}
