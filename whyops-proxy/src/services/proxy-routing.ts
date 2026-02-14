import { createServiceLogger } from '@whyops/shared/logger';
import { Provider } from '@whyops/shared/models';
import { decrypt } from '@whyops/shared/utils';

const logger = createServiceLogger('proxy:routing');

export interface ResolvedProvider {
  provider: any;
  isCustom: boolean;
  providerSlug: string | null;
  actualModel: string;
}

export function parseModelField(model: string): { providerSlug: string | null; actualModel: string } {
  if (!model || !model.includes('/')) {
    return { providerSlug: null, actualModel: model };
  }

  const parts = model.split('/');
  if (parts[0].includes('-')) {
    return { providerSlug: parts[0], actualModel: parts.slice(1).join('/') };
  }

  return { providerSlug: null, actualModel: model };
}

export async function getProviderBySlugOrDefault(
  userId: string,
  providerSlug: string | null,
  defaultProvider: any
): Promise<{ provider: any; isCustom: boolean }> {
  if (!providerSlug) {
    return { provider: defaultProvider, isCustom: false };
  }

  const provider = await Provider.findOne({
    where: {
      userId,
      slug: providerSlug,
      isActive: true,
    },
  });

  if (provider) {
    const decryptedApiKey = decrypt(provider.apiKey);
    return {
      provider: {
        ...provider.toJSON(),
        apiKey: decryptedApiKey,
      },
      isCustom: true,
    };
  }

  logger.warn({ providerSlug }, 'Provider slug not found, using default');
  return { provider: defaultProvider, isCustom: false };
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
