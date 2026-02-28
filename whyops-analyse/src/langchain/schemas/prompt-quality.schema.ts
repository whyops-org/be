import { z } from 'zod';
import { IssueSchema, SeveritySchema, RecommendationSchema, PatchSchema } from './shared.schema';

// ---------------------------------------------------------------------------
// Prompt Quality — trace-level judgment
// ---------------------------------------------------------------------------

/** Result for a single prompt block (used in segmented/large prompt flow) */
export const PromptBlockResultSchema = z.object({
  block: z.string().describe('Name of the prompt block (role, policy, tooling, examples, constraints, etc.)'),
  score: z.number().min(0).max(1),
  issues: z.array(IssueSchema),
  patches: z.array(PatchSchema),
});
export type PromptBlockResult = z.infer<typeof PromptBlockResultSchema>;

/** Cross-section synthesis result (for segmented prompts) */
export const PromptSynthesisResultSchema = z.object({
  crossSectionIssues: z.array(IssueSchema).describe('Issues that span multiple prompt blocks (contradictions, redundancy, etc.)'),
  missingBlocks: z.array(z.string()).describe('Recommended sections that are absent from the prompt'),
  orderingIssues: z.array(IssueSchema).describe('Problems with section ordering'),
});
export type PromptSynthesisResult = z.infer<typeof PromptSynthesisResultSchema>;

/** Full prompt quality judgment (final merged output) */
export const PromptQualityResultSchema = z.object({
  dimension: z.literal('prompt_quality'),
  overallScore: z.number().min(0).max(1),
  severity: SeveritySchema,
  confidence: z.number().min(0).max(1),
  issues: z.array(IssueSchema).describe('All issues found across the prompt'),
  recommendation: RecommendationSchema,
  patches: z.array(PatchSchema).describe('Suggested prompt changes'),
  blockResults: z.array(PromptBlockResultSchema).nullable().describe('Per-block results (only for segmented prompts), null if not segmented'),
  synthesisResult: PromptSynthesisResultSchema.nullable().describe('Cross-section analysis (only for segmented prompts), null if not segmented'),
});
export type PromptQualityResult = z.infer<typeof PromptQualityResultSchema>;
