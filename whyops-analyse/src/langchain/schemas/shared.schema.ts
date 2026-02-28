import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared atomic types reused across all dimension schemas
// ---------------------------------------------------------------------------

/** Machine-readable issue found by the judge */
export const IssueSchema = z.object({
  code: z.string().describe('Machine-readable issue code, e.g. PARTIAL_HALLUCINATION, VAGUE_ROLE'),
  detail: z.string().describe('Human-readable one-sentence explanation'),
});
export type Issue = z.infer<typeof IssueSchema>;

/** Severity levels */
export const SeveritySchema = z.enum(['low', 'medium', 'high', 'critical']);
export type Severity = z.infer<typeof SeveritySchema>;

/** A suggested diff patch for system prompt or tool definition */
export const PatchSchema = z.object({
  target: z.enum(['system_prompt', 'tool_definition']).describe('What this patch applies to'),
  toolName: z.string().nullable().describe('Tool name — only when target=tool_definition, null otherwise'),
  block: z.string().nullable().describe('Prompt block name — only when target=system_prompt, null otherwise'),
  operation: z.enum(['replace', 'append', 'remove']).describe('Type of change'),
  path: z.string().nullable().describe('JSON path for tool schema patches, e.g. parameters.properties.query.description. Null if not applicable'),
  original: z.string().nullable().describe('Original text being changed (null for append operations)'),
  suggested: z.string().describe('Suggested replacement or addition'),
  rationale: z.string().describe('Why this change improves quality'),
});
export type Patch = z.infer<typeof PatchSchema>;

/** A better tool alternative suggested by the judge */
export const ToolAlternativeSchema = z.object({
  toolName: z.string().describe('Name of the better alternative tool'),
  reason: z.string().describe('Why this tool would be better'),
  confidenceGain: z.number().min(0).max(1).describe('Estimated score improvement 0-1'),
});
export type ToolAlternative = z.infer<typeof ToolAlternativeSchema>;

/** Standard recommendation block */
export const RecommendationSchema = z.object({
  action: z.string().describe('Short action verb phrase, e.g. add_grounding_instruction'),
  detail: z.string().describe('One-sentence explanation of what to do'),
});
export type Recommendation = z.infer<typeof RecommendationSchema>;
