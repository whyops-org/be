import { z } from 'zod';
import { IssueSchema, SeveritySchema, RecommendationSchema, PatchSchema, ToolAlternativeSchema } from './shared.schema';

// ---------------------------------------------------------------------------
// Tool Choice Quality — per-step judgment
// ---------------------------------------------------------------------------

export const ToolChoiceResultSchema = z.object({
  stepId: z.number().describe('The step ID being evaluated'),
  dimension: z.literal('tool_choice'),
  score: z.number().min(0).max(1).describe('Quality score 0-1'),
  severity: SeveritySchema,
  confidence: z.number().min(0).max(1),
  chosenTool: z.string().describe('Name of the tool the agent selected'),
  candidateToolsEvaluated: z.number().describe('Number of candidate tools considered by the judge'),
  issues: z.array(IssueSchema),
  betterAlternatives: z.array(ToolAlternativeSchema).describe('Tools that would have been a better choice'),
  recommendation: RecommendationSchema,
  patches: z.array(PatchSchema).describe('Suggested tool description/schema patches to guide better future selection'),
});
export type ToolChoiceResult = z.infer<typeof ToolChoiceResultSchema>;

/** Batch result when judging multiple tool-call steps */
export const ToolChoiceBatchSchema = z.object({
  steps: z.array(ToolChoiceResultSchema),
});
export type ToolChoiceBatch = z.infer<typeof ToolChoiceBatchSchema>;
