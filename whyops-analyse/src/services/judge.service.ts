import { createServiceLogger } from '@whyops/shared/logger';
import {
  Entity,
  LLMEvent,
  Trace,
  TraceAnalysis,
  TraceAnalysisFinding,
} from '@whyops/shared/models';
import {
  THRESHOLDS,
  runStepCorrectnessChain,
  runToolChoiceChain,
  runPromptQualityChain,
  runToolDescriptionChain,
  runCostEfficiencyChain,
  filterToolsForJudge,
  type ToolDefinition,
  type StepCorrectnessResult,
  type ToolChoiceResult,
  type PromptQualityResult,
  type ToolDescriptionResult,
  type CostEfficiencyResult,
  extractJudgeErrorDiagnostics,
  isInvalidModelNameError,
} from '../langchain';
import env from '@whyops/shared/env';
import {
  createJudgeCheckpointEmitter,
  type JudgeCheckpointEmitter,
  type JudgeCheckpointHandler,
} from './judge-checkpoints';

const logger = createServiceLogger('analyse:judge-service');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type JudgeDimension =
  | 'step_correctness'
  | 'tool_choice'
  | 'prompt_quality'
  | 'tool_description'
  | 'cost_efficiency';

export const ALL_DIMENSIONS: JudgeDimension[] = [
  'step_correctness',
  'tool_choice',
  'prompt_quality',
  'tool_description',
  'cost_efficiency',
];

export interface RunJudgeInput {
  traceId: string;
  userId: string;
  dimensions?: JudgeDimension[];
  judgeModel?: string;
  mode?: 'quick' | 'standard' | 'deep';
  onCheckpoint?: JudgeCheckpointHandler<JudgeResult>;
}

type JudgeMode = 'quick' | 'standard' | 'deep';

interface JudgeExecutionProfile {
  stepCorrectnessMaxResponses?: number;
  toolChoiceMaxSteps?: number;
  promptQualityMaxBlocks?: number;
  promptQualitySkipSynthesis: boolean;
  promptQualityBlockEvalConcurrency?: number;
  toolDescriptionMaxTools?: number;
  costEfficiencyMaxResponses?: number;
}

const JUDGE_MODE_PROFILES: Record<JudgeMode, JudgeExecutionProfile> = {
  quick: {
    stepCorrectnessMaxResponses: 8,
    toolChoiceMaxSteps: 3,
    promptQualityMaxBlocks: 24,
    promptQualitySkipSynthesis: true,
    promptQualityBlockEvalConcurrency: 4,
    toolDescriptionMaxTools: 12,
    costEfficiencyMaxResponses: 10,
  },
  standard: {
    stepCorrectnessMaxResponses: 20,
    toolChoiceMaxSteps: 8,
    promptQualityMaxBlocks: 96,
    promptQualitySkipSynthesis: false,
    promptQualityBlockEvalConcurrency: 6,
    toolDescriptionMaxTools: 30,
    costEfficiencyMaxResponses: 20,
  },
  deep: {
    promptQualitySkipSynthesis: false,
  },
};

interface DimensionScore {
  dimension: JudgeDimension;
  score: number;
  issueCount: number;
  patchCount: number;
  skipped: boolean;
  skipReason?: string;
}

export interface JudgeResult {
  id: string;
  traceId: string;
  status: string;
  rubricVersion: string;
  judgeModel: string;
  mode: string;
  summary: {
    overallScore: number;
    dimensionScores: Record<string, number>;
    totalIssues: number;
    totalPatches: number;
    bySeverity: Record<string, number>;
    dimensionDetails: DimensionScore[];
  };
  findings: any[];
}

// ---------------------------------------------------------------------------
// Helpers: format trace data for LLM consumption
// ---------------------------------------------------------------------------

function formatTraceSteps(events: LLMEvent[]): string {
  return events
    .map((e) => {
      const meta = e.metadata as any;
      const content = e.content as any;
      const parts = [`[Step ${e.stepId}] type=${e.eventType}`];
      if (meta?.model) parts.push(`model=${meta.model}`);
      if (e.spanId) parts.push(`span=${e.spanId}`);

      let body = '';
      if (e.eventType === 'user_message') {
        body = typeof content === 'string' ? content : JSON.stringify(content)?.slice(0, 500);
      } else if (e.eventType === 'llm_response') {
        const text =
          content?.text ||
          content?.content ||
          (typeof content === 'string' ? content : JSON.stringify(content));
        body = String(text)?.slice(0, 800);
        const toolCalls = content?.toolCalls || content?.tool_calls;
        if (Array.isArray(toolCalls) && toolCalls.length > 0) {
          body += `\n  Tool calls: ${JSON.stringify(toolCalls.map((tc: any) => tc?.function?.name || tc?.name)).slice(0, 300)}`;
        }
      } else if (
        e.eventType === 'tool_call_request' ||
        e.eventType === 'tool_call_response' ||
        e.eventType === 'tool_result'
      ) {
        body = JSON.stringify(content)?.slice(0, 500);
      } else if (e.eventType === 'error') {
        body = JSON.stringify(content)?.slice(0, 300);
      }

      return `${parts.join(' | ')}\n  ${body}`;
    })
    .join('\n\n');
}

function formatToolCallSteps(events: LLMEvent[]): string {
  const toolEvents = events.filter(
    (e) =>
      e.eventType === 'llm_response' &&
      (Array.isArray((e.content as any)?.toolCalls) ||
        Array.isArray((e.content as any)?.tool_calls))
  );

  if (toolEvents.length === 0) return '(No tool call steps in trace)';

  return toolEvents
    .map((e) => {
      const content = e.content as any;
      const toolCalls = content?.toolCalls || content?.tool_calls || [];
      return `[Step ${e.stepId}] Tool calls:\n${JSON.stringify(toolCalls, null, 2).slice(0, 600)}`;
    })
    .join('\n\n');
}

