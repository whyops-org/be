import { createServiceLogger } from '@whyops/shared/logger';
import { getJudgeModel, invokeWithInvalidModelRetry } from '../config';
import { toolChoicePrompt } from '../prompts';
import { ToolChoiceBatchSchema, type ToolChoiceBatch, type ToolChoiceResult } from '../schemas';

const logger = createServiceLogger('analyse:langchain:chain:tool-choice');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface ToolChoiceInput {
  userMessage: string;
  candidateTools: string;
  candidateCount: number;
  totalTools: number;
  toolCallSteps: string;
  systemPrompt: string;
}

// ---------------------------------------------------------------------------
// Chain execution
// ---------------------------------------------------------------------------

/**
 * Run the tool choice quality evaluation chain.
 *
 * Expects pre-filtered candidate tools (from tool-relevance-filter).
 */
export async function runToolChoiceChain(
  input: ToolChoiceInput,
  overrideModel?: string
): Promise<ToolChoiceResult[]> {
  const model = getJudgeModel(overrideModel);
  const structured = model.withStructuredOutput(ToolChoiceBatchSchema);
  const chain = toolChoicePrompt.pipe(structured);

  logger.info(
    { candidateCount: input.candidateCount, totalTools: input.totalTools },
    'Running tool choice chain'
  );

  const raw = await invokeWithInvalidModelRetry({
    chainName: 'tool_choice',
    overrideModel,
    logger,
    invoke: () =>
      chain.invoke({
        userMessage: input.userMessage,
        candidateTools: input.candidateTools,
        candidateCount: String(input.candidateCount),
        totalTools: String(input.totalTools),
        toolCallSteps: input.toolCallSteps,
        systemPrompt: input.systemPrompt || '(No system prompt available)',
      }),
  });

  const result = raw as unknown as ToolChoiceBatch;

  logger.info({ stepCount: result.steps.length }, 'Tool choice chain completed');

  return result.steps;
}
