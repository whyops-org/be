import { createServiceLogger } from '@whyops/shared/logger';
import { Provider } from '@whyops/shared/models';
import { cacheProvider, getCachedProvider } from '@whyops/shared/services';
import { decrypt } from '@whyops/shared/utils';

const logger = createServiceLogger('proxy:routing');

function isLikelyHeaderSafe(value: string): boolean {
  if (!value || typeof value !== 'string') return false;
  for (let index = 0; index < value.length; index += 1) {
    const charCode = value.charCodeAt(index);
    if (charCode < 32 || charCode > 126) {
      return false;
    }
  }
  return true;
}

function normalizeProviderApiKey(apiKey: unknown): string {
  const rawApiKey = String(apiKey || '');

  if (!rawApiKey) {
    return rawApiKey;
  }

  try {
    const decryptedApiKey = decrypt(rawApiKey);

    if (isLikelyHeaderSafe(decryptedApiKey) && decryptedApiKey.length >= 8) {
      return decryptedApiKey;
    }
  } catch {
    // Fall back to raw key below
  }

  return rawApiKey;
}

function normalizeProvider(provider: any): any {
  if (!provider) {
    return provider;
  }

  const plainProvider = typeof provider.toJSON === 'function' ? provider.toJSON() : provider;

  return {
    ...plainProvider,
    apiKey: normalizeProviderApiKey(plainProvider.apiKey),
  };
}

export interface ResolvedProvider {
  provider: any;
  isCustom: boolean;
  providerSlug: string | null;
  actualModel: string;
}

export function validateResolvedProvider(provider: any): { valid: boolean; message?: string } {
  if (!provider) {
    return {
      valid: false,
      message: 'No provider configured for this API key. Add a provider or use a provider-slug/model format.',
    };
  }

  if (!provider.baseUrl) {
    return {
      valid: false,
      message: 'Configured provider is missing baseUrl.',
    };
  }

  if (!provider.apiKey) {
    return {
      valid: false,
      message: 'Configured provider is missing apiKey.',
    };
  }

  return { valid: true };
}

export function parseModelField(model: string): { providerSlug: string | null; actualModel: string } {
  if (!model || !model.includes('/')) {
    return { providerSlug: null, actualModel: model };
  }

  const parts = model.split('/');
  return { providerSlug: parts[0], actualModel: parts.slice(1).join('/') };
}

export async function getProviderBySlugOrDefault(
  userId: string,
  providerSlug: string | null,
  defaultProvider: any
): Promise<{ provider: any; isCustom: boolean }> {
  if (!providerSlug) {
    return { provider: normalizeProvider(defaultProvider), isCustom: false };
  }

  const cachedProvider = await getCachedProvider<any>(userId, providerSlug);
  if (cachedProvider.hit) {
    if (cachedProvider.provider) {
      return {
        provider: normalizeProvider(cachedProvider.provider),
        isCustom: true,
      };
    }
    return { provider: normalizeProvider(defaultProvider), isCustom: false };
  }

  const provider = await Provider.findOne({
    where: {
      userId,
      slug: providerSlug,
      isActive: true,
    },
  });

  if (provider) {
    await cacheProvider(userId, providerSlug, provider.toJSON());
    return {
      provider: normalizeProvider(provider),
      isCustom: true,
    };
  }

  logger.warn({ providerSlug }, 'Provider slug not found, using default');
  await cacheProvider(userId, providerSlug, null);
  return { provider: normalizeProvider(defaultProvider), isCustom: false };
}

export async function resolveProviderFromModel(
  userId: string,
  model: string,
  defaultProvider: any
): Promise<ResolvedProvider> {
  const { providerSlug, actualModel } = parseModelField(model);
  const { provider, isCustom } = await getProviderBySlugOrDefault(userId, providerSlug, defaultProvider);

  return {
    provider,
    isCustom,
    providerSlug,
    actualModel,
  };
}

export function copyProxyResponseHeaders(headers: Headers): Headers {
  const cloned = new Headers(headers);
  cloned.delete('content-length');
  return cloned;
}
