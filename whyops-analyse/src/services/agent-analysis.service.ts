import { createServiceLogger } from '@whyops/shared/logger';
import env from '@whyops/shared/env';
import {
  Agent,
  AgentAnalysisConfig,
  AgentAnalysisFinding,
  AgentAnalysisRun,
  AgentAnalysisSection,
  Entity,
} from '@whyops/shared/models';
import { QueryTypes } from 'sequelize';
import {
  runAgentDimensionAnalysisChain,
  runAgentOverviewAnalysisChain,
  runAgentSectionInsightsChain,
  runAgentSynthesisChain,
  runAgentTraceIntentRoutingChain,
  type AgentDimensionAnalysisResult,
  type AgentJudgeDimension,
  type AgentJudgeSeverity,
  type AgentSynthesisResult,
} from '../langchain';
import {
  createJudgeCheckpointEmitter,
  type JudgeCheckpointHandler,
} from './judge-checkpoints';

const logger = createServiceLogger('analyse:agent-analysis-service');

type AnalysisMode = 'quick' | 'standard' | 'deep';

interface RunAgentAnalysisInput {
  userId: string;
  projectId: string;
  environmentId: string;
  agentId: string;
  lookbackDays?: number;
  mode?: AnalysisMode;
  judgeModel?: string;
  dimensions?: AgentJudgeDimension[];
  onCheckpoint?: JudgeCheckpointHandler<AgentAnalysisResult>;
}

interface EventLiteRow {
  traceId: string;
  stepId: number;
  eventType: string;
  timestamp: string | Date;
  content: any;
  metadata: any;
}

interface TraceStatsRow {
  traceId: string;
  errorCount: string | number;
  avgLatencyMs: string | number | null;
}

interface TopToolRow {
  toolName: string;
  calls: string | number;
  likelyErrors: string | number;
  avgLatencyMs: string | number | null;
  avgResponseBytes: string | number;
}

interface ToolRetryRow {
  toolName: string;
  retryCalls: string | number;
}

interface ToolTraceRow {
  traceId: string;
  callCount: string | number;
}

interface ToolTraceUsageRow {
  traceId: string;
  toolName: string;
  calls: string | number;
}

interface ToolOutputUtilizationRow {
  totalToolResponses: string | number;
  consumedToolResponses: string | number;
}

interface ReliabilityRecoveryRow {
  tracesWithError: string | number;
  recoveredTraces: string | number;
}

interface JudgeSummaryRow {
  summary: any;
}

interface SeverityRow {
  severity: string;
  count: string | number;
}

interface FlattenedIssue {
  dimension: AgentJudgeDimension;
  code: string;
  title: string;
  detail: string;
  severity: AgentJudgeSeverity;
  confidence: number;
  frequency: number;
  impactScore: number;
  evidence: Array<{
    traceId: string | null;
    signalType: string;
    snippet: string;
  }>;
  rootCause: string;
  recommendation: {
    action: string;
    detail: string;
    ownerType: string;
    fixType: string;
  };
  patches: Array<Record<string, any>>;
}

type InitialIntentCategory =
  | 'real_time_lookup'
  | 'troubleshooting_support'
  | 'how_to_guidance'
  | 'planning_recommendation'
  | 'content_generation'
  | 'data_analysis_reporting'
  | 'account_or_action_request'
  | 'comparison_decision'
  | 'casual_or_other';

const TRACE_JUDGE_DIMENSIONS = [
  'step_correctness',
  'tool_choice',
  'prompt_quality',
  'tool_description',
  'cost_efficiency',
] as const;

const AGENT_DIMENSIONS = [
  'intent_precision',
  'followup_repair',
  'answer_completeness_clarity',
  'tool_routing_quality',
  'tool_invocation_quality',
  'tool_output_utilization',
  'reliability_recovery',
  'latency_cost_efficiency',
  'conversation_ux',
] as const;

const DIMENSION_RUBRICS: Record<AgentJudgeDimension, string> = {
  intent_precision:
    'Evaluate whether the agent identifies and tracks user intent correctly across first turns. Penalize misread intent, over-generalization, and intent collapse across similar but distinct requests.',
  followup_repair:
    'Evaluate follow-up handling quality when users ask clarifications/corrections/retries. Penalize unresolved loops, weak recovery, and failure to answer the specific repair request.',
  answer_completeness_clarity:
    'Evaluate answer completeness, directness, and clarity against user asks. Penalize missing required details, vague instructions, and responses that force avoidable follow-ups.',
  tool_routing_quality:
    'Evaluate whether tools are selected when needed and avoided when unnecessary. Penalize under-use for external facts and over-use where direct reasoning is sufficient.',
  tool_invocation_quality:
    'Evaluate tool call execution quality: schema/argument quality, retries, avoidable failures, and recoverability. Penalize malformed calls and repeated invalid invocations.',
  tool_output_utilization:
    'Evaluate whether tool results are integrated into final answers correctly and completely. Penalize ignored outputs, contradictions, and weak synthesis of retrieved/tool data.',
  reliability_recovery:
    'Evaluate reliability patterns: error occurrence, graceful degradation, fallback behavior, and recovery after failure. Penalize brittle behavior and unresolved failure states.',
  latency_cost_efficiency:
    'Evaluate latency and token efficiency relative to user value. Penalize unnecessarily expensive response patterns, excessive tool chains, and high-latency low-value behavior.',
  conversation_ux:
    'Evaluate conversational experience: turn economy, coherence, politeness/professionalism, and user effort. Penalize verbosity mismatch, confusion, and poor interaction flow.',
};

const totalTokensExpr = `
  COALESCE(
    NULLIF(e."metadata"->'usage'->>'totalTokens', '')::numeric,
    NULLIF(e."metadata"->'usage'->>'total_tokens', '')::numeric,
    NULLIF(e."metadata"->>'totalTokens', '')::numeric,
    NULLIF(e."metadata"->>'total_tokens', '')::numeric,
    NULLIF(e."content"->'usage'->>'totalTokens', '')::numeric,
    NULLIF(e."content"->'usage'->>'total_tokens', '')::numeric,
    NULLIF(e."content"->>'totalTokens', '')::numeric,
    NULLIF(e."content"->>'total_tokens', '')::numeric
  )
`;

const latencyMsExpr = `
  NULLIF(
    REGEXP_REPLACE(
      COALESCE(
        e."metadata"->>'latencyMs',
        e."metadata"->>'latency_ms',
        e."content"->>'latencyMs',
        e."content"->>'latency_ms',
        ''
      ),
      '[^0-9.]',
      '',
      'g'
    ),
    ''
  )::numeric
`;

function clampLookbackDays(days?: number): number {
  if (!days || Number.isNaN(days)) return 14;
  return Math.min(Math.max(days, 1), 90);
}

function resolveMode(mode?: AnalysisMode): AnalysisMode {
  if (mode === 'quick' || mode === 'standard' || mode === 'deep') return mode;
  return 'standard';
}

function resolveDimensions(input?: AgentJudgeDimension[]): AgentJudgeDimension[] {
  if (!input || input.length === 0) return [...AGENT_DIMENSIONS];

  const allowed = new Set<AgentJudgeDimension>(AGENT_DIMENSIONS as unknown as AgentJudgeDimension[]);
  const seen = new Set<AgentJudgeDimension>();
  const out: AgentJudgeDimension[] = [];

  for (const dimension of input) {
    if (!allowed.has(dimension) || seen.has(dimension)) continue;
    seen.add(dimension);
    out.push(dimension);
  }

  return out.length > 0 ? out : [...AGENT_DIMENSIONS];
}

function samplingCaps(mode: AnalysisMode) {
  if (mode === 'quick') {
    return {
      userEvents: 12000,
      judgeSummaries: 150,
      conversationSamples: 16,
      evidenceTopN: 12,
      traceClassifications: 140,
    };
  }
  if (mode === 'deep') {
    return {
      userEvents: 120000,
      judgeSummaries: 1200,
      conversationSamples: 72,
      evidenceTopN: 25,
      traceClassifications: 900,
    };
  }
  return {
    userEvents: 60000,
    judgeSummaries: 400,
    conversationSamples: 36,
    evidenceTopN: 18,
    traceClassifications: 420,
  };
}

function maybeParseJsonString(value: string): any {
  let current: any = value.trim();
  if (!current) return value;

  for (let i = 0; i < 3; i += 1) {
    if (typeof current !== 'string') return current;

    const trimmed = current.trim();
    const looksJsonLike =
      trimmed.startsWith('{') ||
      trimmed.startsWith('[') ||
      (trimmed.startsWith('"') && (trimmed.includes('{') || trimmed.includes('[')));

    if (!looksJsonLike) return current;

    try {
      current = JSON.parse(trimmed);
    } catch {
      return current;
    }
  }

  return current;
}

function maybeDecodeEscapedString(value: string): string {
  try {
    return JSON.parse(`"${value.replace(/"/g, '\\"')}"`);
  } catch {
    return value;
  }
}

function extractTextFragmentsFromJsonLike(value: string): string[] {
  const matches = [...value.matchAll(/"text"\s*:\s*"((?:\\.|[^"])*)"/g)];
  if (matches.length === 0) return [];

  return matches
    .map((match) => maybeDecodeEscapedString(match[1] || '').trim())
    .filter((text) => text.length > 0);
}

function extractTextNode(node: any, depth = 0): string {
  if (depth > 4 || node === null || node === undefined) return '';

  if (typeof node === 'string') {
    const parsed = maybeParseJsonString(node);
    if (parsed !== node) return extractTextNode(parsed, depth + 1);
    return node;
  }

  if (Array.isArray(node)) {
    for (let i = node.length - 1; i >= 0; i -= 1) {
      const item = node[i];
      const preferred =
        (typeof item?.role === 'string' && item.role === 'user') ||
        item?.type === 'input_text' ||
        item?.type === 'text';
      if (preferred) {
        const value =
          extractTextNode(item?.content, depth + 1) ||
          extractTextNode(item?.text, depth + 1) ||
          extractTextNode(item, depth + 1);
        if (value) return value;
      }
    }

    for (let i = node.length - 1; i >= 0; i -= 1) {
      const value = extractTextNode(node[i], depth + 1);
      if (value) return value;
    }
    return '';
  }

  if (typeof node === 'object') {
    const fromFields =
      extractTextNode(node.content, depth + 1) ||
      extractTextNode(node.text, depth + 1) ||
      extractTextNode(node.parts, depth + 1) ||
      extractTextNode(node.message, depth + 1) ||
      extractTextNode(node.input, depth + 1) ||
      extractTextNode(node.query, depth + 1) ||
      extractTextNode(node.prompt, depth + 1) ||
      extractTextNode(node.value, depth + 1) ||
      extractTextNode(node.raw, depth + 1) ||
      extractTextNode(node.body, depth + 1);
    if (fromFields) return fromFields;

    if (node.format && node.parts) {
      return extractTextNode(node.parts, depth + 1);
    }

    // Last attempt before serialization: recursively inspect values.
    for (const value of Object.values(node)) {
      const extracted = extractTextNode(value, depth + 1);
      if (extracted) return extracted;
    }

    return '';
  }

  return '';
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function stripMessageArtifacts(value: string): string {
  return value
    .replace(/!\[[^\]]*\]\([^)]+\)/gi, ' ')
    .replace(/\[(?:image|img)\s*#?\d+\]/gi, ' ')
    .replace(/\b(?:image|img)\s*#?\d+\b/gi, ' ')
    .replace(/<image[^>]*>/gi, ' ')
    .replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g, ' ');
}

function truncateForDisplay(value: string, max = 260): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}

function normalizeUserMessageText(value: string): string {
  let normalized = normalizeWhitespace(value);
  if (!normalized) return '';

  if (
    (normalized.startsWith('{') || normalized.startsWith('[')) &&
    normalized.includes('"text"')
  ) {
    const fragments = extractTextFragmentsFromJsonLike(normalized);
    if (fragments.length > 0) {
      normalized = normalizeWhitespace(fragments[fragments.length - 1] || fragments[0]);
    }
  }

  if (normalized.startsWith('{') || normalized.startsWith('[')) {
    return '';
  }

  const cleaned = normalizeWhitespace(stripMessageArtifacts(normalized));
  if (!cleaned) return '';
  if (cleaned.length < 2) return '';
  if (/^\[[^\]]+\]$/.test(cleaned)) return '';
  if (/^(?:true|false|null)$/i.test(cleaned)) return '';

  return cleaned;
}