function formatStepsWithMetrics(events: LLMEvent[]): string {
  return events
    .filter((e) => e.eventType === 'llm_response')
    .map((e) => {
      const meta = e.metadata as any;
      const usage = meta?.usage || (e.content as any)?.usage || {};
      return [
        `[Step ${e.stepId}]`,
        `model=${meta?.model || 'unknown'}`,
        `provider=${meta?.provider || 'unknown'}`,
        `total_tokens=${usage?.totalTokens || usage?.total_tokens || 'N/A'}`,
        `prompt_tokens=${usage?.promptTokens || usage?.prompt_tokens || 'N/A'}`,
        `completion_tokens=${usage?.completionTokens || usage?.completion_tokens || 'N/A'}`,
        `latency_ms=${meta?.latencyMs || meta?.latency_ms || 'N/A'}`,
      ].join(' | ');
    })
    .join('\n');
}

function extractUserMessage(events: LLMEvent[]): string {
  const userMsg = events.find((e) => e.eventType === 'user_message');
  if (!userMsg) return '(No user message in trace)';
  const content = userMsg.content;
  return typeof content === 'string' ? content : JSON.stringify(content)?.slice(0, 500);
}

function extractObservedBehavior(events: LLMEvent[]): string {
  const behaviors: string[] = [];
  for (const e of events) {
    if (e.eventType === 'llm_response') {
      const content = e.content as any;
      const text = content?.text || content?.content;
      if (text) behaviors.push(`[Step ${e.stepId}] Response: ${String(text).slice(0, 200)}`);
    }
    if (e.eventType === 'error') {
      behaviors.push(`[Step ${e.stepId}] ERROR: ${JSON.stringify(e.content).slice(0, 200)}`);
    }
  }
  return behaviors.join('\n') || '(No behavior observations)';
}

function extractToolUsageFromEvents(events: LLMEvent[]): string {
  const usages: string[] = [];
  for (const e of events) {
    if (e.eventType === 'tool_call_request' || e.eventType === 'tool_call_response') {
      const meta = e.metadata as any;
      const toolName = meta?.tool || (e.content as any)?.function?.name || 'unknown';
      usages.push(`[Step ${e.stepId}] ${e.eventType}: ${toolName}`);
    }
  }
  return usages.join('\n') || '(No tool usage observed)';
}

function extractNearbyToolNames(events: LLMEvent[], stepId: number): string[] {
  const names: string[] = [];
  for (const e of events) {
    if (Math.abs(e.stepId - stepId) <= 3) {
      if (e.eventType === 'tool_call_request' || e.eventType === 'tool_call_response') {
        const meta = e.metadata as any;
        const name = meta?.tool || (e.content as any)?.function?.name;
        if (name && !names.includes(name)) names.push(name);
      }
    }
  }
  return names;
}

function formatStaticFindings(findings: any[], dimension?: string): string {
  const relevant = dimension
    ? findings.filter((f: any) => {
        if (dimension === 'cost_efficiency') return f.dimension === 'cost_latency';
        if (dimension === 'tool_choice' || dimension === 'tool_description')
          return f.dimension === 'tool_execution';
        return true;
      })
    : findings;

  if (relevant.length === 0) return '(No relevant static findings)';

  return relevant
    .map(
      (f: any) =>
        `[${f.severity}] ${f.dimension}: ${f.evidence?.issue || JSON.stringify(f.evidence).slice(0, 200)}`
    )
    .join('\n');
}

function resolveJudgeMode(mode: RunJudgeInput['mode']): JudgeMode {
  if (mode === 'quick' || mode === 'standard' || mode === 'deep') return mode;
  return 'standard';
}

function sampleEvenly<T>(items: T[], limit?: number): T[] {
  if (!limit || limit <= 0 || items.length <= limit) return items;
  if (limit === 1) return [items[0]];

  const indices: number[] = [];
  const step = (items.length - 1) / (limit - 1);
  for (let i = 0; i < limit; i++) {
    indices.push(Math.round(i * step));
  }

  const uniqueIndices = [...new Set(indices)].sort((a, b) => a - b);
  const sampled = uniqueIndices.map((index) => items[index]);

  if (sampled.length >= limit) return sampled.slice(0, limit);

  const seen = new Set(uniqueIndices);
  for (let i = 0; i < items.length && sampled.length < limit; i++) {
    if (seen.has(i)) continue;
    sampled.push(items[i]);
  }
  return sampled;
}

function sampleResponseEvents(events: LLMEvent[], maxResponses?: number): LLMEvent[] {
  const responseEvents = events.filter((e) => e.eventType === 'llm_response');
  return sampleEvenly(responseEvents, maxResponses);
}

function sampleResponseFocusedEvents(events: LLMEvent[], maxResponses?: number): LLMEvent[] {
  if (!maxResponses || maxResponses <= 0) return events;

  const sampledResponses = sampleResponseEvents(events, maxResponses);
  const originalResponses = events.filter((e) => e.eventType === 'llm_response');
  if (sampledResponses.length >= originalResponses.length) return events;

  const sampledStepIds = new Set(sampledResponses.map((e) => e.stepId));
  const sampledEvents = events.filter(
    (e) =>
      e.eventType === 'user_message' ||
      sampledStepIds.has(e.stepId) ||
      (typeof e.parentStepId === 'number' && sampledStepIds.has(e.parentStepId))
  );

  return sampledEvents.length > 0 ? sampledEvents : events;
}

