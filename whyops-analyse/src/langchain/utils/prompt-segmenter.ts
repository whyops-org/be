import { ChatPromptTemplate } from '@langchain/core/prompts';
import { z } from 'zod';
import { getJudgeModel, invokeWithInvalidModelRetry, estimateTokens, THRESHOLDS } from '../config';
import { createServiceLogger } from '@whyops/shared/logger';

const logger = createServiceLogger('analyse:langchain:prompt-segmenter');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface PromptBlock {
  /** Semantic name for this block (role, policy, tooling, examples, constraints, style, fallback, other) */
  name: string;
  /** Raw text content of this block */
  content: string;
  /** 0-based start line index in the original prompt */
  startLine: number;
  /** 0-based end line index in the original prompt */
  endLine: number;
}

export interface SegmentationResult {
  /** Whether segmentation was applied (false = prompt was small enough for single-pass) */
  wasSegmented: boolean;
  /** Method used: 'none' | 'heuristic' | 'llm' */
  method: 'none' | 'heuristic' | 'llm';
  /** The blocks produced */
  blocks: PromptBlock[];
  /** Original full text */
  fullText: string;
}

// ---------------------------------------------------------------------------
// Keyword patterns for heuristic section detection
// ---------------------------------------------------------------------------
const SECTION_HEADER_PATTERNS = [
  // Markdown headers
  /^#{1,4}\s+(.+)$/,
  // Labelled sections (e.g. "Role:", "Instructions:", etc.)
  /^(role|instructions|guidelines|policy|policies|tools|tooling|examples|example|constraints|rules|style|format|formatting|output|fallback|error handling|context|background|persona|objective|goal|goals|safety|guardrails|restrictions|behavior|responses?)\s*:/i,
  // Numbered sections
  /^(\d+)\.\s+(.+)$/,
  // XML-style tags often used in system prompts
  /^<(role|instructions|tools|examples|constraints|rules|context|persona|guidelines|output_format|safety)>/i,
];

// Section name normalization map
const NAME_ALIASES: Record<string, string> = {
  instructions: 'policy',
  guidelines: 'policy',
  policies: 'policy',
  rules: 'constraints',
  restrictions: 'constraints',
  guardrails: 'constraints',
  safety: 'constraints',
  tools: 'tooling',
  format: 'style',
  formatting: 'style',
  output: 'style',
  output_format: 'style',
  persona: 'role',
  objective: 'role',
  goal: 'role',
  goals: 'role',
  background: 'context',
  example: 'examples',
  responses: 'style',
  response: 'style',
  behavior: 'policy',
  'error handling': 'fallback',
};

function normalizeSectionName(raw: string): string {
  const lower = raw.toLowerCase().trim();
  return NAME_ALIASES[lower] || lower;
}