function normalizeQuery(value: string): string {
  return normalizeWhitespace(
    value
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .replace(/\d+/g, ' ')
  );
}

function topCounts(map: Map<string, number>, limit: number) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

function sampleEvenly<T>(items: T[], limit: number): T[] {
  if (limit <= 0 || items.length <= limit) return items;
  if (limit === 1) return [items[0]];

  const out: T[] = [];
  const step = (items.length - 1) / (limit - 1);
  for (let i = 0; i < limit; i += 1) {
    out.push(items[Math.round(i * step)]);
  }

  return out;
}

function chunkArray<T>(items: T[], chunkSize: number): T[][] {
  if (chunkSize <= 0 || items.length === 0) return items.length ? [items] : [];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    out.push(items.slice(i, i + chunkSize));
  }
  return out;
}

function countArrayToRecord(
  items?: Array<{ key?: string | null; count?: number | string | null }>
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items || []) {
    const key = String(item?.key || '').trim();
    if (!key) continue;
    const count = Number(item?.count || 0);
    if (!Number.isFinite(count) || count < 0) continue;
    out[key] = Number(count);
  }
  return out;
}

function numberArrayToRecord(
  items?: Array<{ key?: string | null; value?: number | string | null }>
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const item of items || []) {
    const key = String(item?.key || '').trim();
    if (!key) continue;
    if (item?.value === null || item?.value === undefined) {
      out[key] = null;
      continue;
    }
    const value = Number(item.value);
    out[key] = Number.isFinite(value) ? value : null;
  }
  return out;
}

function deltaArrayToRecord(
  items?: Array<{ key?: string | null; delta?: number | string | null }>
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const item of items || []) {
    const key = String(item?.key || '').trim();
    if (!key) continue;
    if (item?.delta === null || item?.delta === undefined) {
      out[key] = null;
      continue;
    }
    const delta = Number(item.delta);
    out[key] = Number.isFinite(delta) ? delta : null;
  }
  return out;
}

function toDeltaMap(
  current: Record<string, number>,
  previous: Record<string, number>
): Record<string, number | null> {
  const keys = new Set([...Object.keys(current), ...Object.keys(previous)]);
  const out: Record<string, number | null> = {};

  for (const key of keys) {
    const c = Number(current[key]);
    const p = Number(previous[key]);
    if (!Number.isFinite(c) || !Number.isFinite(p)) {
      out[key] = null;
      continue;
    }
    out[key] = Number((c - p).toFixed(3));
  }

  return out;
}

function recommendation(
  priority: number,
  title: string,
  detail: string,
  category: string,
  severity: 'low' | 'medium' | 'high' | 'critical'
) {
  return { priority, title, detail, category, severity };
}

function severityRank(severity: AgentJudgeSeverity): number {
  if (severity === 'critical') return 4;
  if (severity === 'high') return 3;
  if (severity === 'medium') return 2;
  return 1;
}

