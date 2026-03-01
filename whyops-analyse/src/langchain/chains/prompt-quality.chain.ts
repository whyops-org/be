import { createServiceLogger } from '@whyops/shared/logger';
import { getJudgeModel, invokeWithInvalidModelRetry, THRESHOLDS } from '../config';
import {
  promptQualitySinglePassPrompt,
  promptQualityBlockPrompt,
  promptQualitySynthesisPrompt,
} from '../prompts';
import {
  PromptQualityResultSchema,
  PromptBlockResultSchema,
  PromptSynthesisResultSchema,
  type PromptQualityResult,
  type PromptBlockResult,
  type PromptSynthesisResult,
  type Patch,
  type Issue,
} from '../schemas';
import { segmentPrompt, type PromptBlock } from '../utils';

const logger = createServiceLogger('analyse:langchain:chain:prompt-quality');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface PromptQualityInput {
  systemPrompt: string;
  observedBehavior: string;
  staticFindings: string;
}

export interface PromptQualityExecutionOptions {
  /** Skip cross-section synthesis pass (used by quick mode). */
  skipSynthesis?: boolean;
  /** Cap number of prompt blocks to evaluate after segmentation. */
  maxBlocks?: number;
  /** Override default block-evaluation concurrency. */
  blockEvalConcurrency?: number;
  /** Optional fine-grained checkpoint callback. */
  onCheckpoint?: (key: string, data?: Record<string, unknown>) => void | Promise<void>;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];

  const bounded = Math.max(1, Math.min(concurrency, items.length));
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: bounded }, () => worker()));
  return results;
}

function sampleEvenly<T>(items: T[], limit: number): T[] {
  if (limit <= 0) return [];
  if (items.length <= limit) return items;
  if (limit === 1) return [items[0]];

  const indices: number[] = [];
  const step = (items.length - 1) / (limit - 1);

  for (let i = 0; i < limit; i++) {
    indices.push(Math.round(i * step));
  }

  const uniqueIndices = [...new Set(indices)].sort((a, b) => a - b);
  const sampled = uniqueIndices.map((i) => items[i]);

  if (sampled.length >= limit) {
    return sampled.slice(0, limit);
  }

  const used = new Set(uniqueIndices);
  for (let i = 0; i < items.length && sampled.length < limit; i++) {
    if (used.has(i)) continue;
    sampled.push(items[i]);
  }

  return sampled;
}

async function emitCheckpoint(
  options: PromptQualityExecutionOptions | undefined,
  key: string,
  data?: Record<string, unknown>
) {
  if (!options?.onCheckpoint) return;
  await options.onCheckpoint(key, data);
}

// ---------------------------------------------------------------------------
// Internal: single-pass evaluation (small prompts)
// ---------------------------------------------------------------------------
async function runSinglePass(
  input: PromptQualityInput,
  overrideModel?: string
): Promise<PromptQualityResult> {
  const model = getJudgeModel(overrideModel);
  const structured = model.withStructuredOutput(PromptQualityResultSchema);
  const chain = promptQualitySinglePassPrompt.pipe(structured);

  const raw = await invokeWithInvalidModelRetry({
    chainName: 'prompt_quality_single_pass',
    overrideModel,
    logger,
    invoke: () =>
      chain.invoke({
        systemPrompt: input.systemPrompt,
        observedBehavior: input.observedBehavior || '(No behavior observations available)',
        staticFindings: input.staticFindings || '(No prior static findings)',
      }),
  });

  return raw as unknown as PromptQualityResult;
}

// ---------------------------------------------------------------------------
// Internal: per-block evaluation (large prompts)
// ---------------------------------------------------------------------------
async function runBlockEval(
  block: PromptBlock,
  otherBlockNames: string[],
  overrideModel?: string
): Promise<PromptBlockResult> {
  const model = getJudgeModel(overrideModel);
  const structured = model.withStructuredOutput(PromptBlockResultSchema);
  const chain = promptQualityBlockPrompt.pipe(structured);

  const raw = await invokeWithInvalidModelRetry({
    chainName: 'prompt_quality_block_eval',
    overrideModel,
    logger,
    invoke: () =>
      chain.invoke({
        blockName: block.name,
        blockContent: block.content,
        startLine: String(block.startLine),
        endLine: String(block.endLine),
        otherBlockNames: otherBlockNames.join(', '),
      }),
  });

  return raw as unknown as PromptBlockResult;
}