// ---------------------------------------------------------------------------
// Heuristic segmentation
// ---------------------------------------------------------------------------
function heuristicSegment(text: string): PromptBlock[] {
  const lines = text.split('\n');
  const blocks: PromptBlock[] = [];

  let currentName = 'preamble';
  let currentLines: string[] = [];
  let currentStartLine = 0;

  function flush(endLine: number) {
    const content = currentLines.join('\n').trim();
    if (content.length > 0) {
      blocks.push({
        name: currentName,
        content,
        startLine: currentStartLine,
        endLine,
      });
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let matched = false;

    for (const pattern of SECTION_HEADER_PATTERNS) {
      const match = line.match(pattern);
      if (match) {
        // Flush previous block
        flush(i - 1);

        // Determine new section name
        const rawName = match[1] || match[2] || line;
        currentName = normalizeSectionName(rawName);
        currentLines = [line];
        currentStartLine = i;
        matched = true;
        break;
      }
    }

    if (!matched) {
      currentLines.push(line);
    }
  }

  // Flush last block
  flush(lines.length - 1);

  return blocks;
}

// ---------------------------------------------------------------------------
// LLM-based segmentation fallback
// ---------------------------------------------------------------------------
const LlmSegmentSchema = z.object({
  blocks: z.array(
    z.object({
      name: z.string().describe('Block name: role, policy, tooling, examples, constraints, style, fallback, context, other'),
      startLine: z.number().describe('0-based start line'),
      endLine: z.number().describe('0-based end line (inclusive)'),
    })
  ),
});

async function llmSegment(text: string): Promise<PromptBlock[]> {
  const lines = text.split('\n');
  const model = getJudgeModel();
  const structured = model.withStructuredOutput(LlmSegmentSchema);

  const prompt = ChatPromptTemplate.fromMessages([
    [
      'system',
      `You are a system prompt analyzer. Given a system prompt, segment it into named semantic blocks.
Block names must be one of: role, policy, tooling, examples, constraints, style, fallback, context, other.
Return the start and end line numbers (0-based, inclusive) for each block.
Every line must belong to exactly one block. Do not overlap or skip lines.`,
    ],
    [
      'user',
      `Segment this system prompt (${lines.length} lines total):\n\n{prompt}`,
    ],
  ]);

  const chain = prompt.pipe(structured);

  const raw = await invokeWithInvalidModelRetry({
    chainName: 'prompt_segmentation_llm',
    logger,
    invoke: () =>
      chain.invoke({
        prompt: lines.map((l, i) => `${i}: ${l}`).join('\n'),
      }),
  });

  const result = raw as unknown as { blocks: { name: string; startLine: number; endLine: number }[] };

  return result.blocks.map((b) => ({
    name: b.name,
    content: lines.slice(b.startLine, b.endLine + 1).join('\n').trim(),
    startLine: b.startLine,
    endLine: b.endLine,
  }));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Segments a system prompt into semantic blocks using the hybrid approach:
 * 1. If prompt ≤ threshold → no segmentation
 * 2. Try heuristic segmentation
 * 3. If heuristic produces only 1 block → LLM fallback
 */
export async function segmentPrompt(systemPrompt: string): Promise<SegmentationResult> {
  const tokenEstimate = estimateTokens(systemPrompt);

  // Small prompt — no segmentation needed
  if (tokenEstimate <= THRESHOLDS.PROMPT_SEGMENT_TOKEN_LIMIT) {
    return {
      wasSegmented: false,
      method: 'none',
      blocks: [
        {
          name: 'full',
          content: systemPrompt,
          startLine: 0,
          endLine: systemPrompt.split('\n').length - 1,
        },
      ],
      fullText: systemPrompt,
    };
  }

  // Try heuristic first
  const heuristicBlocks = heuristicSegment(systemPrompt);

  if (heuristicBlocks.length > 1) {
    logger.info(
      { blockCount: heuristicBlocks.length, method: 'heuristic', tokenEstimate },
      'Prompt segmented via heuristic'
    );
    return {
      wasSegmented: true,
      method: 'heuristic',
      blocks: heuristicBlocks,
      fullText: systemPrompt,
    };
  }

  // Heuristic produced single block — try LLM fallback
  try {
    logger.info({ tokenEstimate }, 'Heuristic produced single block, trying LLM segmentation');
    const llmBlocks = await llmSegment(systemPrompt);

    if (llmBlocks.length > 1) {
      logger.info(
        { blockCount: llmBlocks.length, method: 'llm', tokenEstimate },
        'Prompt segmented via LLM'
      );
      return {
        wasSegmented: true,
        method: 'llm',
        blocks: llmBlocks,
        fullText: systemPrompt,
      };
    }
  } catch (err) {
    logger.warn({ err }, 'LLM segmentation failed, falling back to single block');
  }

  // Both methods failed to segment — treat as single block
  return {
    wasSegmented: false,
    method: 'none',
    blocks: [
      {
        name: 'full',
        content: systemPrompt,
        startLine: 0,
        endLine: systemPrompt.split('\n').length - 1,
      },
    ],
    fullText: systemPrompt,
  };
}
