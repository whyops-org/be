import { z } from 'zod';
import { IssueSchema, SeveritySchema, RecommendationSchema } from './shared.schema';

// ---------------------------------------------------------------------------
// Step Correctness — per-step judgment
// ---------------------------------------------------------------------------

export const StepCorrectnessResultSchema = z.object({
  stepId: z.number().describe('The step ID being evaluated'),
  dimension: z.literal('step_correctness'),
  score: z.number().min(0).max(1).describe('Quality score 0-1, where 1 is perfect'),
  severity: SeveritySchema,
  confidence: z.number().min(0).max(1).describe('How confident the judge is in this assessment'),
  issues: z.array(IssueSchema).describe('List of issues found in this step'),
  recommendation: RecommendationSchema,
});
export type StepCorrectnessResult = z.infer<typeof StepCorrectnessResultSchema>;

/** Batch result when judging multiple steps in one call */
export const StepCorrectnessBatchSchema = z.object({
  steps: z.array(StepCorrectnessResultSchema),
});
export type StepCorrectnessBatch = z.infer<typeof StepCorrectnessBatchSchema>;
