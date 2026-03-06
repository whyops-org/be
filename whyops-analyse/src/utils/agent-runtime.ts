import env from '@whyops/shared/env';
import { Agent } from '@whyops/shared/models';
import { QueryTypes } from 'sequelize';

const CACHE_TTL_MS = 60_000;

let runtimeColumnsCache: {
  checkedAtMs: number;
  available: boolean;
} | null = null;

export function getDefaultAgentRuntimeLimits() {
  return {
    maxTraces: Math.max(1, Number(env.MAX_TRACES_PER_AGENT)),
    maxSpans: Math.max(1, Number(env.MAX_SPANS_PER_AGENT)),
  };
}

export async function hasAgentRuntimeColumns(forceRefresh = false): Promise<boolean> {
  if (!forceRefresh && runtimeColumnsCache) {
    const stillValid = Date.now() - runtimeColumnsCache.checkedAtMs < CACHE_TTL_MS;
    if (stillValid) {
      return runtimeColumnsCache.available;
    }
  }

  try {
    const rows = await Agent.sequelize!.query<{ column_name: string }>(
      `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'agents'
          AND column_name IN ('max_traces', 'max_spans')
      `,
      { type: QueryTypes.SELECT }
    );

    const columns = new Set(rows.map((row) => row.column_name));
    const available = columns.has('max_traces') && columns.has('max_spans');
    runtimeColumnsCache = { checkedAtMs: Date.now(), available };
    return available;
  } catch {
    runtimeColumnsCache = { checkedAtMs: Date.now(), available: false };
    return false;
  }
}