function sampleToolCallEvents(events: LLMEvent[], maxToolCallSteps?: number): LLMEvent[] {
  const toolCallEvents = events.filter((e) => {
    if (e.eventType !== 'llm_response') return false;
    const content = e.content as any;
    const tc = content?.toolCalls || content?.tool_calls;
    return Array.isArray(tc) && tc.length > 0;
  });
  return sampleEvenly(toolCallEvents, maxToolCallSteps);
}

function extractUsedToolNames(events: LLMEvent[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();

  function add(name: unknown) {
    if (!name || typeof name !== 'string') return;
    if (seen.has(name)) return;
    seen.add(name);
    names.push(name);
  }

  for (const e of events) {
    if (e.eventType === 'tool_call_request' || e.eventType === 'tool_call_response') {
      const meta = e.metadata as any;
      add(meta?.tool || (e.content as any)?.function?.name || (e.content as any)?.name);
      continue;
    }

    if (e.eventType === 'llm_response') {
      const content = e.content as any;
      const toolCalls = content?.toolCalls || content?.tool_calls;
      if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
          add(tc?.function?.name || tc?.name);
        }
      }
    }
  }

  return names;
}

function selectToolsForMode(
  tools: ToolDefinition[],
  events: LLMEvent[],
  maxTools?: number
): ToolDefinition[] {
  if (!maxTools || maxTools <= 0 || tools.length <= maxTools) return tools;

  const usedToolNames = new Set(extractUsedToolNames(events));
  const usedTools = tools.filter((t) => usedToolNames.has(t.name));
  const unusedTools = tools.filter((t) => !usedToolNames.has(t.name));

  if (usedTools.length >= maxTools) {
    return sampleEvenly(usedTools, maxTools);
  }

  const remaining = maxTools - usedTools.length;
  return [...usedTools, ...sampleEvenly(unusedTools, remaining)];
}

// ---------------------------------------------------------------------------
// Helpers: chunk events for map-reduce
// ---------------------------------------------------------------------------
function chunkEvents(events: LLMEvent[], chunkSize: number): LLMEvent[][] {
  const chunks: LLMEvent[][] = [];
  for (let i = 0; i < events.length; i += chunkSize) {
    chunks.push(events.slice(i, i + chunkSize));
  }
  return chunks;
}

