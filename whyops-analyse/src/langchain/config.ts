import { ChatOpenAI } from '@langchain/openai';
import { type BaseChatModel } from '@langchain/core/language_models/chat_models';
import env from '@whyops/shared/env';
import { createServiceLogger } from '@whyops/shared/logger';

const logger = createServiceLogger('analyse:langchain:config');

// ---------------------------------------------------------------------------
// Thresholds — central place for all adaptive sizing decisions
// ---------------------------------------------------------------------------
export const THRESHOLDS = {
  /** System prompt token count above which we segment into blocks */
  PROMPT_SEGMENT_TOKEN_LIMIT: 4000,
  /** Max tools to send in full before applying relevance filter */
  TOOL_FULL_SEND_LIMIT: 15,
  /** Max candidate tools after relevance filtering */
  TOOL_CANDIDATE_CAP: 20,
  /** Trace event count above which we switch to map-reduce */
  TRACE_MAP_REDUCE_LIMIT: 30,
  /** Minimum confidence to generate a diff patch */
  PATCH_CONFIDENCE_THRESHOLD: 0.7,
  /** Approximate tokens-per-char ratio for rough estimation */
  TOKENS_PER_CHAR: 0.25,
  /** Max concurrent block evaluations for segmented prompt-quality chain */
  PROMPT_BLOCK_EVAL_CONCURRENCY: 8,
} as const;

// ---------------------------------------------------------------------------
// Model factory — returns a LangChain ChatOpenAI pointed at LiteLLM proxy
//
// LiteLLM exposes an OpenAI-compatible /v1 endpoint, so we always use
// ChatOpenAI regardless of the underlying model (azure/gpt-4.1, claude, etc.).
// The LiteLLM proxy handles routing to the correct provider.
// ---------------------------------------------------------------------------
let _cachedModel: BaseChatModel | null = null;
let _cachedModelKey = '';

function normalizeHeaders(headers: any): Record<string, string> {
  if (!headers) return {};

  if (typeof headers.get === 'function') {
    return {
      'x-request-id': headers.get('x-request-id') || '',
      'request-id': headers.get('request-id') || '',
      'openai-request-id': headers.get('openai-request-id') || '',
    };
  }

  if (typeof headers === 'object') {
    const lowerCased: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      lowerCased[String(k).toLowerCase()] = String(v ?? '');
    }
    return {
      'x-request-id': lowerCased['x-request-id'] || '',
      'request-id': lowerCased['request-id'] || '',
      'openai-request-id': lowerCased['openai-request-id'] || '',
    };
  }

  return {};
}

export function getJudgeModelName(overrideModel?: string): string {
  return overrideModel || env.JUDGE_LLM_MODEL;
}

export interface JudgeErrorDiagnostics {
  status?: number;
  requestId?: string;
  errorCode?: string;
  errorType?: string;
}

export function extractJudgeErrorDiagnostics(error: unknown): JudgeErrorDiagnostics {
  const err = error as any;
  const responseHeaders = normalizeHeaders(err?.response?.headers);
  const directHeaders = normalizeHeaders(err?.headers);

  const requestId =
    err?.request_id ||
    err?.requestId ||
    directHeaders['x-request-id'] ||
    directHeaders['request-id'] ||
    directHeaders['openai-request-id'] ||
    responseHeaders['x-request-id'] ||
    responseHeaders['request-id'] ||
    responseHeaders['openai-request-id'] ||
    undefined;

  return {
    status: err?.status || err?.response?.status || undefined,
    requestId,
    errorCode: err?.code || err?.response?.data?.error?.code || undefined,
    errorType: err?.type || err?.response?.data?.error?.type || undefined,
  };
}

export function isInvalidModelNameError(error: unknown): boolean {
  const err = error as any;
  const message = [
    err?.message,
    err?.response?.data?.error?.message,
    typeof err?.response?.data?.error === 'string' ? err.response.data.error : '',
  ]
    .filter(Boolean)
    .join(' ');

  return /invalid model name passed in model=/i.test(message);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function invokeWithInvalidModelRetry<T>(args: {
  invoke: () => Promise<T>;
  logger: { warn: (...args: any[]) => void };
  chainName: string;
  overrideModel?: string;
  maxRetries?: number;
}): Promise<T> {
  const maxRetries = args.maxRetries ?? Math.max(1, env.JUDGE_MAX_RETRIES);
  const modelName = getJudgeModelName(args.overrideModel);
  const baseURL = env.JUDGE_LLM_BASE_URL;
  const judgeKeySuffix = env.JUDGE_LLM_API_KEY?.slice(-8);

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await args.invoke();
    } catch (error) {
      lastError = error;

      const isRetryable = isInvalidModelNameError(error);
      if (!isRetryable || attempt >= maxRetries) {
        throw error;
      }

      const delayMs = 200 + attempt * 200 + Math.floor(Math.random() * 200);
      const diagnostics = extractJudgeErrorDiagnostics(error);

      args.logger.warn(
        {
          chain: args.chainName,
          model: modelName,
          baseURL,
          judgeKeySuffix,
          retryAttempt: attempt + 1,
          maxRetries,
          delayMs,
          ...diagnostics,
        },
        'Judge call failed with invalid model name; retrying'
      );

      await sleep(delayMs);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Judge invoke failed after retries');
}

export function getJudgeModel(overrideModel?: string): BaseChatModel {
  const modelName = getJudgeModelName(overrideModel);
  const apiKey = env.JUDGE_LLM_API_KEY;
  const baseURL = env.JUDGE_LLM_BASE_URL;

  if (!apiKey) {
    throw new Error('JUDGE_NOT_CONFIGURED: JUDGE_LLM_API_KEY environment variable is not set');
  }

  if (!baseURL) {
    throw new Error('JUDGE_NOT_CONFIGURED: JUDGE_LLM_BASE_URL environment variable is not set');
  }

  const cacheKey = `${modelName}:${baseURL}:${apiKey.slice(-8)}`;
  if (_cachedModel && _cachedModelKey === cacheKey) {
    return _cachedModel;
  }

  logger.info({ model: modelName, baseURL }, 'Creating judge LLM instance via LiteLLM proxy');

  const model = new ChatOpenAI({
    model: modelName,
    apiKey,
    temperature: env.JUDGE_LLM_TEMPERATURE,
    maxRetries: 1,
    timeout: 60000, // 60s timeout
    configuration: {
      baseURL,
    },
  });

  _cachedModel = model;
  _cachedModelKey = cacheKey;
  return model;
}

/** Rough token count estimation (char-based, fast, no tokenizer dependency) */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length * THRESHOLDS.TOKENS_PER_CHAR);
}

/** Clear model cache — mainly for testing */
export function resetModelCache(): void {
  _cachedModel = null;
  _cachedModelKey = '';
}
