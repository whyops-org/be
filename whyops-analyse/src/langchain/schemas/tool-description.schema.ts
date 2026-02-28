import { z } from 'zod';
import { IssueSchema, SeveritySchema, RecommendationSchema, PatchSchema } from './shared.schema';

// ---------------------------------------------------------------------------
// Tool Description Quality — trace-level judgment
// ---------------------------------------------------------------------------

/** Per-tool evaluation */
export const ToolEvaluationSchema = z.object({
  toolName: z.string().describe('Name of the tool being evaluated'),
  score: z.number().min(0).max(1),
  issues: z.array(IssueSchema),
  patches: z.array(PatchSchema),
});
export type ToolEvaluation = z.infer<typeof ToolEvaluationSchema>;

/** Full tool description quality judgment */
export const ToolDescriptionResultSchema = z.object({
  dimension: z.literal('tool_description'),
  overallScore: z.number().min(0).max(1),
  severity: SeveritySchema,
  confidence: z.number().min(0).max(1),
  issues: z.array(IssueSchema).describe('Aggregate issues across all tools'),
  recommendation: RecommendationSchema,
  patches: z.array(PatchSchema).describe('All suggested tool definition patches'),
  toolEvaluations: z.array(ToolEvaluationSchema).describe('Per-tool breakdown'),
});
export type ToolDescriptionResult = z.infer<typeof ToolDescriptionResultSchema>;