async function runWithCheckpointHeartbeat<T>(args: {
  checkpoints: JudgeCheckpointEmitter<JudgeResult>;
  key: string;
  run: () => Promise<T>;
  intervalMs?: number;
  startedData?: Record<string, unknown>;
}): Promise<T> {
  const { checkpoints, key, run, intervalMs = 5000, startedData } = args;
  const startedAt = Date.now();
  let done = false;
  let heartbeatCount = 0;

  await checkpoints.checkpoint(`${key}.started`, startedData);

  const timer = setInterval(() => {
    if (done) return;
    heartbeatCount += 1;
    void checkpoints.checkpoint(`${key}.heartbeat`, {
      heartbeatCount,
      elapsedMs: Date.now() - startedAt,
    });
  }, intervalMs);

  try {
    const result = await run();
    done = true;
    clearInterval(timer);
    await checkpoints.checkpoint(`${key}.completed`, {
      durationMs: Date.now() - startedAt,
      heartbeatCount,
    });
    return result;
  } catch (error: any) {
    done = true;
    clearInterval(timer);
    await checkpoints.checkpoint(`${key}.failed`, {
      durationMs: Date.now() - startedAt,
      heartbeatCount,
      errorMessage: error?.message || "unknown error",
    });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Main Judge Service
// ---------------------------------------------------------------------------
export class JudgeService {
  /**
   * Run the LLM Judge v1 on a trace.
   */
  static async runLLMJudge(input: RunJudgeInput): Promise<JudgeResult> {
    const {
      traceId,
      userId,
      dimensions = ALL_DIMENSIONS,
      judgeModel = env.JUDGE_LLM_MODEL,
      mode,
      onCheckpoint,
    } = input;
    const judgeMode = resolveJudgeMode(mode);
    const executionProfile = JUDGE_MODE_PROFILES[judgeMode];

    const now = new Date();
    const dimensionResults: DimensionScore[] = [];
    const allFindings: any[] = [];
    const severityCounts: Record<string, number> = {};
    let analysis: TraceAnalysis | null = null;
    let snapshotStatus: 'running' | 'completed' | 'failed' = 'running';

    const buildSummary = () => {
      const scoredDimensions = dimensionResults.filter((d) => !d.skipped);
      const overallScore =
        scoredDimensions.length > 0
          ? Math.round(
              (scoredDimensions.reduce((s, d) => s + d.score, 0) / scoredDimensions.length) * 100
            ) / 100
          : 0;

      const dimensionScores: Record<string, number> = {};
      for (const dim of dimensions) {
        dimensionScores[dim] = -1;
      }
      for (const d of dimensionResults) {
        dimensionScores[d.dimension] = d.skipped ? -1 : Math.round(d.score * 100) / 100;
      }

      const totalIssues = dimensionResults.reduce((s, d) => s + d.issueCount, 0);
      const totalPatches = dimensionResults.reduce((s, d) => s + d.patchCount, 0);

      return {
        overallScore,
        dimensionScores,
        totalIssues,
        totalPatches,
        bySeverity: severityCounts,
        dimensionDetails: dimensionResults,
      };
    };

    const buildSnapshot = (
      status: 'running' | 'completed' | 'failed' = snapshotStatus
    ): JudgeResult => {
      return {
        id: analysis?.id || 'pending',
        traceId,
        status,
        rubricVersion: 'judge-v1',
        judgeModel,
        mode: judgeMode,
        summary: buildSummary(),
        findings: status === 'completed' ? allFindings : [],
      };
    };

    const checkpoints = createJudgeCheckpointEmitter<JudgeResult>({
      handler: onCheckpoint,
      getSnapshot: () => buildSnapshot(),
    });

    // ---- Validate judge is configured ----
    if (!env.JUDGE_LLM_API_KEY) {
      throw new Error('JUDGE_NOT_CONFIGURED');
    }
    await checkpoints.checkpoint('request.accepted', {
      traceId,
      mode: judgeMode,
      dimensions,
      judgeModel,
    });

    // ---- Load trace ----
    await checkpoints.checkpoint('trace.load.started');
    const trace = await Trace.findOne({
      where: { id: traceId, userId },
      attributes: ['id', 'userId', 'entityId', 'model', 'systemMessage', 'tools', 'metadata', 'sampledIn'],
    });

    if (!trace) throw new Error('TRACE_NOT_FOUND');
    await checkpoints.checkpoint('trace.load.completed', {
      traceId: trace.id,
      hasEntityId: Boolean(trace.entityId),
    });

    // ---- Load entity for metadata (system prompt, tools) ----
    let entityMetadata: Record<string, any> = {};
    if (trace.entityId) {
      await checkpoints.checkpoint('entity.load.started', { entityId: trace.entityId });
      const entity = await Entity.findByPk(trace.entityId, {
        attributes: ['id', 'name', 'metadata'],
      });
      if (entity) entityMetadata = entity.metadata || {};
      await checkpoints.checkpoint('entity.load.completed', {
        entityId: trace.entityId,
        found: Boolean(entity),
      });
    }

    // ---- Resolve system prompt & tools ----
    const systemPrompt =
      trace.systemMessage ||
      entityMetadata.systemPrompt ||
      entityMetadata.system_prompt ||
      '';

    const tools: ToolDefinition[] =
      trace.tools ||
      entityMetadata.tools ||
      [];
    await checkpoints.checkpoint('trace.context.resolved', {
      hasSystemPrompt: systemPrompt.length > 0,
      toolCount: tools.length,
    });

    // ---- Load events ----
    await checkpoints.checkpoint('events.load.started');
    const events = await LLMEvent.findAll({
      where: { traceId, userId },
      attributes: [
        'id', 'stepId', 'parentStepId', 'spanId', 'eventType',
        'timestamp', 'content', 'metadata',
      ],
      order: [
        ['timestamp', 'ASC'],
        ['stepId', 'ASC'],
      ],
    });
    await checkpoints.checkpoint('events.load.completed', {
      eventCount: events.length,
    });

    // ---- Load prior static findings ----
    await checkpoints.checkpoint('static_findings.load.started');
    const priorAnalyses = await TraceAnalysis.findAll({
      where: { traceId, status: 'completed' },
      attributes: ['id', 'rubricVersion'],
      order: [['createdAt', 'DESC']],
      limit: 1,
    });

    let staticFindings: any[] = [];
    if (priorAnalyses.length > 0) {
      const findings = await TraceAnalysisFinding.findAll({
        where: { analysisId: priorAnalyses[0].id },
        order: [['createdAt', 'ASC']],
      });
      staticFindings = findings.map((f) => f.toJSON());
    }
    await checkpoints.checkpoint('static_findings.load.completed', {
      priorAnalysisCount: priorAnalyses.length,
      staticFindingCount: staticFindings.length,
    });

    // ---- Create analysis record ----
    analysis = await TraceAnalysis.create({
      traceId,
      status: 'running',
      rubricVersion: 'judge-v1',
      judgeModel,
      mode: judgeMode,
      startedAt: now,
      summary: { analyzer: 'judge-v1', mode: judgeMode, dimensions },
    });
    await checkpoints.checkpoint('analysis.record.created', { analysisId: analysis.id });

    try {
      // ---- Run each dimension ----
      await checkpoints.checkpoint('dimensions.started', {
        dimensionCount: dimensions.length,
      });

      // Determine which dimensions to skip
      const hasSystemPrompt = systemPrompt.length > 0;
      const hasTools = tools.length > 0;
      const hasEvents = events.length > 0;

      for (const dim of dimensions) {
        const dimensionCheckpoints = checkpoints.scoped(`dimension.${dim}`);
        try {
          await dimensionCheckpoints.checkpoint('started');
          const result = await this.runDimension(dim, {
            events,
            systemPrompt,
            tools,
            staticFindings,
            hasSystemPrompt,
            hasTools,
            hasEvents,
            judgeModel,
            mode: judgeMode,
            executionProfile,
            checkpoints: dimensionCheckpoints,
          });

          if (result.skipped) {
            dimensionResults.push({
              dimension: dim,
              score: 0,
              issueCount: 0,
              patchCount: 0,
              skipped: true,
              skipReason: result.skipReason,
            });
            await dimensionCheckpoints.checkpoint('skipped', {
              reason: result.skipReason,
            });
            continue;
          }

          // Save findings to DB
          for (const finding of result.findings) {
            const created = await TraceAnalysisFinding.create({
              analysisId: analysis.id,
              stepId: finding.stepId || undefined,
              dimension: dim,
              severity: finding.severity || 'low',
              confidence: finding.confidence || 0.5,
              evidence: {
                score: finding.score,
                issues: finding.issues || [],
                ...(finding.extra || {}),
              },
              recommendation: {
                action: finding.recommendation?.action || 'review',
                detail: finding.recommendation?.detail || '',
                patches: finding.patches || [],
              },
            });
            allFindings.push(created.toJSON());

            // Count severities
            const sev = finding.severity || 'low';
            severityCounts[sev] = (severityCounts[sev] || 0) + 1;
          }

          dimensionResults.push({
            dimension: dim,
            score: result.score,
            issueCount: result.issueCount,
            patchCount: result.patchCount,
            skipped: false,
          });
          await dimensionCheckpoints.checkpoint('completed', {
            score: result.score,
            issueCount: result.issueCount,
            patchCount: result.patchCount,
          });
        } catch (dimError: any) {
          const diagnostics = extractJudgeErrorDiagnostics(dimError);
          logger.error(
            {
              errorMessage: dimError?.message || String(dimError),
              errorName: dimError?.name,
              errorStack: dimError?.stack,
              errorStatus: diagnostics.status,
              errorRequestId: diagnostics.requestId,
              errorCode: diagnostics.errorCode,
              errorType: diagnostics.errorType,
              retryableInvalidModel: isInvalidModelNameError(dimError),
              dimension: dim,
              judgeModel,
              judgeBaseURL: env.JUDGE_LLM_BASE_URL,
              judgeKeySuffix: env.JUDGE_LLM_API_KEY?.slice(-8),
              traceId,
            },
            'Dimension evaluation failed'
          );
          dimensionResults.push({
            dimension: dim,
            score: 0,
            issueCount: 0,
            patchCount: 0,
            skipped: true,
            skipReason: `Evaluation failed: ${dimError?.message || 'unknown error'}`,
          });
          await dimensionCheckpoints.checkpoint('failed', {
            errorMessage: dimError?.message || 'unknown error',
            status: diagnostics.status,
            requestId: diagnostics.requestId,
          });
        }
      }

      // ---- Compute summary ----
      const summary = buildSummary();
      await checkpoints.checkpoint('dimensions.completed', {
        totalIssues: summary.totalIssues,
        totalPatches: summary.totalPatches,
      });

      // ---- Update analysis record ----
      await analysis.update({
        status: 'completed',
        finishedAt: new Date(),
        summary,
      });
      snapshotStatus = 'completed';
      await checkpoints.checkpoint('analysis.completed', {
        analysisId: analysis.id,
        overallScore: summary.overallScore,
      });

      const completedResult: JudgeResult = {
        id: analysis.id,
        traceId,
        status: 'completed',
        rubricVersion: 'judge-v1',
        judgeModel,
        mode: judgeMode,
        summary,
        findings: allFindings,
      };
      return completedResult;
    } catch (error: any) {
      const diagnostics = extractJudgeErrorDiagnostics(error);
      logger.error(
        {
          error,
          traceId,
          analysisId: analysis.id,
          errorStatus: diagnostics.status,
          errorRequestId: diagnostics.requestId,
          errorCode: diagnostics.errorCode,
          errorType: diagnostics.errorType,
          retryableInvalidModel: isInvalidModelNameError(error),
          judgeModel,
          judgeBaseURL: env.JUDGE_LLM_BASE_URL,
          judgeKeySuffix: env.JUDGE_LLM_API_KEY?.slice(-8),
        },
        'LLM Judge failed'
      );
      await analysis.update({
        status: 'failed',
        finishedAt: new Date(),
        summary: {
          ...(analysis.summary || {}),
          error: error?.message || 'UNKNOWN_ERROR',
        },
      });
      snapshotStatus = 'failed';
      await checkpoints.checkpoint('analysis.failed', {
        analysisId: analysis.id,
        errorMessage: error?.message || 'UNKNOWN_ERROR',
        status: diagnostics.status,
        requestId: diagnostics.requestId,
      });
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Dimension dispatcher
  // ---------------------------------------------------------------------------
  private static async runDimension(
    dimension: JudgeDimension,
    ctx: {
      events: LLMEvent[];
      systemPrompt: string;
      tools: ToolDefinition[];
      staticFindings: any[];
      hasSystemPrompt: boolean;
      hasTools: boolean;
      hasEvents: boolean;
      judgeModel: string;
      mode: JudgeMode;
      executionProfile: JudgeExecutionProfile;
      checkpoints: JudgeCheckpointEmitter<JudgeResult>;
    }
  ): Promise<{
    score: number;
    issueCount: number;
    patchCount: number;
    skipped: boolean;
    skipReason?: string;
    findings: any[];
  }> {
    switch (dimension) {
      case 'step_correctness':
        return this.runStepCorrectness(ctx);
      case 'tool_choice':
        return this.runToolChoice(ctx);
      case 'prompt_quality':
        return this.runPromptQuality(ctx);
      case 'tool_description':
        return this.runToolDescription(ctx);
      case 'cost_efficiency':
        return this.runCostEfficiency(ctx);
      default:
        return {
          score: 0,
          issueCount: 0,
          patchCount: 0,
          skipped: true,
          skipReason: `Unknown dimension: ${dimension}`,
          findings: [],
        };
    }
  }

  // ---------------------------------------------------------------------------
  // Dimension: Step Correctness
  // ---------------------------------------------------------------------------
  private static async runStepCorrectness(ctx: {
    events: LLMEvent[];
    systemPrompt: string;
    staticFindings: any[];
    hasEvents: boolean;
    judgeModel: string;
    mode: JudgeMode;
    executionProfile: JudgeExecutionProfile;
    checkpoints: JudgeCheckpointEmitter<JudgeResult>;
  }) {
    await ctx.checkpoints.checkpoint('step_correctness.started');
    if (!ctx.hasEvents) {
      return { score: 0, issueCount: 0, patchCount: 0, skipped: true, skipReason: 'No events in trace', findings: [] };
    }

    const eventsForEvaluation = sampleResponseFocusedEvents(
      ctx.events,
      ctx.executionProfile.stepCorrectnessMaxResponses
    );
    if (eventsForEvaluation.length < ctx.events.length) {
      logger.info(
        {
          mode: ctx.mode,
          originalEvents: ctx.events.length,
          evaluatedEvents: eventsForEvaluation.length,
        },
        'Step correctness applying mode-based event sampling'
      );
      await ctx.checkpoints.checkpoint('step_correctness.sampled', {
        originalEvents: ctx.events.length,
        evaluatedEvents: eventsForEvaluation.length,
      });
    }

    const responseEvents = eventsForEvaluation.filter((e) => e.eventType === 'llm_response');
    if (responseEvents.length === 0) {
      return { score: 0, issueCount: 0, patchCount: 0, skipped: true, skipReason: 'No LLM responses in trace', findings: [] };
    }

    // Map-reduce for large traces
    const useMapReduce = eventsForEvaluation.length > THRESHOLDS.TRACE_MAP_REDUCE_LIMIT;
    let allResults: StepCorrectnessResult[] = [];

    if (useMapReduce) {
      const chunks = chunkEvents(eventsForEvaluation, THRESHOLDS.TRACE_MAP_REDUCE_LIMIT);
      logger.info({ chunks: chunks.length, totalEvents: eventsForEvaluation.length }, 'Using map-reduce for step correctness');
      await ctx.checkpoints.checkpoint('step_correctness.map_reduce.started', {
        chunkCount: chunks.length,
        totalEvents: eventsForEvaluation.length,
      });

      const chunkResults = await Promise.all(
        chunks.map(async (chunk, index) => {
          await ctx.checkpoints.checkpoint('step_correctness.map_reduce.chunk.started', {
            chunkIndex: index + 1,
            chunkCount: chunks.length,
            chunkEvents: chunk.length,
          });
          const result = await runWithCheckpointHeartbeat({
            checkpoints: ctx.checkpoints,
            key: 'step_correctness.map_reduce.chunk.call',
            startedData: {
              chunkIndex: index + 1,
              chunkCount: chunks.length,
            },
            run: () =>
              runStepCorrectnessChain(
                {
                  systemPrompt: ctx.systemPrompt,
                  traceSteps: formatTraceSteps(chunk),
                  staticFindings: formatStaticFindings(ctx.staticFindings, 'step_correctness'),
                },
                ctx.judgeModel
              ),
          });
          await ctx.checkpoints.checkpoint('step_correctness.map_reduce.chunk.completed', {
            chunkIndex: index + 1,
            chunkCount: chunks.length,
            stepResults: result.length,
          });
          return result;
        })
      );
      allResults = chunkResults.flat();
      await ctx.checkpoints.checkpoint('step_correctness.map_reduce.completed', {
        totalStepResults: allResults.length,
      });
    } else {
      allResults = await runWithCheckpointHeartbeat({
        checkpoints: ctx.checkpoints,
        key: 'step_correctness.single_pass.call',
        startedData: {
          evaluatedEvents: eventsForEvaluation.length,
        },
        run: () =>
          runStepCorrectnessChain(
            {
              systemPrompt: ctx.systemPrompt,
              traceSteps: formatTraceSteps(eventsForEvaluation),
              staticFindings: formatStaticFindings(ctx.staticFindings, 'step_correctness'),
            },
            ctx.judgeModel
          ),
      });
      await ctx.checkpoints.checkpoint('step_correctness.single_pass.completed', {
        stepResults: allResults.length,
      });
    }

    const avgScore =
      allResults.length > 0
        ? allResults.reduce((s, r) => s + r.score, 0) / allResults.length
        : 0;

    const findings = allResults.map((r) => ({
      stepId: r.stepId,
      score: r.score,
      severity: r.severity,
      confidence: r.confidence,
      issues: r.issues,
      recommendation: r.recommendation,
      patches: [],
    }));

    const totalIssues = allResults.reduce(
      (s, r) => s + r.issues.filter((i) => i.code !== 'CORRECT').length,
      0
    );

    return {
      score: avgScore,
      issueCount: totalIssues,
      patchCount: 0,
      skipped: false,
      findings,
    };
  }

  // ---------------------------------------------------------------------------
  // Dimension: Tool Choice
  // ---------------------------------------------------------------------------
  private static async runToolChoice(ctx: {
    events: LLMEvent[];
    systemPrompt: string;
    tools: ToolDefinition[];
    staticFindings: any[];
    hasTools: boolean;
    hasEvents: boolean;
    judgeModel: string;
    mode: JudgeMode;
    executionProfile: JudgeExecutionProfile;
    checkpoints: JudgeCheckpointEmitter<JudgeResult>;
  }) {
    await ctx.checkpoints.checkpoint('tool_choice.started');
    if (!ctx.hasEvents || !ctx.hasTools) {
      return {
        score: 0,
        issueCount: 0,
        patchCount: 0,
        skipped: true,
        skipReason: !ctx.hasTools ? 'No tools defined on trace' : 'No events in trace',
        findings: [],
      };
    }

    // Find steps with tool calls (possibly sampled by mode)
    const toolCallEvents = sampleToolCallEvents(ctx.events, ctx.executionProfile.toolChoiceMaxSteps);
    if (ctx.executionProfile.toolChoiceMaxSteps && toolCallEvents.length > 0) {
      const fullToolCallCount = sampleToolCallEvents(ctx.events).length;
      if (toolCallEvents.length < fullToolCallCount) {
        logger.info(
          {
            mode: ctx.mode,
            originalToolCallSteps: fullToolCallCount,
            evaluatedToolCallSteps: toolCallEvents.length,
          },
          'Tool choice applying mode-based step sampling'
        );
        await ctx.checkpoints.checkpoint('tool_choice.sampled', {
          originalToolCallSteps: fullToolCallCount,
          evaluatedToolCallSteps: toolCallEvents.length,
        });
      }
    }

    if (toolCallEvents.length === 0) {
      return { score: 0, issueCount: 0, patchCount: 0, skipped: true, skipReason: 'No tool calls in trace', findings: [] };
    }

    const userMessage = extractUserMessage(ctx.events);

    // For each tool-call step, filter the relevant tools
    const firstToolCall = toolCallEvents[0];
    const content = firstToolCall.content as any;
    const calls = content?.toolCalls || content?.tool_calls || [];
    const chosenToolName = calls[0]?.function?.name || calls[0]?.name || null;
    const nearbyTools = extractNearbyToolNames(ctx.events, firstToolCall.stepId);

    const filterResult = filterToolsForJudge({
      allTools: ctx.tools,
      chosenToolName,
      userMessage,
      nearbyToolNames: nearbyTools,
    });

    const results = await runWithCheckpointHeartbeat({
      checkpoints: ctx.checkpoints,
      key: 'tool_choice.call',
      startedData: {
        evaluatedToolCallSteps: toolCallEvents.length,
        candidateTools: filterResult.candidateTools.length,
      },
      run: () =>
        runToolChoiceChain(
          {
            userMessage,
            candidateTools: JSON.stringify(filterResult.candidateTools, null, 2),
            candidateCount: filterResult.candidateTools.length,
            totalTools: filterResult.totalToolsAvailable,
            toolCallSteps: formatToolCallSteps(toolCallEvents),
            systemPrompt: ctx.systemPrompt,
          },
          ctx.judgeModel
        ),
    });
    await ctx.checkpoints.checkpoint('tool_choice.chain.completed', {
      evaluatedSteps: results.length,
      candidateTools: filterResult.candidateTools.length,
      totalTools: filterResult.totalToolsAvailable,
    });

    const avgScore =
      results.length > 0 ? results.reduce((s, r) => s + r.score, 0) / results.length : 0;

    const findings = results.map((r) => ({
      stepId: r.stepId,
      score: r.score,
      severity: r.severity,
      confidence: r.confidence,
      issues: r.issues,
      recommendation: r.recommendation,
      patches: r.patches,
      extra: {
        chosenTool: r.chosenTool,
        betterAlternatives: r.betterAlternatives,
        candidateToolsEvaluated: r.candidateToolsEvaluated,
      },
    }));

    const totalIssues = results.reduce(
      (s, r) => s + r.issues.filter((i) => i.code !== 'OPTIMAL_CHOICE').length,
      0
    );
    const totalPatches = results.reduce((s, r) => s + r.patches.length, 0);

    return {
      score: avgScore,
      issueCount: totalIssues,
      patchCount: totalPatches,
      skipped: false,
      findings,
    };
  }

  // ---------------------------------------------------------------------------
  // Dimension: Prompt Quality
  // ---------------------------------------------------------------------------
  private static async runPromptQuality(ctx: {
    events: LLMEvent[];
    systemPrompt: string;
    staticFindings: any[];
    hasSystemPrompt: boolean;
    judgeModel: string;
    mode: JudgeMode;
    executionProfile: JudgeExecutionProfile;
    checkpoints: JudgeCheckpointEmitter<JudgeResult>;
  }) {
    await ctx.checkpoints.checkpoint('prompt_quality.started');
    if (!ctx.hasSystemPrompt) {
      return {
        score: 0,
        issueCount: 0,
        patchCount: 0,
        skipped: true,
        skipReason: 'No system prompt on trace',
        findings: [],
      };
    }

    const result: PromptQualityResult = await runWithCheckpointHeartbeat({
      checkpoints: ctx.checkpoints,
      key: 'prompt_quality.call',
      startedData: {
        skipSynthesis: ctx.executionProfile.promptQualitySkipSynthesis,
        maxBlocks: ctx.executionProfile.promptQualityMaxBlocks,
        blockEvalConcurrency: ctx.executionProfile.promptQualityBlockEvalConcurrency,
      },
      run: () =>
        runPromptQualityChain(
          {
            systemPrompt: ctx.systemPrompt,
            observedBehavior: extractObservedBehavior(ctx.events),
            staticFindings: formatStaticFindings(ctx.staticFindings),
          },
          ctx.judgeModel,
          {
            skipSynthesis: ctx.executionProfile.promptQualitySkipSynthesis,
            maxBlocks: ctx.executionProfile.promptQualityMaxBlocks,
            blockEvalConcurrency: ctx.executionProfile.promptQualityBlockEvalConcurrency,
            onCheckpoint: async (key, data) => {
              await ctx.checkpoints.checkpoint(`prompt_quality.${key}`, data);
            },
          }
        ),
    });
    await ctx.checkpoints.checkpoint('prompt_quality.chain.completed', {
      score: result.overallScore,
      issues: result.issues.length,
      patches: result.patches.length,
    });

    const findings = [
      {
        stepId: null,
        score: result.overallScore,
        severity: result.severity,
        confidence: result.confidence,
        issues: result.issues,
        recommendation: result.recommendation,
        patches: result.patches,
        extra: {
          blockResults: result.blockResults,
          synthesisResult: result.synthesisResult,
        },
      },
    ];

    return {
      score: result.overallScore,
      issueCount: result.issues.length,
      patchCount: result.patches.length,
      skipped: false,
      findings,
    };
  }

  // ---------------------------------------------------------------------------
  // Dimension: Tool Description Quality
  // ---------------------------------------------------------------------------
  private static async runToolDescription(ctx: {
    events: LLMEvent[];
    tools: ToolDefinition[];
    staticFindings: any[];
    hasTools: boolean;
    judgeModel: string;
    mode: JudgeMode;
    executionProfile: JudgeExecutionProfile;
    checkpoints: JudgeCheckpointEmitter<JudgeResult>;
  }) {
    await ctx.checkpoints.checkpoint('tool_description.started');
    if (!ctx.hasTools) {
      return {
        score: 0,
        issueCount: 0,
        patchCount: 0,
        skipped: true,
        skipReason: 'No tools defined on trace',
        findings: [],
      };
    }

    const toolsForEvaluation = selectToolsForMode(
      ctx.tools,
      ctx.events,
      ctx.executionProfile.toolDescriptionMaxTools
    );
    if (toolsForEvaluation.length < ctx.tools.length) {
      logger.info(
        {
          mode: ctx.mode,
          originalTools: ctx.tools.length,
          evaluatedTools: toolsForEvaluation.length,
        },
        'Tool description applying mode-based tool sampling'
      );
      await ctx.checkpoints.checkpoint('tool_description.sampled', {
        originalTools: ctx.tools.length,
        evaluatedTools: toolsForEvaluation.length,
      });
    }

    const result: ToolDescriptionResult = await runWithCheckpointHeartbeat({
      checkpoints: ctx.checkpoints,
      key: 'tool_description.call',
      startedData: {
        evaluatedTools: toolsForEvaluation.length,
      },
      run: () =>
        runToolDescriptionChain(
          {
            toolDefinitions: JSON.stringify(toolsForEvaluation, null, 2),
            observedToolUsage: extractToolUsageFromEvents(ctx.events),
            toolMisuseFindings: formatStaticFindings(ctx.staticFindings, 'tool_description'),
          },
          ctx.judgeModel
        ),
    });
    await ctx.checkpoints.checkpoint('tool_description.chain.completed', {
      score: result.overallScore,
      toolsEvaluated: result.toolEvaluations.length,
      issues: result.issues.length,
      patches: result.patches.length,
    });

    const findings = [
      {
        stepId: null,
        score: result.overallScore,
        severity: result.severity,
        confidence: result.confidence,
        issues: result.issues,
        recommendation: result.recommendation,
        patches: result.patches,
        extra: {
          toolEvaluations: result.toolEvaluations,
        },
      },
    ];

    return {
      score: result.overallScore,
      issueCount: result.issues.length,
      patchCount: result.patches.length,
      skipped: false,
      findings,
    };
  }

  // ---------------------------------------------------------------------------
  // Dimension: Cost / Latency Efficiency
  // ---------------------------------------------------------------------------
  private static async runCostEfficiency(ctx: {
    events: LLMEvent[];
    staticFindings: any[];
    hasEvents: boolean;
    judgeModel: string;
    mode: JudgeMode;
    executionProfile: JudgeExecutionProfile;
    checkpoints: JudgeCheckpointEmitter<JudgeResult>;
  }) {
    await ctx.checkpoints.checkpoint('cost_efficiency.started');
    if (!ctx.hasEvents) {
      return {
        score: 0,
        issueCount: 0,
        patchCount: 0,
        skipped: true,
        skipReason: 'No events in trace',
        findings: [],
      };
    }

    const responseEvents = sampleResponseEvents(
      ctx.events,
      ctx.executionProfile.costEfficiencyMaxResponses
    );
    if (responseEvents.length === 0) {
      return {
        score: 0,
        issueCount: 0,
        patchCount: 0,
        skipped: true,
        skipReason: 'No LLM responses in trace for cost analysis',
        findings: [],
      };
    }
    const allResponseEvents = ctx.events.filter((e) => e.eventType === 'llm_response');
    if (responseEvents.length < allResponseEvents.length) {
      logger.info(
        {
          mode: ctx.mode,
          originalResponseSteps: allResponseEvents.length,
          evaluatedResponseSteps: responseEvents.length,
        },
        'Cost efficiency applying mode-based step sampling'
      );
      await ctx.checkpoints.checkpoint('cost_efficiency.sampled', {
        originalResponseSteps: allResponseEvents.length,
        evaluatedResponseSteps: responseEvents.length,
      });
    }

    const result: CostEfficiencyResult = await runWithCheckpointHeartbeat({
      checkpoints: ctx.checkpoints,
      key: 'cost_efficiency.call',
      startedData: {
        evaluatedResponseSteps: responseEvents.length,
      },
      run: () =>
        runCostEfficiencyChain(
          {
            traceStepsWithMetrics: formatStepsWithMetrics(responseEvents),
            staticCostFindings: formatStaticFindings(ctx.staticFindings, 'cost_efficiency'),
          },
          ctx.judgeModel
        ),
    });
    await ctx.checkpoints.checkpoint('cost_efficiency.chain.completed', {
      score: result.overallScore,
      issues: result.issues.length,
      evaluatedSteps: result.stepEvaluations.length,
      potentialSavingsPercent: result.summary.potentialSavingsPercent,
    });

    const findings = [
      {
        stepId: null,
        score: result.overallScore,
        severity: result.severity,
        confidence: result.confidence,
        issues: result.issues,
        recommendation: result.recommendation,
        patches: [],
        extra: {
          stepEvaluations: result.stepEvaluations,
          summary: result.summary,
        },
      },
    ];

    return {
      score: result.overallScore,
      issueCount: result.issues.length,
      patchCount: 0,
      skipped: false,
      findings,
    };
  }
}
