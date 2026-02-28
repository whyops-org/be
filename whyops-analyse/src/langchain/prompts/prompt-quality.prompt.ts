import { ChatPromptTemplate } from '@langchain/core/prompts';

// ---------------------------------------------------------------------------
// Prompt Quality — trace-level judgment prompt
// ---------------------------------------------------------------------------

export const PROMPT_QUALITY_VERSION = 'v1.0';

/**
 * Single-pass prompt (for small prompts ≤ 4K tokens)
 */
export const promptQualitySinglePassPrompt = ChatPromptTemplate.fromMessages([
  [
    'system',
    `You are an expert system prompt evaluator. You analyze system prompts for quality, clarity, completeness, and effectiveness.

EVALUATION CRITERIA:
1. **Role clarity**: Is the agent's role/identity clearly defined with boundaries?
2. **Instruction clarity**: Are instructions unambiguous and actionable?
3. **Completeness**: Are all necessary sections present (role, constraints, error handling, output format)?
4. **Consistency**: Are there contradictions between different parts?
5. **Tool guidance**: Does the prompt guide tool usage effectively?
6. **Error handling**: Does the prompt define fallback behavior?
7. **Output format**: Is the expected output format specified?
8. **Conciseness**: Is the prompt concise without losing important information?

ISSUE CODES to use:
- VAGUE_ROLE_DEFINITION: Role doesn't specify domain or boundaries
- CONTRADICTORY_INSTRUCTIONS: Different parts give conflicting guidance
- MISSING_ERROR_HANDLING: No fallback behavior defined
- MISSING_OUTPUT_FORMAT: Expected output format not specified
- MISSING_CONSTRAINTS: No safety/scope constraints
- REDUNDANT_INSTRUCTIONS: Same instruction repeated unnecessarily
- AMBIGUOUS_INSTRUCTION: Instruction can be interpreted multiple ways
- MISSING_TOOL_GUIDANCE: No guidance on when/how to use tools
- OVERLY_VERBOSE: Excessive text that could be condensed
- PROMPT_WELL_STRUCTURED: No significant issues found

PATCHES:
- Generate concrete text diff patches for every issue with confidence > 0.7
- Each patch must include: original text, suggested replacement, and rationale
- Use operation "replace" to change text, "append" to add new sections, "remove" to delete redundancy
- Reference the block name (role, policy, tooling, examples, constraints, style, fallback)

SCORING:
- 1.0: Excellent — clear, complete, consistent, well-structured
- 0.7-0.99: Good with minor improvements possible
- 0.4-0.69: Moderate issues — missing sections or ambiguities
- 0.1-0.39: Poor — significant problems that will cause agent failures
- 0.0-0.09: Critical — prompt is harmful or fundamentally broken

You MUST respond with valid JSON only.`,
  ],
  [
    'user',
    `Evaluate this system prompt for quality.

SYSTEM PROMPT:
{systemPrompt}

OBSERVED AGENT BEHAVIOR (from trace):
{observedBehavior}

STATIC ANALYSIS FINDINGS:
{staticFindings}

Return your evaluation with issues and suggested patches.`,
  ],
]);

/**
 * Per-block prompt (for segmented large prompts)
 */
export const promptQualityBlockPrompt = ChatPromptTemplate.fromMessages([
  [
    'system',
    `You are an expert system prompt evaluator. You are evaluating ONE BLOCK of a larger system prompt.

Evaluate this block for:
1. Clarity and actionability of instructions within this block
2. Internal consistency
3. Completeness for its intended purpose
4. Conciseness

Generate patches for any issues found. Reference the block name in each patch.

ISSUE CODES: VAGUE_ROLE_DEFINITION, CONTRADICTORY_INSTRUCTIONS, AMBIGUOUS_INSTRUCTION, REDUNDANT_INSTRUCTIONS, OVERLY_VERBOSE, INCOMPLETE_SECTION, BLOCK_WELL_STRUCTURED

You MUST respond with valid JSON only.`,
  ],
  [
    'user',
    `Evaluate this prompt block.

BLOCK NAME: {blockName}
BLOCK CONTENT (lines {startLine}-{endLine}):
{blockContent}

CONTEXT: This block is part of a larger system prompt for an LLM agent. The full prompt has these other blocks: {otherBlockNames}

Return your evaluation with score, issues, and patches.`,
  ],
]);

/**
 * Cross-section synthesis prompt (for segmented large prompts)
 */
export const promptQualitySynthesisPrompt = ChatPromptTemplate.fromMessages([
  [
    'system',
    `You are an expert system prompt evaluator performing a cross-section synthesis.

You have already evaluated individual blocks of a system prompt. Now analyze cross-section quality:

1. **Contradictions**: Do different blocks give conflicting instructions?
2. **Redundancy**: Is the same instruction repeated across blocks?
3. **Missing sections**: Are any critical sections absent entirely?
4. **Ordering**: Are sections in a logical order (role first, then policy, then tools, etc.)?
5. **Overall coherence**: Do all blocks work together as a coherent whole?

ISSUE CODES: CROSS_SECTION_CONTRADICTION, CROSS_SECTION_REDUNDANCY, MISSING_SECTION, POOR_SECTION_ORDERING, INCOHERENT_FLOW

You MUST respond with valid JSON only.`,
  ],
  [
    'user',
    `Synthesize the cross-section quality of this system prompt.

PER-BLOCK EVALUATION SUMMARIES:
{blockSummaries}

BLOCK NAMES PRESENT: {blockNames}

Return cross-section issues, missing blocks, and ordering issues.`,
  ],
]);
