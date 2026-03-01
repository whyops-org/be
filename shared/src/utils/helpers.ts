import crypto from 'crypto';
import { nanoid } from 'nanoid';

/**
 * Generate a secure API key with prefix
 * Supports both underscore (whyops_xxx) and hyphen (YOPS-xxx) separators
 */
export function generateApiKey(prefix: string = 'whyops'): string {
  const randomPart = nanoid(32);
  // Use hyphen if prefix ends with hyphen, otherwise use underscore
  const separator = prefix.endsWith('-') ? '' : '_';
  return `${prefix}${separator}${randomPart}`;
}

/**
 * Hash API key for storage
 */
export function hashApiKey(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey).digest('hex');
}

/**
 * Generate a thread ID
 */
export function generateThreadId(): string {
  return `thread_${nanoid(16)}`;
}

/**
 * Generate a span ID
 */
export function generateSpanId(): string {
  return `span_${nanoid(16)}`;
}

/**
 * Validate API key format
 */
export function validateApiKeyFormat(apiKey: string, prefix: string = 'whyops'): boolean {
  // Support both underscore and hyphen separators
  const escapedPrefix = prefix.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
  const regex = new RegExp(`^${escapedPrefix}[_-][A-Za-z0-9_-]{32}$`);
  return regex.test(apiKey);
}

/**
 * Redact sensitive data from objects
 */
export function redactSensitive<T extends Record<string, any>>(
  obj: T,
  fieldsToRedact: string[] = ['password', 'apiKey', 'api_key', 'secret', 'token']
): T {
  const redacted = { ...obj };
  
  for (const key in redacted) {
    if (fieldsToRedact.some(field => key.toLowerCase().includes(field.toLowerCase()))) {
      redacted[key] = '[REDACTED]' as T[Extract<keyof T, string>];
    } else if (typeof redacted[key] === 'object' && redacted[key] !== null) {
      redacted[key] = redactSensitive(redacted[key], fieldsToRedact);
    }
  }
  
  return redacted;
}

/**
 * Parse database URL to connection config
 */
export function parseDatabaseUrl(url: string) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parseInt(parsed.port) || 5432,
    database: parsed.pathname.slice(1),
    username: parsed.username,
    password: parsed.password,
  };
}

const LOCAL_DB_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function isLocalDbHost(host?: string): boolean {
  if (!host) return true;
  return LOCAL_DB_HOSTS.has(host.toLowerCase());
}

function parseSslMode(databaseUrl?: string): string | undefined {
  if (!databaseUrl) return undefined;
  try {
    const parsed = new URL(databaseUrl);
    return parsed.searchParams.get('sslmode')?.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

export function shouldUseDbSsl(params: {
  databaseUrl?: string;
  dbHost?: string;
  explicitSsl?: boolean;
}): boolean {
  const { databaseUrl, dbHost, explicitSsl } = params;

  if (typeof explicitSsl === 'boolean') {
    return explicitSsl;
  }

  const sslMode = parseSslMode(databaseUrl);
  if (sslMode === 'disable') return false;
  if (sslMode === 'require' || sslMode === 'verify-ca' || sslMode === 'verify-full') {
    return true;
  }

  let host = dbHost;
  if (!host && databaseUrl) {
    try {
      host = new URL(databaseUrl).hostname;
    } catch {
      host = undefined;
    }
  }

  return !isLocalDbHost(host);
}

export function buildPgSslConfig(params: {
  databaseUrl?: string;
  dbHost?: string;
  explicitSsl?: boolean;
  rejectUnauthorized?: boolean;
}): false | { rejectUnauthorized: boolean } {
  const enabled = shouldUseDbSsl({
    databaseUrl: params.databaseUrl,
    dbHost: params.dbHost,
    explicitSsl: params.explicitSsl,
  });

  if (!enabled) {
    return false;
  }

  return {
    rejectUnauthorized: params.rejectUnauthorized ?? false,
  };
}
