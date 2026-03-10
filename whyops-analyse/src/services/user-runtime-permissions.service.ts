import { User } from '@whyops/shared/models';

export interface UserRuntimePermissions {
  canChangeAgentMaxTraces: boolean;
  canChangeAgentMaxSpans: boolean;
  canChangeMaxAgents: boolean;
}

const DEFAULT_PERMISSIONS: UserRuntimePermissions = {
  canChangeAgentMaxTraces: false,
  canChangeAgentMaxSpans: false,
  canChangeMaxAgents: false,
};

const CACHE_TTL_MS = 30_000;
const permissionsCache = new Map<string, { expiresAtMs: number; value: UserRuntimePermissions }>();

function readBoolean(metadata: Record<string, unknown>, keys: string[]): boolean {
  for (const key of keys) {
    if (metadata[key] === true) {
      return true;
    }
  }
  return false;
}

export class UserRuntimePermissionsService {
  static async getForUser(userId: string): Promise<UserRuntimePermissions> {
    const cached = permissionsCache.get(userId);
    if (cached && Date.now() <= cached.expiresAtMs) {
      return cached.value;
    }

    const user = await User.findByPk(userId, {
      attributes: ['id', 'metadata'],
    });

    if (!user) {
      return DEFAULT_PERMISSIONS;
    }

    const metadata = ((user as any).metadata || {}) as Record<string, unknown>;

    const permissions: UserRuntimePermissions = {
      canChangeAgentMaxTraces: readBoolean(metadata, [
        'canChangeAgentMaxTraces',
        'can_change_agent_max_traces',
      ]),
      canChangeAgentMaxSpans: readBoolean(metadata, [
        'canChangeAgentMaxSpans',
        'can_change_agent_max_spans',
      ]),
      canChangeMaxAgents: readBoolean(metadata, ['canChangeMaxAgents', 'can_change_max_agents']),
    };

    permissionsCache.set(userId, {
      expiresAtMs: Date.now() + CACHE_TTL_MS,
      value: permissions,
    });

    return permissions;
  }
}
