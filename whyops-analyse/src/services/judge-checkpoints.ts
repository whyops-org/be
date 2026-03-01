export interface JudgeCheckpointEvent<TSnapshot = unknown> {
  key: string;
  scope?: string;
  sequence: number;
  at: string;
  data?: Record<string, unknown>;
  snapshot?: TSnapshot;
}

export type JudgeCheckpointHandler<TSnapshot = unknown> = (
  event: JudgeCheckpointEvent<TSnapshot>
) => void | Promise<void>;

export interface JudgeCheckpointEmitter<TSnapshot = unknown> {
  checkpoint: (key: string, data?: Record<string, unknown>) => Promise<void>;
  scoped: (scope: string) => JudgeCheckpointEmitter<TSnapshot>;
}

interface SeqRef {
  value: number;
}

function joinScope(scope: string | undefined, key: string): string {
  if (!scope) return key;
  return `${scope}.${key}`;
}

export function createJudgeCheckpointEmitter<TSnapshot = unknown>(args?: {
  handler?: JudgeCheckpointHandler<TSnapshot>;
  scope?: string;
  seqRef?: SeqRef;
  getSnapshot?: () => TSnapshot | undefined;
}): JudgeCheckpointEmitter<TSnapshot> {
  const handler = args?.handler;
  const scope = args?.scope;
  const seqRef = args?.seqRef || { value: 0 };
  const getSnapshot = args?.getSnapshot;

  const checkpoint: JudgeCheckpointEmitter<TSnapshot>['checkpoint'] = async (key, data) => {
    if (!handler) return;

    seqRef.value += 1;
    try {
      await handler({
        key: joinScope(scope, key),
        scope,
        sequence: seqRef.value,
        at: new Date().toISOString(),
        data,
        snapshot: getSnapshot?.(),
      });
    } catch {
      // Checkpoint delivery failures must never break analysis execution.
    }
  };

  const scoped: JudgeCheckpointEmitter<TSnapshot>['scoped'] = (childScope) => {
    const nextScope = scope ? `${scope}.${childScope}` : childScope;
    return createJudgeCheckpointEmitter({
      handler,
      scope: nextScope,
      seqRef,
      getSnapshot,
    });
  };

  return { checkpoint, scoped };
}