// ---------------------------------------------------------------------------
// Internal: cross-section synthesis (large prompts)
// ---------------------------------------------------------------------------
async function runSynthesis(
  blockResults: PromptBlockResult[],
  blockNames: string[],
  overrideModel?: string
): Promise<PromptSynthesisResult> {
  const model = getJudgeModel(overrideModel);
  const structured = model.withStructuredOutput(PromptSynthesisResultSchema);
  const chain = promptQualitySynthesisPrompt.pipe(structured);

  const blockSummaries = blockResults
    .map(
      (br) =>
        `Block "${br.block}" (score: ${br.score}): ${br.issues.length} issues, ${br.patches.length} patches\n  Issues: ${br.issues.map((i) => i.code).join(', ') || 'none'}`
    )
    .join('\n\n');

  const raw = await invokeWithInvalidModelRetry({
    chainName: 'prompt_quality_synthesis',
    overrideModel,
    logger,
    invoke: () =>
      chain.invoke({
        blockSummaries,
        blockNames: blockNames.join(', '),
      }),
  });

  return raw as unknown as PromptSynthesisResult;
}

// ---------------------------------------------------------------------------
// Public API: hybrid prompt quality chain
// ---------------------------------------------------------------------------

/**
 * Run the prompt quality evaluation using the hybrid approach:
 * - Small prompt → single-pass
 * - Large prompt → segment → per-block → synthesis → merge
 */