function severityFromScore(score: number): AgentJudgeSeverity {
  if (score < 0.25) return 'critical';
  if (score < 0.45) return 'high';
  if (score < 0.7) return 'medium';
  return 'low';
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function clamp100(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

function normalizeDimensionResult(
  dimension: AgentJudgeDimension,
  raw: AgentDimensionAnalysisResult
): AgentDimensionAnalysisResult {
  const issues = (raw.issues || []).map((issue) => ({
    ...issue,
    severity: issue.severity,
    confidence: clamp01(Number(issue.confidence || 0)),
    frequency: Math.max(0, Math.round(Number(issue.frequency || 0))),
    impactScore: clamp100(Number(issue.impactScore || 0)),
    evidence: (issue.evidence || []).slice(0, 8).map((e) => ({
      traceId: e.traceId || null,
      signalType: e.signalType || 'unknown',
      snippet: String(e.snippet || '').slice(0, 1200),
    })),
    recommendation: {
      action: issue.recommendation?.action || 'investigate_issue',
      detail: issue.recommendation?.detail || 'Investigate and implement fix for the issue.',
      ownerType: issue.recommendation?.ownerType || 'unknown',
      fixType: issue.recommendation?.fixType || 'other',
    },
    patches: Array.isArray(issue.patches) ? issue.patches.slice(0, 8) : [],
  }));

  const score = clamp01(Number(raw.score || 0));

  return {
    ...raw,
    dimension,
    score,
    confidence: clamp01(Number(raw.confidence || 0)),
    severity: raw.severity || severityFromScore(score),
    summary: raw.summary || 'No summary generated for this dimension.',
    strengths: (raw.strengths || []).filter(Boolean).slice(0, 8),
    weaknesses: (raw.weaknesses || []).filter(Boolean).slice(0, 12),
    issues,
  };
}

function fallbackDimensionResult(
  dimension: AgentJudgeDimension,
  reason: string
): AgentDimensionAnalysisResult {
  return {
    dimension,
    score: 0,
    severity: 'high',
    confidence: 0,
    summary: `Dimension analysis unavailable: ${reason}`,
    strengths: [],
    weaknesses: ['Dimension execution failed; review logs and rerun analysis.'],
    issues: [],
  };
}

function flattenIssues(results: AgentDimensionAnalysisResult[]): FlattenedIssue[] {
  return results.flatMap((result) =>
    (result.issues || []).map((issue) => ({
      dimension: result.dimension,
      code: issue.code || 'UNKNOWN_ISSUE',
      title: issue.title || 'Unknown issue',
      detail: issue.detail || 'No detail provided.',
      severity: issue.severity,
      confidence: clamp01(Number(issue.confidence || 0)),
      frequency: Math.max(0, Math.round(Number(issue.frequency || 0))),
      impactScore: clamp100(Number(issue.impactScore || 0)),
      evidence: (issue.evidence || []).slice(0, 8).map((e) => ({
        traceId: e.traceId || null,
        signalType: e.signalType || 'unknown',
        snippet: String(e.snippet || '').slice(0, 1200),
      })),
      rootCause: issue.rootCause || 'Unknown root cause',
      recommendation: {
        action: issue.recommendation?.action || 'investigate_issue',
        detail: issue.recommendation?.detail || 'Investigate and implement fix for this issue.',
        ownerType: issue.recommendation?.ownerType || 'unknown',
        fixType: issue.recommendation?.fixType || 'other',
      },
      patches: Array.isArray(issue.patches) ? issue.patches.slice(0, 8) : [],
    }))
  );
}

function summarizeSeverityCounts(findings: FlattenedIssue[]): Record<string, number> {
  const out: Record<string, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  };

  for (const finding of findings) {
    out[finding.severity] = (out[finding.severity] || 0) + 1;
  }

  return out;
}

function buildDimensionEvidenceBundle(args: {
  dimension: AgentJudgeDimension;
  overview: Record<string, any>;
  queryIntelligence: Record<string, any>;
  followupIntelligence: Record<string, any>;
  intentIntelligence: Record<string, any>;
  toolIntelligence: Record<string, any>;
  qualityIntelligence: Record<string, any>;
  conversationSamples: any[];
  extraSignals: Record<string, any>;
}) {
  const shared = {
    overview: args.overview,
    queryIntelligence: args.queryIntelligence,
    followupIntelligence: args.followupIntelligence,
    intentIntelligence: args.intentIntelligence,
    toolIntelligence: {
      tools: (args.toolIntelligence.tools || []).slice(0, 25),
      bestPerformingTools: args.toolIntelligence.bestPerformingTools || [],
      expensiveTools: args.toolIntelligence.expensiveTools || [],
      utilization: args.toolIntelligence.utilization || {},
      routingSignals: args.toolIntelligence.routingSignals || {},
    },
    qualityIntelligence: args.qualityIntelligence,
    conversationSamples: args.conversationSamples,
    extraSignals: args.extraSignals,
  };

  if (args.dimension === 'intent_precision') {
    return {
      ...shared,
      focus: {
        topInitialQueries: args.queryIntelligence.topInitialQueries || [],
        topFirstQueryIntents: args.queryIntelligence.topFirstQueryIntents || [],
        firstQueryIntentOutcomes: args.queryIntelligence.firstQueryIntentOutcomes || [],
        topIntentClusters: args.intentIntelligence.topIntentClusters || [],
        highErrorQueries: args.queryIntelligence.topHighErrorQueries || [],
      },
    };
  }

  if (args.dimension === 'followup_repair') {
    return {
      ...shared,
      focus: {
        followupRate: args.followupIntelligence.followupRate,
        topFollowups: args.followupIntelligence.topFollowups || [],
        followupIntentCategories: args.followupIntelligence.intentCategories || {},
        loopingTraces: args.followupIntelligence.loopingTraces || 0,
      },
    };
  }

  if (args.dimension === 'answer_completeness_clarity') {
    return {
      ...shared,
      focus: {
        topRepeatedQueries: args.queryIntelligence.topRepeatedQueries || [],
        followupReasons: args.followupIntelligence.intentCategories || {},
        conversationSamples: args.conversationSamples,
      },
    };
  }

  if (args.dimension === 'tool_routing_quality') {
    return {
      ...shared,
      focus: {
        toolCallRate: args.overview.toolCallRate,
        routingSignals: args.toolIntelligence.routingSignals || {},
        routingAssessment: args.toolIntelligence.routingAssessment || {},
        topQueriesWithoutTools: args.toolIntelligence.routingSignals?.topToolNeedWithoutToolQueries || [],
      },
    };
  }

  if (args.dimension === 'tool_invocation_quality') {
    return {
      ...shared,
      focus: {
        tools: args.toolIntelligence.tools || [],
        effectiveness: args.toolIntelligence.effectiveness || {},
        retriesByTool: (args.toolIntelligence.tools || []).map((tool: any) => ({
          toolName: tool.toolName,
          retries: tool.retries,
          likelyErrors: tool.likelyErrors,
        })),
      },
    };
  }

  if (args.dimension === 'tool_output_utilization') {
    return {
      ...shared,
      focus: {
        utilization: args.toolIntelligence.utilization || {},
        conversationSamples: args.conversationSamples,
      },
    };
  }

  if (args.dimension === 'reliability_recovery') {
    return {
      ...shared,
      focus: {
        errorRate: args.overview.errorRate,
        recoverySignals: args.qualityIntelligence.reliability || {},
        severityDistribution: args.qualityIntelligence.severityDistribution || {},
      },
    };
  }

  if (args.dimension === 'latency_cost_efficiency') {
    return {
      ...shared,
      focus: {
        latency: {
          avgLatencyMs: args.overview.avgLatencyMs,
          p50LatencyMs: args.overview.p50LatencyMs,
          p90LatencyMs: args.overview.p90LatencyMs,
        },
        tokens: {
          totalTokens: args.overview.totalTokens,
          avgTokensPerResponse: args.overview.avgTokensPerResponse,
        },
        expensiveTools: args.toolIntelligence.expensiveTools || [],
      },
    };
  }

  return {
    ...shared,
    focus: {
      multiTurnRate: args.overview.multiTurnRate,
      followupRate: args.followupIntelligence.followupRate,
      avgTurnsPerTrace: args.followupIntelligence.avgTurnsPerTrace,
      loopingTraces: args.followupIntelligence.loopingTraces,
      conversationSamples: args.conversationSamples,
    },
  };
}

function buildEmptySections(dimensions: AgentJudgeDimension[]) {
  const dimensionResults = dimensions.map((dimension) =>
    fallbackDimensionResult(dimension, 'No traces in selected window')
  );

  const scoresByDimension = Object.fromEntries(
    dimensionResults.map((result) => [result.dimension, result.score])
  );

  return {
    overview: {
      totalTraces: 0,
      totalEvents: 0,
      activeDays: 0,
      multiTurnRate: 0,
      errorRate: 0,
      avgLatencyMs: null,
      p50LatencyMs: null,
      p90LatencyMs: null,
      totalTokens: 0,
      avgTokensPerResponse: null,
      toolCallRate: 0,
    },
    query_intelligence: {
      topInitialQueries: [],
      topRepeatedQueries: [],
      topHighErrorQueries: [],
      topHighLatencyQueries: [],
      firstQueryIntentCategories: {},
      topFirstQueryIntents: [],
      firstQueryIntentOutcomes: [],
      topIntentsNeedingDevelopment: [],
      inputCoverage: {
        totalUserEvents: 0,
        processedUserEvents: 0,
        truncated: false,
      },
    },
    followup_intelligence: {
      topFollowups: [],
      followupRate: 0,
      followupCount: 0,
      avgTurnsPerTrace: 0,
      loopingTraces: 0,
      intentCategories: {},
    },
    intent_intelligence: {
      topIntentClusters: [],
      intentDistribution: {},
      intentShiftVsPreviousRun: {},
    },
    tool_intelligence: {
      tools: [],
      bestPerformingTools: [],
      expensiveTools: [],
      routingSignals: {
        likelyToolNeededTraces: 0,
        likelyToolNeededWithoutToolTraces: 0,
        toolNeedMissRate: 0,
        topToolNeedWithoutToolQueries: [],
      },
      routingAssessment: {
        expectedToolTraces: 0,
        expectedAndCalled: 0,
        expectedButMissed: 0,
        calledWithoutNeed: 0,
        routingRecall: 0,
        routingPrecision: 0,
        arbitraryCallRate: 0,
      },
      effectiveness: {
        topResolvedTools: [],
        underperformingTools: [],
        mostUsedTools: [],
      },
      utilization: {
        totalToolResponses: 0,
        consumedToolResponses: 0,
        utilizationRate: 0,
      },
    },
    quality_intelligence: {
      analyzedTraceCount: 0,
      sampled: true,
      sampleLimit: 0,
      dimensionAverages: {},
      dimensionTrendVsPreviousRun: {},
      severityDistribution: {},
      reliability: {
        tracesWithError: 0,
        recoveredTraces: 0,
        recoveryRate: 0,
      },
    },
    dimension_scores: {
      overallScore: 0,
      scoresByDimension,
      trendVsPreviousRun: {},
      dimensions: dimensionResults.map((result) => ({
        dimension: result.dimension,
        score: result.score,
        severity: result.severity,
        confidence: result.confidence,
        summary: result.summary,
        issueCount: result.issues.length,
        strengths: result.strengths,
        weaknesses: result.weaknesses,
      })),
      totalIssues: 0,
      bySeverity: {
        critical: 0,
        high: 0,
        medium: 0,
        low: 0,
      },
      failures: {},
    },
    dimension_deep_dive: {
      dimensions: Object.fromEntries(dimensionResults.map((result) => [result.dimension, result])),
    },
    failure_taxonomy: {
      patterns: [],
      totalFindings: 0,
      bySeverity: {
        critical: 0,
        high: 0,
        medium: 0,
        low: 0,
      },
    },
    tool_diagnostics: {
      tools: [],
      systemicIssues: [],
      routingAnomalies: [],
    },
    action_plan: {
      items: [
        recommendation(
          1,
          'No traces in selected window',
          'Increase lookback window or wait for more traffic before rerunning agent analysis.',
          'data_coverage',
          'medium'
        ),
      ],
    },
    experiments: {
      items: [],
    },
    recommendations: {
      items: [
        recommendation(
          1,
          'No traces in selected window',
          'Increase lookback window or wait for more traffic before rerunning agent analysis.',
          'data_coverage',
          'medium'
        ),
      ],
    },
  };
}

export interface AgentAnalysisResult {
  id: string;
  configId: string | null;
  agentId: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  traceCount: number;
  eventCount: number;
  windowStart: string;
  windowEnd: string;
  summary: Record<string, any>;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  sections?: Record<string, any>;
  findings?: Array<Record<string, any>>;
}

export interface AgentAnalysisConfigResult {
  id: string;
  agentId: string;
  enabled: boolean;
  cronExpr: string;
  timezone: string;
  lookbackDays: number;
  samplingConfig: Record<string, any>;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();

  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  return String(value);
}

export class AgentAnalysisService {
  static async getConfigForAgent(
    agentId: string,
    scope: { userId: string; projectId: string; environmentId: string }
  ): Promise<AgentAnalysisConfigResult | null> {
    const config = await AgentAnalysisConfig.findOne({
      where: {
        agentId,
        userId: scope.userId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      },
    });

    if (!config) return null;
    return this.serializeConfig(config);
  }

  static async upsertConfigForAgent(input: {
    userId: string;
    projectId: string;
    environmentId: string;
    agentId: string;
    enabled: boolean;
    cronExpr: string;
    timezone: string;
    lookbackDays: number;
    mode?: AnalysisMode;
    judgeModel?: string;
    dimensions?: AgentJudgeDimension[];
  }): Promise<AgentAnalysisConfigResult> {
    const agent = await Agent.findOne({
      where: {
        id: input.agentId,
        userId: input.userId,
        projectId: input.projectId,
        environmentId: input.environmentId,
      },
      attributes: ['id', 'name', 'userId', 'projectId', 'environmentId', 'createdAt', 'updatedAt'],
    });

    if (!agent) {
      throw new Error('AGENT_NOT_FOUND');
    }

    const dimensions = resolveDimensions(input.dimensions);
    const lookbackDays = clampLookbackDays(input.lookbackDays);
    const mode = resolveMode(input.mode);
    const now = new Date();

    const [config, created] = await AgentAnalysisConfig.findOrCreate({
      where: {
        agentId: input.agentId,
        userId: input.userId,
        projectId: input.projectId,
        environmentId: input.environmentId,
      },
      defaults: {
        userId: input.userId,
        projectId: input.projectId,
        environmentId: input.environmentId,
        agentId: input.agentId,
        enabled: input.enabled,
        cronExpr: input.cronExpr,
        timezone: input.timezone,
        lookbackDays,
        samplingConfig: {
          mode,
          judgeModel: input.judgeModel || null,
          dimensions,
          updatedAt: now.toISOString(),
        },
      },
    });

    if (!created) {
      await config.update({
        enabled: input.enabled,
        cronExpr: input.cronExpr,
        timezone: input.timezone,
        lookbackDays,
        samplingConfig: {
          ...(config.samplingConfig || {}),
          mode,
          judgeModel: input.judgeModel || null,
          dimensions,
          updatedAt: now.toISOString(),
        },
      });
    }

    return this.serializeConfig(config);
  }

  static async runManualAnalysis(
    input: RunAgentAnalysisInput
  ): Promise<AgentAnalysisResult> {
    if (!env.JUDGE_LLM_API_KEY || !env.JUDGE_LLM_BASE_URL) {
      throw new Error('JUDGE_NOT_CONFIGURED');
    }

    const mode = resolveMode(input.mode);
    const lookbackDays = clampLookbackDays(input.lookbackDays);
    const caps = samplingCaps(mode);
    const dimensions = resolveDimensions(input.dimensions);

    const agent = await Agent.findOne({
      where: {
        id: input.agentId,
        userId: input.userId,
        projectId: input.projectId,
        environmentId: input.environmentId,
      },
      attributes: ['id', 'name', 'userId', 'projectId', 'environmentId', 'createdAt', 'updatedAt'],
    });

    if (!agent) {
      throw new Error('AGENT_NOT_FOUND');
    }

    const windowEnd = new Date();
    const windowStart = new Date(windowEnd);
    windowStart.setUTCDate(windowStart.getUTCDate() - lookbackDays);

    const run = await AgentAnalysisRun.create({
      userId: input.userId,
      projectId: input.projectId,
      environmentId: input.environmentId,
      agentId: input.agentId,
      status: 'running',
      windowStart,
      windowEnd,
      startedAt: new Date(),
      summary: {
        analysisVersion: 'agent-judge-v2',
        mode,
        lookbackDays,
        dimensions,
        judgeModel: input.judgeModel || 'default',
      },
    });

    let snapshotStatus: 'running' | 'completed' | 'failed' = 'running';
    let snapshotTraceCount = 0;
    let snapshotEventCount = 0;
    let snapshotSummary: Record<string, any> = {
      analysisVersion: 'agent-judge-v2',
      mode,
      lookbackDays,
      dimensions,
      judgeModel: input.judgeModel || 'default',
    };
    let snapshotError: string | null = null;
    let snapshotFinishedAt: Date | null = null;
    const snapshotSections: Record<string, any> = {};
    const snapshotFindings: Array<Record<string, any>> = [];

    const buildSnapshot = (): AgentAnalysisResult => ({
      id: run.id,
      configId: run.configId || null,
      agentId: run.agentId,
      status: snapshotStatus,
      traceCount: snapshotTraceCount,
      eventCount: snapshotEventCount,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      summary: snapshotSummary,
      error: snapshotError,
      startedAt: run.startedAt ? run.startedAt.toISOString() : null,
      finishedAt: snapshotFinishedAt ? snapshotFinishedAt.toISOString() : null,
      createdAt: run.createdAt.toISOString(),
      updatedAt: (snapshotFinishedAt || run.updatedAt || run.createdAt).toISOString(),
      sections: Object.keys(snapshotSections).length > 0 ? snapshotSections : undefined,
      findings: snapshotFindings.length > 0 ? snapshotFindings : undefined,
    });

    const checkpoints = createJudgeCheckpointEmitter<AgentAnalysisResult>({
      handler: input.onCheckpoint,
      getSnapshot: buildSnapshot,
    });

    await checkpoints.checkpoint('request.accepted', {
      agentId: input.agentId,
      mode,
      lookbackDays,
      dimensions,
      judgeModel: input.judgeModel || 'default',
      caps,
    });

    try {
      await checkpoints.checkpoint('versions.load.started');
      const versions = await Entity.findAll({
        where: {
          agentId: input.agentId,
          userId: input.userId,
          projectId: input.projectId,
          environmentId: input.environmentId,
        },
        attributes: ['id'],
      });
      const entityIds = versions.map((v) => v.id);
      await checkpoints.checkpoint('versions.load.completed', {
        versionCount: entityIds.length,
      });

      const previousCompletedRun = await AgentAnalysisRun.findOne({
        where: {
          agentId: input.agentId,
          userId: input.userId,
          projectId: input.projectId,
          environmentId: input.environmentId,
          status: 'completed',
        },
        order: [['createdAt', 'DESC']],
      });

      const previousSections =
        previousCompletedRun &&
        (await AgentAnalysisSection.findAll({
          where: { runId: previousCompletedRun.id },
          attributes: ['sectionKey', 'payload'],
        }));

      const previousSectionMap = new Map(
        (previousSections || []).map((section) => [section.sectionKey, section.payload || {}])
      );

      await checkpoints.checkpoint('previous_run.loaded', {
        hasPreviousRun: Boolean(previousCompletedRun),
        previousSectionCount: previousSections?.length || 0,
      });

      if (entityIds.length === 0) {
        const emptySections = buildEmptySections(dimensions);

        await AgentAnalysisSection.bulkCreate(
          Object.entries(emptySections).map(([sectionKey, payload]) => ({
            runId: run.id,
            sectionKey,
            payload,
          }))
        );

        for (const [sectionKey, payload] of Object.entries(emptySections)) {
          snapshotSections[sectionKey] = payload;
        }

        const finalSummary = {
          ...snapshotSummary,
          note: 'No entity versions or traces available in selected window',
          sectionCount: Object.keys(emptySections).length,
          dimensionCount: dimensions.length,
          findingCount: 0,
        };

        await run.update({
          status: 'completed',
          finishedAt: new Date(),
          traceCount: 0,
          eventCount: 0,
          summary: finalSummary,
        });

        snapshotStatus = 'completed';
        snapshotSummary = finalSummary;
        snapshotFinishedAt = new Date();

        await checkpoints.checkpoint('analysis.completed', {
          sectionCount: Object.keys(emptySections).length,
          traceCount: 0,
          eventCount: 0,
          findingCount: 0,
        });

        return buildSnapshot();
      }

      await checkpoints.checkpoint('overview.compute.started');
      const overviewRows = await AgentAnalysisRun.sequelize!.query<any>(
        `
          WITH filtered AS (
            SELECT e.*
            FROM trace_events e
            JOIN traces t ON t.id = e.trace_id
            WHERE t.entity_id IN (:entityIds)
              AND e.timestamp >= :windowStart
              AND e.timestamp < :windowEnd
          )
          SELECT
            COUNT(*)::bigint AS "totalEvents",
            COUNT(DISTINCT trace_id)::bigint AS "totalTraces",
            COUNT(DISTINCT DATE_TRUNC('day', timestamp AT TIME ZONE 'UTC'))::bigint AS "activeDays",
            COALESCE(SUM(CASE WHEN event_type = 'error' THEN 1 ELSE 0 END), 0)::bigint AS "errorEvents",
            ROUND(AVG(CASE WHEN event_type = 'llm_response' THEN ${latencyMsExpr} END), 2) AS "avgLatencyMs",
            ROUND((percentile_cont(0.5) WITHIN GROUP (ORDER BY CASE WHEN event_type = 'llm_response' THEN ${latencyMsExpr} END))::numeric, 2) AS "p50LatencyMs",
            ROUND((percentile_cont(0.9) WITHIN GROUP (ORDER BY CASE WHEN event_type = 'llm_response' THEN ${latencyMsExpr} END))::numeric, 2) AS "p90LatencyMs",
            COALESCE(SUM(CASE WHEN event_type = 'llm_response' THEN ${totalTokensExpr} ELSE 0 END), 0)::numeric AS "totalTokens",
            ROUND(AVG(CASE WHEN event_type = 'llm_response' THEN ${totalTokensExpr} END), 2) AS "avgTokensPerResponse",
            COUNT(*) FILTER (WHERE event_type = 'llm_response')::bigint AS "llmResponses",
            COUNT(*) FILTER (
              WHERE event_type = 'llm_response'
                AND (
                  (jsonb_typeof(content->'toolCalls') = 'array' AND jsonb_array_length(content->'toolCalls') > 0)
                  OR
                  (jsonb_typeof(content->'tool_calls') = 'array' AND jsonb_array_length(content->'tool_calls') > 0)
                )
            )::bigint AS "llmWithToolCalls"
          FROM filtered e
        `,
        {
          replacements: { entityIds, windowStart, windowEnd },
          type: QueryTypes.SELECT,
        }
      );
      const overviewBase = overviewRows[0] || {};
      await checkpoints.checkpoint('overview.compute.completed');

      await checkpoints.checkpoint('multi_turn.compute.started');
      const multiTurnRows = await AgentAnalysisRun.sequelize!.query<any>(
        `
          WITH per_trace AS (
            SELECT
              e.trace_id,
              COUNT(*) FILTER (WHERE e.event_type = 'user_message') AS user_message_count
            FROM trace_events e
            JOIN traces t ON t.id = e.trace_id
            WHERE t.entity_id IN (:entityIds)
              AND e.timestamp >= :windowStart
              AND e.timestamp < :windowEnd
            GROUP BY e.trace_id
          )
          SELECT
            COUNT(*) FILTER (WHERE user_message_count > 0)::bigint AS "tracesWithUserMessages",
            COUNT(*) FILTER (WHERE user_message_count > 1)::bigint AS "multiTurnTraces"
          FROM per_trace
        `,
        {
          replacements: { entityIds, windowStart, windowEnd },
          type: QueryTypes.SELECT,
        }
      );
      const multiTurnBase = multiTurnRows[0] || {};
      await checkpoints.checkpoint('multi_turn.compute.completed');

      const totalEvents = Number(overviewBase.totalEvents || 0);
      const totalTraces = Number(overviewBase.totalTraces || 0);
      const errorEvents = Number(overviewBase.errorEvents || 0);
      const llmResponses = Number(overviewBase.llmResponses || 0);
      const llmWithToolCalls = Number(overviewBase.llmWithToolCalls || 0);
      const tracesWithUserMessages = Number(multiTurnBase.tracesWithUserMessages || 0);
      const multiTurnTraces = Number(multiTurnBase.multiTurnTraces || 0);

      const baseOverview = {
        totalTraces,
        totalEvents,
        activeDays: Number(overviewBase.activeDays || 0),
        multiTurnRate:
          tracesWithUserMessages > 0
            ? Number(((multiTurnTraces / tracesWithUserMessages) * 100).toFixed(2))
            : 0,
        errorRate: totalEvents > 0 ? Number(((errorEvents / totalEvents) * 100).toFixed(2)) : 0,
        avgLatencyMs: overviewBase.avgLatencyMs === null ? null : Number(overviewBase.avgLatencyMs),
        p50LatencyMs: overviewBase.p50LatencyMs === null ? null : Number(overviewBase.p50LatencyMs),
        p90LatencyMs: overviewBase.p90LatencyMs === null ? null : Number(overviewBase.p90LatencyMs),
        totalTokens: Number(overviewBase.totalTokens || 0),
        avgTokensPerResponse:
          overviewBase.avgTokensPerResponse === null
            ? null
            : Number(overviewBase.avgTokensPerResponse),
        toolCallRate:
          llmResponses > 0
            ? Number(((llmWithToolCalls / llmResponses) * 100).toFixed(2))
            : 0,
      };
      let overview = baseOverview;
      snapshotTraceCount = totalTraces;
      snapshotEventCount = totalEvents;

      await checkpoints.checkpoint('overview.section.ready', {
        totalTraces,
        totalEvents,
        errorRate: baseOverview.errorRate,
      });

      await checkpoints.checkpoint('user_events.load.started');
      const userEventCountRows = await AgentAnalysisRun.sequelize!.query<{ count: string | number }>(
        `
          SELECT COUNT(*)::bigint AS count
          FROM trace_events e
          JOIN traces t ON t.id = e.trace_id
          WHERE t.entity_id IN (:entityIds)
            AND e.timestamp >= :windowStart
            AND e.timestamp < :windowEnd
            AND e.event_type = 'user_message'
        `,
        {
          replacements: { entityIds, windowStart, windowEnd },
          type: QueryTypes.SELECT,
        }
      );
      const totalUserEvents = Number(userEventCountRows[0]?.count || 0);

      const userEvents = await AgentAnalysisRun.sequelize!.query<EventLiteRow>(
        `
          SELECT
            e.trace_id AS "traceId",
            e.step_id AS "stepId",
            e.event_type AS "eventType",
            e.timestamp AS "timestamp",
            e.content AS "content",
            e.metadata AS "metadata"
          FROM trace_events e
          JOIN traces t ON t.id = e.trace_id
          WHERE t.entity_id IN (:entityIds)
            AND e.timestamp >= :windowStart
            AND e.timestamp < :windowEnd
            AND e.event_type = 'user_message'
          ORDER BY e.trace_id ASC, e.step_id ASC, e.timestamp ASC
          LIMIT :limit
        `,
        {
          replacements: {
            entityIds,
            windowStart,
            windowEnd,
            limit: caps.userEvents,
          },
          type: QueryTypes.SELECT,
        }
      );

      await checkpoints.checkpoint('user_events.load.completed', {
        totalUserEvents,
        loadedUserEvents: userEvents.length,
        truncated: totalUserEvents > userEvents.length,
      });

      await checkpoints.checkpoint('trace_stats.load.started');
      const traceStatsRows = await AgentAnalysisRun.sequelize!.query<TraceStatsRow>(
        `
          SELECT
            e.trace_id AS "traceId",
            COALESCE(SUM(CASE WHEN e.event_type = 'error' THEN 1 ELSE 0 END), 0) AS "errorCount",
            ROUND(AVG(CASE WHEN e.event_type = 'llm_response' THEN ${latencyMsExpr} END), 2) AS "avgLatencyMs"
          FROM trace_events e
          JOIN traces t ON t.id = e.trace_id
          WHERE t.entity_id IN (:entityIds)
            AND e.timestamp >= :windowStart
            AND e.timestamp < :windowEnd
          GROUP BY e.trace_id
        `,
        {
          replacements: { entityIds, windowStart, windowEnd },
          type: QueryTypes.SELECT,
        }
      );
      await checkpoints.checkpoint('trace_stats.load.completed', {
        traceStatsCount: traceStatsRows.length,
      });

      const traceStatsById = new Map(
        traceStatsRows.map((row) => [
          row.traceId,
          {
            errorCount: Number(row.errorCount || 0),
            avgLatencyMs: row.avgLatencyMs === null ? null : Number(row.avgLatencyMs),
          },
        ])
      );

      const perTraceQueries = new Map<string, string[]>();
      for (const event of userEvents) {
        const text = normalizeUserMessageText(extractTextNode(event.content));
        if (!text) continue;
        const existing = perTraceQueries.get(event.traceId) || [];
        existing.push(text);
        perTraceQueries.set(event.traceId, existing);
      }

      const initialQueryCounts = new Map<string, number>();
      const repeatedQueryCounts = new Map<string, number>();
      const followupQueryCounts = new Map<string, number>();
      const queryToTraceIds = new Map<string, Set<string>>();
      const clusterCounts = new Map<string, { count: number; sample: string }>();
      const followupIntentCategories = new Map<string, number>();
      const firstQueryIntentCategories = new Map<InitialIntentCategory, number>();
      const traceBehaviorById = new Map<
        string,
        {
          initialQuery: string;
          followups: string[];
          turnCount: number;
          hasFollowup: boolean;
          followupCount: number;
          hasError: boolean;
        }
      >();

      let tracesWithFollowups = 0;
      let tracesWithAnyUserMessage = 0;
      let followupCount = 0;
      let totalTurns = 0;
      let loopingTraces = 0;

      for (const [traceId, queries] of perTraceQueries.entries()) {
        if (queries.length === 0) continue;
        tracesWithAnyUserMessage += 1;
        totalTurns += queries.length;

        const initial = queries[0];
        initialQueryCounts.set(initial, (initialQueryCounts.get(initial) || 0) + 1);

        const clusterKey = normalizeQuery(initial);
        const cluster = clusterCounts.get(clusterKey);
        if (!cluster) {
          clusterCounts.set(clusterKey, { count: 1, sample: initial });
        } else {
          cluster.count += 1;
          clusterCounts.set(clusterKey, cluster);
        }

        const traceSet = queryToTraceIds.get(initial) || new Set<string>();
        traceSet.add(traceId);
        queryToTraceIds.set(initial, traceSet);

        for (const q of queries) {
          repeatedQueryCounts.set(q, (repeatedQueryCounts.get(q) || 0) + 1);
        }

        if (queries.length > 1) {
          tracesWithFollowups += 1;
          if (queries.length >= 4) loopingTraces += 1;

          for (let i = 1; i < queries.length; i += 1) {
            const followup = queries[i];
            followupCount += 1;
            followupQueryCounts.set(followup, (followupQueryCounts.get(followup) || 0) + 1);
          }
        }

        const traceStats = traceStatsById.get(traceId);
        traceBehaviorById.set(traceId, {
          initialQuery: truncateForDisplay(initial),
          followups: queries.slice(1).map((item) => truncateForDisplay(item, 220)).slice(0, 8),
          turnCount: queries.length,
          hasFollowup: queries.length > 1,
          followupCount: Math.max(0, queries.length - 1),
          hasError: Number(traceStats?.errorCount || 0) > 0,
        });
      }

      const highErrorQueries: Array<{ query: string; traceCount: number; errorRate: number }> = [];
      const highLatencyQueries: Array<{ query: string; traceCount: number; avgLatencyMs: number }> = [];

      for (const [query, traceSet] of queryToTraceIds.entries()) {
        const traceIds = [...traceSet];
        if (traceIds.length === 0) continue;
        let tracesWithErrors = 0;
        let totalLatency = 0;
        let latencyCount = 0;

        for (const traceId of traceIds) {
          const stats = traceStatsById.get(traceId);
          if (!stats) continue;
          if (stats.errorCount > 0) tracesWithErrors += 1;
          if (stats.avgLatencyMs !== null) {
            totalLatency += stats.avgLatencyMs;
            latencyCount += 1;
          }
        }

        const errorRate = traceIds.length > 0 ? (tracesWithErrors / traceIds.length) * 100 : 0;
        if (errorRate >= 20) {
          highErrorQueries.push({
            query: truncateForDisplay(query),
            traceCount: traceIds.length,
            errorRate: Number(errorRate.toFixed(2)),
          });
        }

        const avgLatency = latencyCount > 0 ? totalLatency / latencyCount : 0;
        if (baseOverview.p90LatencyMs !== null && avgLatency >= baseOverview.p90LatencyMs) {
          highLatencyQueries.push({
            query: truncateForDisplay(query),
            traceCount: traceIds.length,
            avgLatencyMs: Number(avgLatency.toFixed(2)),
          });
        }
      }

      highErrorQueries.sort((a, b) => b.errorRate - a.errorRate || b.traceCount - a.traceCount);
      highLatencyQueries.sort((a, b) => b.avgLatencyMs - a.avgLatencyMs || b.traceCount - a.traceCount);

      const topInitialQueries = topCounts(initialQueryCounts, caps.evidenceTopN).map((item) => ({
        query: truncateForDisplay(item.value),
        count: item.count,
      }));
      const topRepeatedQueries = topCounts(repeatedQueryCounts, caps.evidenceTopN).map((item) => ({
        query: truncateForDisplay(item.value),
        count: item.count,
      }));
      const topFollowups = topCounts(followupQueryCounts, caps.evidenceTopN).map((item) => ({
        query: truncateForDisplay(item.value),
        count: item.count,
      }));
      let topFirstQueryIntents: Array<{
        intent: InitialIntentCategory;
        count: number;
        share: number;
      }> = [];

      const topIntentClusters = [...clusterCounts.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, caps.evidenceTopN)
        .map(([clusterKey, data]) => ({
          clusterKey,
          sampleQuery: truncateForDisplay(data.sample),
          count: data.count,
        }));

      const conversationSamples = sampleEvenly(
        [...perTraceQueries.entries()].map(([traceId, queries]) => {
          const initialQuery = queries[0] || '';
          const followups = queries.slice(1);
          const traceStats = traceStatsById.get(traceId);
          return {
            traceId,
            initialQuery: initialQuery.slice(0, 260),
            followups: followups.map((q) => q.slice(0, 260)).slice(0, 4),
            turnCount: queries.length,
            errorCount: traceStats?.errorCount || 0,
            avgLatencyMs: traceStats?.avgLatencyMs || null,
          };
        }),
        caps.conversationSamples
      );

      const followupRate =
        tracesWithAnyUserMessage > 0
          ? Number(((tracesWithFollowups / tracesWithAnyUserMessage) * 100).toFixed(2))
          : 0;

      const avgTurnsPerTrace =
        tracesWithAnyUserMessage > 0
          ? Number((totalTurns / tracesWithAnyUserMessage).toFixed(2))
          : 0;

      let queryIntelligence: Record<string, any> = {
        topInitialQueries,
        topRepeatedQueries,
        topHighErrorQueries: highErrorQueries.slice(0, caps.evidenceTopN),
        topHighLatencyQueries: highLatencyQueries.slice(0, caps.evidenceTopN),
        firstQueryIntentCategories: Object.fromEntries(firstQueryIntentCategories),
        topFirstQueryIntents,
        firstQueryIntentOutcomes: [],
        topIntentsNeedingDevelopment: [],
        inputCoverage: {
          totalUserEvents,
          processedUserEvents: userEvents.length,
          truncated: totalUserEvents > userEvents.length,
        },
      };

      let followupIntentCategoryMap = Object.fromEntries(
        [...followupIntentCategories.entries()].map(([key, value]) => [key, Number(value)])
      );

      let followupIntelligence: Record<string, any> = {
        topFollowups,
        followupRate,
        followupCount,
        avgTurnsPerTrace,
        loopingTraces,
        intentCategories: followupIntentCategoryMap,
      };

      const previousIntentSection = previousSectionMap.get('intent_intelligence') as any;
      const previousIntentDistribution =
        previousIntentSection && typeof previousIntentSection.intentDistribution === 'object'
          ? previousIntentSection.intentDistribution
          : {};

      const totalIntentCount = topIntentClusters.reduce((sum, cluster) => sum + cluster.count, 0);
      const intentDistribution: Record<string, number> = {};
      for (const cluster of topIntentClusters) {
        intentDistribution[cluster.clusterKey] =
          totalIntentCount > 0
            ? Number(((cluster.count / totalIntentCount) * 100).toFixed(2))
            : 0;
      }

      let intentIntelligence: Record<string, any> = {
        topIntentClusters,
        intentDistribution,
        intentShiftVsPreviousRun: toDeltaMap(intentDistribution, previousIntentDistribution || {}),
      };

      await checkpoints.checkpoint('query_followup_intent.evidence.ready', {
        topInitialQueries: topInitialQueries.length,
        topFollowups: topFollowups.length,
        conversationSamples: conversationSamples.length,
      });

      await checkpoints.checkpoint('tools.compute.started');
      const toolRows = await AgentAnalysisRun.sequelize!.query<TopToolRow>(
        `
          SELECT
            COALESCE(e.metadata->>'tool', 'unknown') AS "toolName",
            COUNT(*)::bigint AS calls,
            COUNT(*) FILTER (
              WHERE LOWER(e.content::text) LIKE '%"error"%'
                OR LOWER(e.content::text) LIKE '%failed%'
                OR LOWER(e.content::text) LIKE '%exception%'
            )::bigint AS "likelyErrors",
            ROUND(AVG(
              NULLIF(
                REGEXP_REPLACE(
                  COALESCE(e.metadata->>'latencyMs', e.metadata->>'latency_ms', ''),
                  '[^0-9.]',
                  '',
                  'g'
                ),
                ''
              )::numeric
            ), 2) AS "avgLatencyMs",
            ROUND(AVG(LENGTH(e.content::text)), 2) AS "avgResponseBytes"
          FROM trace_events e
          JOIN traces t ON t.id = e.trace_id
          WHERE t.entity_id IN (:entityIds)
            AND e.timestamp >= :windowStart
            AND e.timestamp < :windowEnd
            AND e.event_type = 'tool_call_response'
          GROUP BY 1
          ORDER BY calls DESC
        `,
        {
          replacements: { entityIds, windowStart, windowEnd },
          type: QueryTypes.SELECT,
        }
      );

      const retryRows = await AgentAnalysisRun.sequelize!.query<ToolRetryRow>(
        `
          WITH per_trace_tool AS (
            SELECT
              e.trace_id,
              COALESCE(e.metadata->>'tool', 'unknown') AS tool_name,
              COUNT(*) AS call_count
            FROM trace_events e
            JOIN traces t ON t.id = e.trace_id
            WHERE t.entity_id IN (:entityIds)
              AND e.timestamp >= :windowStart
              AND e.timestamp < :windowEnd
              AND e.event_type = 'tool_call_response'
            GROUP BY 1, 2
          )
          SELECT
            tool_name AS "toolName",
            COALESCE(SUM(CASE WHEN call_count > 1 THEN call_count - 1 ELSE 0 END), 0)::bigint AS "retryCalls"
          FROM per_trace_tool
          GROUP BY 1
        `,
        {
          replacements: { entityIds, windowStart, windowEnd },
          type: QueryTypes.SELECT,
        }
      );

      const toolTraceRows = await AgentAnalysisRun.sequelize!.query<ToolTraceRow>(
        `
          SELECT
            e.trace_id AS "traceId",
            COUNT(*)::bigint AS "callCount"
          FROM trace_events e
          JOIN traces t ON t.id = e.trace_id
          WHERE t.entity_id IN (:entityIds)
            AND e.timestamp >= :windowStart
            AND e.timestamp < :windowEnd
            AND e.event_type = 'tool_call_response'
          GROUP BY 1
        `,
        {
          replacements: { entityIds, windowStart, windowEnd },
          type: QueryTypes.SELECT,
        }
      );

      const toolTraceUsageRows = await AgentAnalysisRun.sequelize!.query<ToolTraceUsageRow>(
        `
          SELECT
            e.trace_id AS "traceId",
            COALESCE(e.metadata->>'tool', 'unknown') AS "toolName",
            COUNT(*)::bigint AS "calls"
          FROM trace_events e
          JOIN traces t ON t.id = e.trace_id
          WHERE t.entity_id IN (:entityIds)
            AND e.timestamp >= :windowStart
            AND e.timestamp < :windowEnd
            AND e.event_type = 'tool_call_response'
          GROUP BY 1, 2
        `,
        {
          replacements: { entityIds, windowStart, windowEnd },
          type: QueryTypes.SELECT,
        }
      );

      const toolUtilizationRows = await AgentAnalysisRun.sequelize!.query<ToolOutputUtilizationRow>(
        `
          WITH tool_events AS (
            SELECT
              e.trace_id,
              e.timestamp
            FROM trace_events e
            JOIN traces t ON t.id = e.trace_id
            WHERE t.entity_id IN (:entityIds)
              AND e.timestamp >= :windowStart
              AND e.timestamp < :windowEnd
              AND e.event_type = 'tool_call_response'
          )
          SELECT
            COUNT(*)::bigint AS "totalToolResponses",
            COUNT(*) FILTER (
              WHERE EXISTS (
                SELECT 1
                FROM trace_events e2
                WHERE e2.trace_id = tool_events.trace_id
                  AND e2.timestamp >= tool_events.timestamp
                  AND e2.event_type = 'llm_response'
              )
            )::bigint AS "consumedToolResponses"
          FROM tool_events
        `,
        {
          replacements: { entityIds, windowStart, windowEnd },
          type: QueryTypes.SELECT,
        }
      );

      const retryMap = new Map(
        retryRows.map((row) => [row.toolName, Number(row.retryCalls || 0)])
      );

      const tools = toolRows.map((row) => {
        const calls = Number(row.calls || 0);
        const likelyErrors = Number(row.likelyErrors || 0);
        const successRate =
          calls > 0 ? Number((((calls - likelyErrors) / calls) * 100).toFixed(2)) : 0;
        return {
          toolName: row.toolName,
          calls,
          likelyErrors,
          likelySuccessRate: successRate,
          retries: retryMap.get(row.toolName) || 0,
          avgLatencyMs: row.avgLatencyMs === null ? null : Number(row.avgLatencyMs),
          avgResponseBytes: Number(row.avgResponseBytes || 0),
        };
      });

      const bestPerformingTools = [...tools]
        .filter((tool) => tool.calls >= 3)
        .sort(
          (a, b) =>
            b.likelySuccessRate - a.likelySuccessRate || a.retries - b.retries || b.calls - a.calls
        )
        .slice(0, 7);

      const expensiveTools = [...tools]
        .sort((a, b) => {
          const aCost = (a.avgLatencyMs || 0) + a.avgResponseBytes / 8;
          const bCost = (b.avgLatencyMs || 0) + b.avgResponseBytes / 8;
          return bCost - aCost;
        })
        .slice(0, 7);

      const traceToolCallMap = new Map(
        toolTraceRows.map((row) => [row.traceId, Number(row.callCount || 0)])
      );
      const traceToolsMap = new Map<string, Set<string>>();
      for (const row of toolTraceUsageRows) {
        const existing = traceToolsMap.get(row.traceId) || new Set<string>();
        existing.add(row.toolName || 'unknown');
        traceToolsMap.set(row.traceId, existing);
      }

      const traceClassificationEvidence = sampleEvenly(
        [...traceBehaviorById.entries()].map(([traceId, behavior]) => {
          const toolCallCount = Number(traceToolCallMap.get(traceId) || 0);
          return {
            traceId,
            initialQuery: behavior.initialQuery,
            followups: behavior.followups,
            turnCount: behavior.turnCount,
            hasError: behavior.hasError,
            hasToolCall: toolCallCount > 0,
            toolCallCount,
            toolsUsed: [...(traceToolsMap.get(traceId) || new Set<string>())].slice(0, 8),
          };
        }),
        caps.traceClassifications
      );

      await checkpoints.checkpoint('intent_routing.analysis.started', {
        candidateTraces: traceBehaviorById.size,
        sampledTraces: traceClassificationEvidence.length,
      });

      const traceClassificationMap = new Map<
        string,
        {
          initialIntent: InitialIntentCategory;
          followupIntents: Array<
            'clarification_needed' | 'missing_info' | 'correction' | 'retry_rephrase' | 'new_intent'
          >;
          needsRepairFollowup: boolean;
          expectedToolNeed: boolean;
          likelyResolved: boolean;
        }
      >();

      if (traceClassificationEvidence.length > 0) {
        const batches = chunkArray(
          traceClassificationEvidence,
          mode === 'quick' ? 30 : mode === 'deep' ? 55 : 40
        );

        for (const batch of batches) {
          const batchResult = await runAgentTraceIntentRoutingChain(
            {
              agentName: agent.name || 'Unnamed agent',
              mode,
              lookbackDays,
              windowStart: windowStart.toISOString(),
              windowEnd: windowEnd.toISOString(),
              tracesJson: JSON.stringify(batch),
            },
            input.judgeModel
          );

          const expectedTraceIds = new Set(batch.map((item) => item.traceId));
          const receivedTraceIds = new Set<string>();
          for (const item of batchResult.analyses || []) {
            if (!expectedTraceIds.has(item.traceId)) continue;
            receivedTraceIds.add(item.traceId);
            traceClassificationMap.set(item.traceId, {
              initialIntent: item.initialIntent,
              followupIntents: item.followupIntents || [],
              needsRepairFollowup: item.needsRepairFollowup,
              expectedToolNeed: item.expectedToolNeed,
              likelyResolved: item.likelyResolved,
            });
          }

          if (receivedTraceIds.size !== expectedTraceIds.size) {
            throw new Error(
              `TRACE_INTENT_ROUTING_INCOMPLETE:expected=${expectedTraceIds.size}:received=${receivedTraceIds.size}`
            );
          }
        }
      }

      let likelyToolNeededTraces = 0;
      let likelyToolNeededWithoutToolTraces = 0;
      const toolNeedWithoutToolQueryCounts = new Map<string, number>();
      const intentOutcomeAccumulator = new Map<
        InitialIntentCategory,
        {
          traces: number;
          withError: number;
          withFollowup: number;
          withTool: number;
          resolved: number;
          expectedTool: number;
          expectedToolMisses: number;
          arbitraryToolCalls: number;
        }
      >();
      const toolEffectivenessAccumulator = new Map<
        string,
        {
          traces: number;
          resolved: number;
          withError: number;
          withFollowup: number;
          arbitraryCalls: number;
        }
      >();
      let expectedToolTraces = 0;
      let expectedAndCalled = 0;
      let expectedButMissed = 0;
      let calledWithoutNeed = 0;
      let tracesWithAnyTool = 0;

      for (const [traceId, behavior] of traceBehaviorById.entries()) {
        const toolCalls = traceToolCallMap.get(traceId) || 0;
        const hasTool = toolCalls > 0;
        if (hasTool) tracesWithAnyTool += 1;

        const classified = traceClassificationMap.get(traceId);
        if (!classified) {
          throw new Error(`TRACE_INTENT_ROUTING_MISSING:${traceId}`);
        }
        const initialIntent: InitialIntentCategory = classified.initialIntent;
        const followupIntentList = classified.followupIntents;

        for (const category of followupIntentList) {
          followupIntentCategories.set(category, (followupIntentCategories.get(category) || 0) + 1);
        }
        firstQueryIntentCategories.set(
          initialIntent,
          (firstQueryIntentCategories.get(initialIntent) || 0) + 1
        );

        const needsRepairFollowup = classified.needsRepairFollowup;
        const expectedTool = classified.expectedToolNeed;
        const likelyResolved = classified.likelyResolved;

        if (expectedTool) {
          expectedToolTraces += 1;
          if (hasTool) expectedAndCalled += 1;
          else expectedButMissed += 1;
        } else if (hasTool) {
          calledWithoutNeed += 1;
        }

        const intentAcc = intentOutcomeAccumulator.get(initialIntent) || {
          traces: 0,
          withError: 0,
          withFollowup: 0,
          withTool: 0,
          resolved: 0,
          expectedTool: 0,
          expectedToolMisses: 0,
          arbitraryToolCalls: 0,
        };
        intentAcc.traces += 1;
        if (behavior.hasError) intentAcc.withError += 1;
        if (behavior.hasFollowup) intentAcc.withFollowup += 1;
        if (hasTool) intentAcc.withTool += 1;
        if (likelyResolved) intentAcc.resolved += 1;
        if (expectedTool) intentAcc.expectedTool += 1;
        if (expectedTool && !hasTool) intentAcc.expectedToolMisses += 1;
        if (!expectedTool && hasTool) intentAcc.arbitraryToolCalls += 1;
        intentOutcomeAccumulator.set(initialIntent, intentAcc);

        const traceTools = traceToolsMap.get(traceId) || new Set<string>();
        for (const toolName of traceTools) {
          const toolAcc = toolEffectivenessAccumulator.get(toolName) || {
            traces: 0,
            resolved: 0,
            withError: 0,
            withFollowup: 0,
            arbitraryCalls: 0,
          };
          toolAcc.traces += 1;
          if (likelyResolved) toolAcc.resolved += 1;
          if (behavior.hasError) toolAcc.withError += 1;
          if (behavior.hasFollowup) toolAcc.withFollowup += 1;
          if (!expectedTool) toolAcc.arbitraryCalls += 1;
          toolEffectivenessAccumulator.set(toolName, toolAcc);
        }

        if (expectedTool) {
          likelyToolNeededTraces += 1;
          if (toolCalls === 0) {
            likelyToolNeededWithoutToolTraces += 1;
            const queryKey = behavior.initialQuery;
            toolNeedWithoutToolQueryCounts.set(
              queryKey,
              (toolNeedWithoutToolQueryCounts.get(queryKey) || 0) + 1
            );
          }
        }
      }

      topFirstQueryIntents = [...firstQueryIntentCategories.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, caps.evidenceTopN)
        .map(([intent, count]) => ({
          intent,
          count,
          share:
            tracesWithAnyUserMessage > 0
              ? Number(((count / tracesWithAnyUserMessage) * 100).toFixed(2))
              : 0,
        }));

      followupIntentCategoryMap = Object.fromEntries(
        [...followupIntentCategories.entries()].map(([key, value]) => [key, Number(value)])
      );
      followupIntelligence = {
        ...followupIntelligence,
        intentCategories: followupIntentCategoryMap,
      };

      const topToolNeedWithoutToolQueries = topCounts(
        toolNeedWithoutToolQueryCounts,
        caps.evidenceTopN
      ).map((entry) => ({ query: entry.value, count: entry.count }));

      const toolNeedMissRate =
        likelyToolNeededTraces > 0
          ? Number(((likelyToolNeededWithoutToolTraces / likelyToolNeededTraces) * 100).toFixed(2))
          : 0;

      const routingRecall =
        expectedToolTraces > 0 ? Number(((expectedAndCalled / expectedToolTraces) * 100).toFixed(2)) : 0;
      const routingPrecision =
        tracesWithAnyTool > 0 ? Number((((tracesWithAnyTool - calledWithoutNeed) / tracesWithAnyTool) * 100).toFixed(2)) : 0;
      const arbitraryCallRate =
        tracesWithAnyTool > 0 ? Number(((calledWithoutNeed / tracesWithAnyTool) * 100).toFixed(2)) : 0;

      const firstQueryIntentOutcomes = [...intentOutcomeAccumulator.entries()]
        .map(([intent, acc]) => ({
          intent,
          traceCount: acc.traces,
          share:
            tracesWithAnyUserMessage > 0
              ? Number(((acc.traces / tracesWithAnyUserMessage) * 100).toFixed(2))
              : 0,
          errorRate: acc.traces > 0 ? Number(((acc.withError / acc.traces) * 100).toFixed(2)) : 0,
          followupRate: acc.traces > 0 ? Number(((acc.withFollowup / acc.traces) * 100).toFixed(2)) : 0,
          toolUsageRate: acc.traces > 0 ? Number(((acc.withTool / acc.traces) * 100).toFixed(2)) : 0,
          likelyResolvedRate:
            acc.traces > 0 ? Number(((acc.resolved / acc.traces) * 100).toFixed(2)) : 0,
          expectedToolMissRate:
            acc.expectedTool > 0
              ? Number(((acc.expectedToolMisses / acc.expectedTool) * 100).toFixed(2))
              : 0,
          arbitraryToolCallRate:
            acc.withTool > 0 ? Number(((acc.arbitraryToolCalls / acc.withTool) * 100).toFixed(2)) : 0,
        }))
        .sort((a, b) => b.traceCount - a.traceCount)
        .slice(0, caps.evidenceTopN);

      const topIntentsNeedingDevelopment = [...firstQueryIntentOutcomes]
        .map((item) => {
          const developmentNeedScore =
            item.errorRate * 0.35 +
            item.followupRate * 0.25 +
            (100 - item.likelyResolvedRate) * 0.25 +
            item.expectedToolMissRate * 0.15;

          const reasons: string[] = [];
          if (item.errorRate >= 20) reasons.push('high error rate');
          if (item.followupRate >= 45) reasons.push('high follow-up rate');
          if (item.likelyResolvedRate <= 55) reasons.push('low likely resolution');
          if (item.expectedToolMissRate >= 25) reasons.push('tool miss rate');

          return {
            intent: item.intent,
            traceCount: item.traceCount,
            developmentNeedScore: Number(developmentNeedScore.toFixed(2)),
            likelyResolvedRate: item.likelyResolvedRate,
            expectedToolMissRate: item.expectedToolMissRate,
            reasons,
          };
        })
        .sort((a, b) => b.developmentNeedScore - a.developmentNeedScore)
        .slice(0, 6);

      queryIntelligence = {
        ...queryIntelligence,
        firstQueryIntentCategories: Object.fromEntries(firstQueryIntentCategories),
        topFirstQueryIntents,
        firstQueryIntentOutcomes,
        topIntentsNeedingDevelopment,
      };

      await checkpoints.checkpoint('intent_routing.analysis.completed', {
        classifiedTraces: traceClassificationMap.size,
        topIntents: topFirstQueryIntents.length,
      });

      const toolEffectiveness = [...toolEffectivenessAccumulator.entries()]
        .map(([toolName, acc]) => ({
          toolName,
          traces: acc.traces,
          likelyResolvedRate:
            acc.traces > 0 ? Number(((acc.resolved / acc.traces) * 100).toFixed(2)) : 0,
          errorRate: acc.traces > 0 ? Number(((acc.withError / acc.traces) * 100).toFixed(2)) : 0,
          followupRate:
            acc.traces > 0 ? Number(((acc.withFollowup / acc.traces) * 100).toFixed(2)) : 0,
          arbitraryCallRate:
            acc.traces > 0 ? Number(((acc.arbitraryCalls / acc.traces) * 100).toFixed(2)) : 0,
        }))
        .filter((item) => item.traces > 0);

      const topResolvedTools = [...toolEffectiveness]
        .filter((item) => item.traces >= 3)
        .sort((a, b) => b.likelyResolvedRate - a.likelyResolvedRate || b.traces - a.traces)
        .slice(0, 7);

      const underperformingTools = [...toolEffectiveness]
        .filter((item) => item.traces >= 3)
        .sort(
          (a, b) =>
            b.errorRate + b.followupRate + b.arbitraryCallRate - (a.errorRate + a.followupRate + a.arbitraryCallRate)
        )
        .slice(0, 7);
      const mostUsedTools = [...toolEffectiveness]
        .sort((a, b) => b.traces - a.traces)
        .slice(0, 7);

      const toolUtilization = toolUtilizationRows[0] || {
        totalToolResponses: 0,
        consumedToolResponses: 0,
      };

      const totalToolResponses = Number(toolUtilization.totalToolResponses || 0);
      const consumedToolResponses = Number(toolUtilization.consumedToolResponses || 0);
      const utilizationRate =
        totalToolResponses > 0
          ? Number(((consumedToolResponses / totalToolResponses) * 100).toFixed(2))
          : 0;

      let toolIntelligence: Record<string, any> = {
        tools,
        bestPerformingTools,
        expensiveTools,
        routingSignals: {
          likelyToolNeededTraces,
          likelyToolNeededWithoutToolTraces,
          toolNeedMissRate,
          topToolNeedWithoutToolQueries,
        },
        routingAssessment: {
          expectedToolTraces,
          expectedAndCalled,
          expectedButMissed,
          calledWithoutNeed,
          routingRecall,
          routingPrecision,
          arbitraryCallRate,
        },
        effectiveness: {
          topResolvedTools,
          underperformingTools,
          mostUsedTools,
        },
        utilization: {
          totalToolResponses,
          consumedToolResponses,
          utilizationRate,
        },
      };
      await checkpoints.checkpoint('tools.compute.completed', {
        toolCount: tools.length,
        utilizationRate,
        routingRecall,
        arbitraryCallRate,
      });

      await checkpoints.checkpoint('quality.compute.started');
      const judgeRows = await AgentAnalysisRun.sequelize!.query<JudgeSummaryRow>(
        `
          WITH trace_scope AS (
            SELECT DISTINCT e.trace_id
            FROM trace_events e
            JOIN traces t ON t.id = e.trace_id
            WHERE t.entity_id IN (:entityIds)
              AND e.timestamp >= :windowStart
              AND e.timestamp < :windowEnd
          ),
          latest_per_trace AS (
            SELECT
              ta.trace_id,
              ta.summary,
              ROW_NUMBER() OVER (PARTITION BY ta.trace_id ORDER BY ta.created_at DESC) AS rn
            FROM trace_analyses ta
            JOIN trace_scope ts ON ts.trace_id = ta.trace_id
            WHERE ta.status = 'completed'
              AND ta.rubric_version = 'judge-v1'
          )
          SELECT summary
          FROM latest_per_trace
          WHERE rn = 1
          LIMIT :limit
        `,
        {
          replacements: { entityIds, windowStart, windowEnd, limit: caps.judgeSummaries },
          type: QueryTypes.SELECT,
        }
      );

      const reliabilityRows = await AgentAnalysisRun.sequelize!.query<ReliabilityRecoveryRow>(
        `
          WITH error_traces AS (
            SELECT
              e.trace_id,
              MAX(e.timestamp) AS last_error_at
            FROM trace_events e
            JOIN traces t ON t.id = e.trace_id
            WHERE t.entity_id IN (:entityIds)
              AND e.timestamp >= :windowStart
              AND e.timestamp < :windowEnd
              AND e.event_type = 'error'
            GROUP BY e.trace_id
          )
          SELECT
            COUNT(*)::bigint AS "tracesWithError",
            COUNT(*) FILTER (
              WHERE EXISTS (
                SELECT 1
                FROM trace_events e2
                WHERE e2.trace_id = error_traces.trace_id
                  AND e2.event_type = 'llm_response'
                  AND e2.timestamp > error_traces.last_error_at
              )
            )::bigint AS "recoveredTraces"
          FROM error_traces
        `,
        {
          replacements: { entityIds, windowStart, windowEnd },
          type: QueryTypes.SELECT,
        }
      );

      const dimensionAccumulator: Record<string, { sum: number; count: number }> = {};
      for (const dimension of TRACE_JUDGE_DIMENSIONS) {
        dimensionAccumulator[dimension] = { sum: 0, count: 0 };
      }
      for (const row of judgeRows) {
        const dimensionScores = row?.summary?.dimensionScores || {};
        for (const dimension of TRACE_JUDGE_DIMENSIONS) {
          const value = Number(dimensionScores?.[dimension]);
          if (!Number.isFinite(value) || value < 0) continue;
          dimensionAccumulator[dimension].sum += value;
          dimensionAccumulator[dimension].count += 1;
        }
      }

      const dimensionAverages: Record<string, number | null> = {};
      for (const dimension of TRACE_JUDGE_DIMENSIONS) {
        const acc = dimensionAccumulator[dimension];
        dimensionAverages[dimension] =
          acc.count > 0 ? Number((acc.sum / acc.count).toFixed(3)) : null;
      }

      const severityRows = await AgentAnalysisRun.sequelize!.query<SeverityRow>(
        `
          WITH trace_scope AS (
            SELECT DISTINCT e.trace_id
            FROM trace_events e
            JOIN traces t ON t.id = e.trace_id
            WHERE t.entity_id IN (:entityIds)
              AND e.timestamp >= :windowStart
              AND e.timestamp < :windowEnd
          )
          SELECT taf.severity, COUNT(*)::bigint AS count
          FROM trace_analysis_findings taf
          JOIN trace_analyses ta ON ta.id = taf.analysis_id
          JOIN trace_scope ts ON ts.trace_id = ta.trace_id
          WHERE ta.status = 'completed'
            AND ta.rubric_version = 'judge-v1'
          GROUP BY taf.severity
        `,
        {
          replacements: { entityIds, windowStart, windowEnd },
          type: QueryTypes.SELECT,
        }
      );

      const severityDistribution = Object.fromEntries(
        severityRows.map((row) => [row.severity, Number(row.count || 0)])
      );

      const previousQuality = previousSectionMap.get('quality_intelligence') as any;
      const previousDimensionAverages =
        previousQuality && typeof previousQuality.dimensionAverages === 'object'
          ? previousQuality.dimensionAverages
          : {};

      const dimensionTrendVsPreviousRun: Record<string, number | null> = {};
      for (const dimension of TRACE_JUDGE_DIMENSIONS) {
        const current = dimensionAverages[dimension];
        const previous = Number(previousDimensionAverages?.[dimension]);
        if (current === null || !Number.isFinite(previous)) {
          dimensionTrendVsPreviousRun[dimension] = null;
          continue;
        }
        dimensionTrendVsPreviousRun[dimension] = Number((current - previous).toFixed(3));
      }

      const reliability = reliabilityRows[0] || {
        tracesWithError: 0,
        recoveredTraces: 0,
      };
      const tracesWithError = Number(reliability.tracesWithError || 0);
      const recoveredTraces = Number(reliability.recoveredTraces || 0);
      const recoveryRate =
        tracesWithError > 0 ? Number(((recoveredTraces / tracesWithError) * 100).toFixed(2)) : 0;

      let qualityIntelligence: Record<string, any> = {
        analyzedTraceCount: judgeRows.length,
        sampled: true,
        sampleLimit: caps.judgeSummaries,
        dimensionAverages,
        dimensionTrendVsPreviousRun,
        severityDistribution,
        reliability: {
          tracesWithError,
          recoveredTraces,
          recoveryRate,
        },
      };
      await checkpoints.checkpoint('quality.compute.completed', {
        analyzedTraceCount: qualityIntelligence.analyzedTraceCount,
        recoveryRate,
      });

      await checkpoints.checkpoint('section_pipeline.chain.started');
      const traceClassificationSample = sampleEvenly(
        [...traceClassificationMap.entries()].map(([traceId, value]) => ({
          traceId,
          initialIntent: value.initialIntent,
          followupIntents: value.followupIntents,
          needsRepairFollowup: value.needsRepairFollowup,
          expectedToolNeed: value.expectedToolNeed,
          likelyResolved: value.likelyResolved,
        })),
        mode === 'quick' ? 60 : mode === 'deep' ? 220 : 120
      );

      const overviewEvidencePack = {
        rawOverview: baseOverview,
        rawSections: {
          query_intelligence: queryIntelligence,
          followup_intelligence: followupIntelligence,
          intent_intelligence: intentIntelligence,
          tool_intelligence: toolIntelligence,
          quality_intelligence: qualityIntelligence,
        },
        conversationSamples,
        traceClassificationSample,
        dataCoverage: {
          totalUserEvents,
          processedUserEvents: userEvents.length,
          userEventsTruncated: totalUserEvents > userEvents.length,
        },
      };

      const sectionChainOutput = await runAgentOverviewAnalysisChain(
        {
          agentName: agent.name || 'Unnamed agent',
          mode,
          lookbackDays,
          windowStart: windowStart.toISOString(),
          windowEnd: windowEnd.toISOString(),
          overviewJson: JSON.stringify(baseOverview),
          evidenceJson: JSON.stringify(overviewEvidencePack),
        },
        input.judgeModel
      );

      overview = {
        totalTraces: Number(sectionChainOutput.overview.totalTraces),
        totalEvents: Number(sectionChainOutput.overview.totalEvents),
        activeDays: Number(sectionChainOutput.overview.activeDays),
        multiTurnRate: Number(sectionChainOutput.overview.multiTurnRate),
        errorRate: Number(sectionChainOutput.overview.errorRate),
        avgLatencyMs:
          sectionChainOutput.overview.avgLatencyMs === null
            ? null
            : Number(sectionChainOutput.overview.avgLatencyMs),
        p50LatencyMs:
          sectionChainOutput.overview.p50LatencyMs === null
            ? null
            : Number(sectionChainOutput.overview.p50LatencyMs),
        p90LatencyMs:
          sectionChainOutput.overview.p90LatencyMs === null
            ? null
            : Number(sectionChainOutput.overview.p90LatencyMs),
        totalTokens: Number(sectionChainOutput.overview.totalTokens),
        avgTokensPerResponse:
          sectionChainOutput.overview.avgTokensPerResponse === null
            ? null
            : Number(sectionChainOutput.overview.avgTokensPerResponse),
        toolCallRate: Number(sectionChainOutput.overview.toolCallRate),
      };

      queryIntelligence = {
        ...sectionChainOutput.query_intelligence,
        firstQueryIntentCategories: countArrayToRecord(
          sectionChainOutput.query_intelligence.firstQueryIntentCategories
        ),
        inputCoverage: {
          totalUserEvents,
          processedUserEvents: userEvents.length,
          truncated: totalUserEvents > userEvents.length,
        },
      };

      followupIntelligence = {
        ...sectionChainOutput.followup_intelligence,
        intentCategories: countArrayToRecord(sectionChainOutput.followup_intelligence.intentCategories),
      };

      intentIntelligence = {
        ...sectionChainOutput.intent_intelligence,
        intentDistribution: numberArrayToRecord(sectionChainOutput.intent_intelligence.intentDistribution),
        intentShiftVsPreviousRun: deltaArrayToRecord(
          sectionChainOutput.intent_intelligence.intentShiftVsPreviousRun
        ),
      };

      toolIntelligence = {
        ...sectionChainOutput.tool_intelligence,
      };

      qualityIntelligence = {
        ...sectionChainOutput.quality_intelligence,
        dimensionAverages: numberArrayToRecord(sectionChainOutput.quality_intelligence.dimensionAverages),
        dimensionTrendVsPreviousRun: deltaArrayToRecord(
          sectionChainOutput.quality_intelligence.dimensionTrendVsPreviousRun
        ),
        severityDistribution: countArrayToRecord(
          sectionChainOutput.quality_intelligence.severityDistribution
        ),
      };

      snapshotSections.overview = overview;
      snapshotSections.query_intelligence = queryIntelligence;
      snapshotSections.followup_intelligence = followupIntelligence;
      snapshotSections.intent_intelligence = intentIntelligence;
      snapshotSections.tool_intelligence = toolIntelligence;
      snapshotSections.quality_intelligence = qualityIntelligence;

      await checkpoints.checkpoint('section_pipeline.chain.completed', {
        topInitialQueries: queryIntelligence.topInitialQueries?.length || 0,
        topIntents: queryIntelligence.topFirstQueryIntents?.length || 0,
        toolCount: toolIntelligence.tools?.length || 0,
      });

      await checkpoints.checkpoint('dimensions.analysis.started', {
        dimensionCount: dimensions.length,
      });

      const dimensionResults: AgentDimensionAnalysisResult[] = [];
      const dimensionFailures: Record<string, string> = {};

      const extraSignals = {
        coverage: {
          totalUserEvents,
          processedUserEvents: userEvents.length,
          userEventsTruncated: totalUserEvents > userEvents.length,
        },
      };

      for (const dimension of dimensions) {
        await checkpoints.checkpoint(`dimensions.${dimension}.started`);

        const evidenceBundle = buildDimensionEvidenceBundle({
          dimension,
          overview,
          queryIntelligence,
          followupIntelligence,
          intentIntelligence,
          toolIntelligence,
          qualityIntelligence,
          conversationSamples,
          extraSignals,
        });

        try {
          const raw = await runAgentDimensionAnalysisChain(
            {
              dimension,
              rubric: DIMENSION_RUBRICS[dimension],
              agentName: agent.name || 'Unnamed agent',
              mode,
              lookbackDays,
              windowStart: windowStart.toISOString(),
              windowEnd: windowEnd.toISOString(),
              overviewJson: JSON.stringify(overview),
              evidenceJson: JSON.stringify(evidenceBundle),
            },
            input.judgeModel
          );

          const normalized = normalizeDimensionResult(dimension, raw);
          dimensionResults.push(normalized);

          await checkpoints.checkpoint(`dimensions.${dimension}.completed`, {
            score: normalized.score,
            severity: normalized.severity,
            issueCount: normalized.issues.length,
          });
        } catch (error: any) {
          const reason = error?.message || 'UNKNOWN_DIMENSION_ERROR';
          await checkpoints.checkpoint(`dimensions.${dimension}.failed`, {
            errorMessage: reason,
          });
          throw new Error(`DIMENSION_CHAIN_FAILED:${dimension}:${reason}`);
        }
      }

      await checkpoints.checkpoint('dimensions.analysis.completed', {
        completedDimensions: dimensionResults.length,
        failedDimensions: Object.keys(dimensionFailures).length,
      });

      const flattenedFindings = flattenIssues(dimensionResults).sort(
        (a, b) =>
          severityRank(b.severity) - severityRank(a.severity) ||
          b.impactScore * Math.max(1, b.frequency) - a.impactScore * Math.max(1, a.frequency)
      );

      await checkpoints.checkpoint('findings.persist.started', {
        findingCount: flattenedFindings.length,
      });

      if (flattenedFindings.length > 0) {
        await AgentAnalysisFinding.bulkCreate(
          flattenedFindings.map((finding) => ({
            runId: run.id,
            dimension: finding.dimension,
            code: finding.code,
            title: finding.title,
            detail: finding.detail,
            severity: finding.severity,
            confidence: finding.confidence,
            frequency: finding.frequency,
            impactScore: finding.impactScore,
            evidence: finding.evidence,
            rootCause: finding.rootCause,
            recommendation: finding.recommendation,
            patches: finding.patches,
          }))
        );
      }

      await checkpoints.checkpoint('findings.persist.completed', {
        findingCount: flattenedFindings.length,
      });

      await checkpoints.checkpoint('synthesis.started');
      const synthesis: AgentSynthesisResult = await runAgentSynthesisChain(
        {
          agentName: agent.name || 'Unnamed agent',
          mode,
          lookbackDays,
          windowStart: windowStart.toISOString(),
          windowEnd: windowEnd.toISOString(),
          overviewJson: JSON.stringify(overview),
          toolSignalsJson: JSON.stringify(toolIntelligence),
          qualitySignalsJson: JSON.stringify(qualityIntelligence),
          dimensionResultsJson: JSON.stringify(dimensionResults),
          issuesJson: JSON.stringify(flattenedFindings.slice(0, 120)),
        },
        input.judgeModel
      );

      await checkpoints.checkpoint('synthesis.completed', {
        actionItems: synthesis.actionPlan.items.length,
        experiments: synthesis.experiments.items.length,
      });

      const findingSeverityCounts = summarizeSeverityCounts(flattenedFindings);

      const scoresByDimension = Object.fromEntries(
        dimensionResults.map((result) => [result.dimension, Number(result.score.toFixed(3))])
      );

      const previousDimensionScoreSection = previousSectionMap.get('dimension_scores') as any;
      const previousScoresByDimension =
        previousDimensionScoreSection &&
        typeof previousDimensionScoreSection.scoresByDimension === 'object'
          ? previousDimensionScoreSection.scoresByDimension
          : {};

      const trendVsPreviousRun: Record<string, number | null> = {};
      for (const dimension of dimensions) {
        const current = Number(scoresByDimension[dimension]);
        const previous = Number(previousScoresByDimension[dimension]);
        if (!Number.isFinite(current) || !Number.isFinite(previous)) {
          trendVsPreviousRun[dimension] = null;
          continue;
        }
        trendVsPreviousRun[dimension] = Number((current - previous).toFixed(3));
      }

      const overallScore =
        dimensionResults.length > 0
          ? Number(
              (
                dimensionResults.reduce((sum, result) => sum + Number(result.score || 0), 0) /
                dimensionResults.length
              ).toFixed(3)
            )
          : 0;

      const dimensionScores = {
        overallScore,
        scoresByDimension,
        trendVsPreviousRun,
        dimensions: dimensionResults.map((result) => ({
          dimension: result.dimension,
          score: result.score,
          severity: result.severity,
          confidence: result.confidence,
          summary: result.summary,
          issueCount: result.issues.length,
          strengths: result.strengths,
          weaknesses: result.weaknesses,
        })),
        totalIssues: flattenedFindings.length,
        bySeverity: findingSeverityCounts,
        failures: dimensionFailures,
      };

      const dimensionDeepDive = {
        dimensions: Object.fromEntries(
          dimensionResults.map((result) => [result.dimension, result])
        ),
      };

      const failureTaxonomy = {
        ...synthesis.failureTaxonomy,
        totalFindings: flattenedFindings.length,
        bySeverity: findingSeverityCounts,
      };

      const toolDiagnostics = {
        ...synthesis.toolDiagnostics,
        usageSummary: {
          toolCount: tools.length,
          bestPerformingTools,
          expensiveTools,
          routingSignals: toolIntelligence.routingSignals,
          utilization: toolIntelligence.utilization,
        },
      };

      await checkpoints.checkpoint('section_insights.started');
      const sectionInsights = await runAgentSectionInsightsChain(
        {
          agentName: agent.name || 'Unnamed agent',
          mode,
          lookbackDays,
          windowStart: windowStart.toISOString(),
          windowEnd: windowEnd.toISOString(),
          overviewJson: JSON.stringify(overview),
          queryIntelligenceJson: JSON.stringify(queryIntelligence),
          followupIntelligenceJson: JSON.stringify(followupIntelligence),
          qualityIntelligenceJson: JSON.stringify(qualityIntelligence),
          dimensionScoresJson: JSON.stringify(dimensionScores),
        },
        input.judgeModel
      );

      await checkpoints.checkpoint('section_insights.completed');

      const recommendationItems = synthesis.actionPlan.items.length
        ? synthesis.actionPlan.items.slice(0, 12).map((item, index) => ({
            priority: index + 1,
            title: item.title,
            detail: item.why,
            category: item.fixType,
            severity: item.severity,
          }))
        : flattenedFindings.slice(0, 8).map((finding, index) =>
            recommendation(
              index + 1,
              finding.title,
              finding.recommendation.detail,
              finding.recommendation.fixType,
              finding.severity
            )
          );

      const sections = {
        overview,
        query_intelligence: {
          ...queryIntelligence,
          llmInsights: sectionInsights.query,
        },
        followup_intelligence: {
          ...followupIntelligence,
          llmInsights: sectionInsights.followup,
        },
        intent_intelligence: intentIntelligence,
        tool_intelligence: toolIntelligence,
        quality_intelligence: {
          ...qualityIntelligence,
          llmInsights: sectionInsights.quality,
        },
        dimension_scores: dimensionScores,
        dimension_deep_dive: dimensionDeepDive,
        failure_taxonomy: failureTaxonomy,
        tool_diagnostics: toolDiagnostics,
        action_plan: synthesis.actionPlan,
        experiments: synthesis.experiments,
        recommendations: { items: recommendationItems },
      };

      for (const [sectionKey, payload] of Object.entries(sections)) {
        snapshotSections[sectionKey] = payload;
      }

      for (const finding of flattenedFindings.slice(0, 300)) {
        snapshotFindings.push({
          dimension: finding.dimension,
          code: finding.code,
          title: finding.title,
          detail: finding.detail,
          severity: finding.severity,
          confidence: finding.confidence,
          frequency: finding.frequency,
          impactScore: finding.impactScore,
          evidence: finding.evidence,
          rootCause: finding.rootCause,
          recommendation: finding.recommendation,
          patches: finding.patches,
        });
      }

      await checkpoints.checkpoint('sections.persist.started', {
        sectionCount: Object.keys(sections).length,
      });

      await AgentAnalysisSection.bulkCreate(
        Object.entries(sections).map(([sectionKey, payload]) => ({
          runId: run.id,
          sectionKey,
          payload,
        }))
      );

      await checkpoints.checkpoint('sections.persist.completed', {
        sectionCount: Object.keys(sections).length,
      });

      const finalSummary = {
        analysisVersion: 'agent-judge-v2',
        mode,
        lookbackDays,
        dimensions,
        dimensionCount: dimensions.length,
        judgeModel: input.judgeModel || 'default',
        sectionCount: Object.keys(sections).length,
        overallScore,
        findingCount: flattenedFindings.length,
        bySeverity: findingSeverityCounts,
        failedDimensions: dimensionFailures,
        dataCoverage: {
          totalUserEvents,
          processedUserEvents: userEvents.length,
          userEventsTruncated: totalUserEvents > userEvents.length,
        },
      };

      await run.update({
        status: 'completed',
        finishedAt: new Date(),
        traceCount: totalTraces,
        eventCount: totalEvents,
        summary: finalSummary,
      });

      snapshotStatus = 'completed';
      snapshotSummary = finalSummary;
      snapshotFinishedAt = new Date();

      await checkpoints.checkpoint('analysis.completed', {
        traceCount: totalTraces,
        eventCount: totalEvents,
        sectionCount: Object.keys(sections).length,
        findingCount: flattenedFindings.length,
      });

      return buildSnapshot();
    } catch (error: any) {
      logger.error(
        { error, runId: run.id, agentId: input.agentId },
        'Agent analysis run failed'
      );

      await run.update({
        status: 'failed',
        finishedAt: new Date(),
        error: error?.message || 'UNKNOWN_ERROR',
        summary: {
          ...(run.summary || {}),
          error: error?.message || 'UNKNOWN_ERROR',
        },
      });

      snapshotStatus = 'failed';
      snapshotError = error?.message || 'UNKNOWN_ERROR';
      snapshotFinishedAt = new Date();
      snapshotSummary = {
        ...snapshotSummary,
        error: snapshotError,
      };

      await checkpoints.checkpoint('analysis.failed', {
        errorMessage: snapshotError,
      });

      throw error;
    }
  }

  static async getLatestRun(
    agentId: string,
    scope: { userId: string; projectId: string; environmentId: string }
  ) {
    const run = await AgentAnalysisRun.findOne({
      where: {
        agentId,
        userId: scope.userId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      },
      order: [['createdAt', 'DESC']],
    });
    if (!run) return null;
    return this.getRunById(run.id, scope);
  }

  static async listRunsForAgent(
    agentId: string,
    scope: {
      userId: string;
      projectId: string;
      environmentId: string;
      count?: number;
      page?: number;
    }
  ) {
    const count = Math.min(Math.max(scope.count || 20, 1), 100);
    const page = Math.max(scope.page || 1, 1);
    const offset = (page - 1) * count;

    const { rows, count: total } = await AgentAnalysisRun.findAndCountAll({
      where: {
        agentId,
        userId: scope.userId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      },
      order: [['createdAt', 'DESC']],
      limit: count,
      offset,
    });

    const runs = rows.map((run) => this.serializeRun(run, undefined, undefined));

    return {
      runs,
      pagination: {
        total,
        count,
        page,
        totalPages: Math.ceil(total / count),
        hasMore: page * count < total,
      },
    };
  }

  static async getRunById(
    runId: string,
    scope: { userId: string; projectId: string; environmentId: string }
  ) {
    const run = await AgentAnalysisRun.findOne({
      where: {
        id: runId,
        userId: scope.userId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      },
    });
    if (!run) return null;

    const [sections, findings] = await Promise.all([
      AgentAnalysisSection.findAll({
        where: { runId: run.id },
        order: [['createdAt', 'ASC']],
      }),
      AgentAnalysisFinding.findAll({
        where: { runId: run.id },
        order: [
          ['impactScore', 'DESC'],
          ['frequency', 'DESC'],
          ['createdAt', 'ASC'],
        ],
      }),
    ]);

    const sectionMap: Record<string, any> = {};
    for (const section of sections) {
      sectionMap[section.sectionKey] = section.payload || {};
    }

    return this.serializeRun(
      run,
      sectionMap,
      findings.map((finding) => ({
        id: finding.id,
        runId: finding.runId,
        dimension: finding.dimension,
        code: finding.code,
        title: finding.title,
        detail: finding.detail,
        severity: finding.severity,
        confidence: finding.confidence,
        frequency: finding.frequency,
        impactScore: finding.impactScore,
        evidence: finding.evidence || [],
        rootCause: finding.rootCause || null,
        recommendation: finding.recommendation || {},
        patches: finding.patches || [],
        createdAt: finding.createdAt?.toISOString?.() || finding.createdAt,
        updatedAt: finding.updatedAt?.toISOString?.() || finding.updatedAt,
      }))
    );
  }

  private static serializeConfig(config: AgentAnalysisConfig): AgentAnalysisConfigResult {
    return {
      id: config.id,
      agentId: config.agentId,
      enabled: config.enabled,
      cronExpr: config.cronExpr,
      timezone: config.timezone,
      lookbackDays: config.lookbackDays,
      samplingConfig: config.samplingConfig || {},
      lastRunAt: toIso(config.lastRunAt),
      nextRunAt: toIso(config.nextRunAt),
      createdAt: toIso(config.createdAt) || new Date(0).toISOString(),
      updatedAt: toIso(config.updatedAt) || new Date(0).toISOString(),
    };
  }

  private static serializeRun(
    run: AgentAnalysisRun,
    sections?: Record<string, any>,
    findings?: Array<Record<string, any>>
  ): AgentAnalysisResult {
    return {
      id: run.id,
      configId: run.configId || null,
      agentId: run.agentId,
      status: run.status,
      traceCount: run.traceCount,
      eventCount: run.eventCount,
      windowStart: toIso(run.windowStart) || new Date(0).toISOString(),
      windowEnd: toIso(run.windowEnd) || new Date(0).toISOString(),
      summary: run.summary || {},
      error: run.error || null,
      startedAt: toIso(run.startedAt),
      finishedAt: toIso(run.finishedAt),
      createdAt: toIso(run.createdAt) || new Date(0).toISOString(),
      updatedAt: toIso(run.updatedAt) || new Date(0).toISOString(),
      sections: sections || undefined,
      findings: findings && findings.length > 0 ? findings : undefined,
    };
  }
}
