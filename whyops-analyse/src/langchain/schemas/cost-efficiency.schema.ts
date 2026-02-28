import { z } from 'zod';
import { IssueSchema, SeveritySchema, RecommendationSchema } from './shared.schema';

// ---------------------------------------------------------------------------
// Cost / Latency Efficiency — per-step + trace-level judgment
// ---------------------------------------------------------------------------

/** Per-step cost evaluation */
export const StepCostEvaluationSchema = z.object({
  stepId: z.number(),
  model: z.string().nullable().describe('Model used for this step, null if unknown'),
  totalTokens: z.number().nullable().describe('Total tokens used, null if unknown'),
  latencyMs: z.number().nullable().describe('Latency in ms, null if unknown'),
  couldDowngrade: z.boolean().describe('Could a cheaper/faster model handle this step?'),
  suggestedModel: z.string().nullable().describe('Cheaper model that would suffice, null if no downgrade possible'),
  issues: z.array(IssueSchema),
});
export type StepCostEvaluation = z.infer<typeof StepCostEvaluationSchema>;

/** Full cost/latency efficiency judgment */
export const CostEfficiencyResultSchema = z.object({
  dimension: z.literal('cost_efficiency'),
  overallScore: z.number().min(0).max(1),
  severity: SeveritySchema,
  confidence: z.number().min(0).max(1),
  issues: z.array(IssueSchema),
  recommendation: RecommendationSchema,
  stepEvaluations: z.array(StepCostEvaluationSchema).describe('Per-step cost analysis'),
  summary: z.object({
    totalTokensUsed: z.number(),
    estimatedTotalCostUsd: z.number().nullable().describe('Estimated total cost in USD, null if unknown'),
    avgLatencyMs: z.number().nullable().describe('Average latency in ms, null if unknown'),
    stepsCouldDowngrade: z.number().describe('Number of steps where a cheaper model would work'),
    potentialSavingsPercent: z.number().min(0).max(100).describe('Estimated cost savings %'),
  }),
});
export type CostEfficiencyResult = z.infer<typeof CostEfficiencyResultSchema>;