export async function runPromptQualityChain(
  input: PromptQualityInput,
  overrideModel?: string,
  options?: PromptQualityExecutionOptions
): Promise<PromptQualityResult> {
  logger.info('Running prompt quality chain');
  await emitCheckpoint(options, 'started');

  const segmentation = await segmentPrompt(input.systemPrompt);
  await emitCheckpoint(options, 'segmentation.completed', {
    wasSegmented: segmentation.wasSegmented,
    method: segmentation.method,
    blockCount: segmentation.blocks.length,
  });

  // ---- Small prompt: single pass ----
  if (!segmentation.wasSegmented) {
    logger.info({ method: 'single_pass' }, 'Prompt small enough for single-pass evaluation');
    const result = await runSinglePass(input, overrideModel);
    await emitCheckpoint(options, 'single_pass.completed', {
      score: result.overallScore,
      issues: result.issues.length,
      patches: result.patches.length,
    });
    logger.info({ score: result.overallScore, issues: result.issues.length }, 'Prompt quality single-pass complete');
    return result;
  }

  // ---- Large prompt: per-block + synthesis ----
  const blockEvalConcurrency =
    options?.blockEvalConcurrency || THRESHOLDS.PROMPT_BLOCK_EVAL_CONCURRENCY;
  const maxBlocks = options?.maxBlocks;
  const skipSynthesis = Boolean(options?.skipSynthesis);
  const blocks =
    maxBlocks && maxBlocks > 0
      ? sampleEvenly(segmentation.blocks, maxBlocks)
      : segmentation.blocks;

  logger.info(
    {
      method: segmentation.method,
      blockCount: segmentation.blocks.length,
      evaluatedBlocks: blocks.length,
      blockEvalConcurrency,
      skipSynthesis,
    },
    'Running segmented prompt evaluation'
  );

  const blockNames = blocks.map((b) => b.name);
  await emitCheckpoint(options, 'block_eval.started', {
    totalBlocks: segmentation.blocks.length,
    evaluatedBlocks: blocks.length,
    concurrency: blockEvalConcurrency,
  });

  // Run per-block evaluations with bounded concurrency
  let completedBlocks = 0;
  const blockResults = await mapWithConcurrency(
    blocks,
    blockEvalConcurrency,
    async (block, index) => {
      const otherNames = blockNames.filter((n) => n !== block.name);
      await emitCheckpoint(options, 'block_eval.block.started', {
        block: block.name,
        blockIndex: index + 1,
        totalBlocks: blocks.length,
      });
      const blockResult = await runBlockEval(block, otherNames, overrideModel);
      completedBlocks += 1;
      await emitCheckpoint(options, 'block_eval.block.completed', {
        block: block.name,
        blockIndex: index + 1,
        totalBlocks: blocks.length,
        completedBlocks,
        score: blockResult.score,
        issueCount: blockResult.issues.length,
        patchCount: blockResult.patches.length,
      });
      return blockResult;
    }
  );
  await emitCheckpoint(options, 'block_eval.completed', {
    evaluatedBlocks: blockResults.length,
  });

  // Run cross-section synthesis unless quick mode asks to skip it.
  const synthesisResult = skipSynthesis
    ? null
    : await runSynthesis(blockResults, blockNames, overrideModel);
  if (skipSynthesis) {
    await emitCheckpoint(options, 'synthesis.skipped');
  } else {
    await emitCheckpoint(options, 'synthesis.completed', {
      crossSectionIssues: synthesisResult?.crossSectionIssues.length || 0,
      orderingIssues: synthesisResult?.orderingIssues.length || 0,
      missingBlocks: synthesisResult?.missingBlocks.length || 0,
    });
  }

  // Merge everything into a single PromptQualityResult
  const allIssues: Issue[] = [
    ...blockResults.flatMap((br) => br.issues),
    ...(synthesisResult?.crossSectionIssues || []),
    ...(synthesisResult?.orderingIssues || []),
    ...((synthesisResult?.missingBlocks || []).map((block) => ({
      code: 'MISSING_SECTION',
      detail: `Recommended section "${block}" is absent from the prompt`,
    })) as Issue[]),
  ];

  const allPatches: Patch[] = blockResults.flatMap((br) => br.patches);

  // Weighted average of block scores
  const totalChars = blocks.reduce((s, b) => s + b.content.length, 0);
  const weightedScore =
    totalChars > 0
      ? blockResults.reduce((acc, br, i) => {
          const weight = blocks[i].content.length / totalChars;
          return acc + br.score * weight;
        }, 0)
      : blockResults.reduce((acc, br) => acc + br.score, 0) / blockResults.length;

  // Adjust score down for cross-section issues
  const crossIssueCount =
    (synthesisResult?.crossSectionIssues.length || 0) +
    (synthesisResult?.missingBlocks.length || 0);
  const crossPenalty = Math.min(0.2, crossIssueCount * 0.05);
  const overallScore = Math.max(0, weightedScore - crossPenalty);

  // Determine severity
  let severity: 'low' | 'medium' | 'high' | 'critical';
  if (overallScore >= 0.8) severity = 'low';
  else if (overallScore >= 0.5) severity = 'medium';
  else if (overallScore >= 0.2) severity = 'high';
  else severity = 'critical';

  const merged: PromptQualityResult = {
    dimension: 'prompt_quality',
    overallScore: Math.round(overallScore * 100) / 100,
    severity,
    confidence: Math.round(
      (blockResults.reduce((s, br) => s + (br.score > 0 ? 0.85 : 0.7), 0) / blockResults.length) * 100
    ) / 100,
    issues: allIssues,
    recommendation: {
      action: allIssues.length > 0 ? 'improve_prompt_structure' : 'prompt_acceptable',
      detail:
        allIssues.length > 0
          ? `Found ${allIssues.length} issues across ${blockResults.length} blocks${skipSynthesis ? ' (cross-section synthesis skipped in quick mode)' : ''}. Apply ${allPatches.length} suggested patches.`
          : 'System prompt is well-structured.',
    },
    patches: allPatches,
    blockResults,
    synthesisResult,
  };

  logger.info(
    {
      score: merged.overallScore,
      issues: allIssues.length,
      patches: allPatches.length,
      blocks: blockResults.length,
    },
    'Prompt quality segmented evaluation complete'
  );
  await emitCheckpoint(options, 'completed', {
    score: merged.overallScore,
    issues: merged.issues.length,
    patches: merged.patches.length,
    blockCount: blockResults.length,
  });

  return merged;
}
