import { createServiceLogger } from '@whyops/shared/logger';
import { getJudgeModel, invokeWithInvalidModelRetry } from '../config';
import { toolDescriptionPrompt } from '../prompts';
import { ToolDescriptionResultSchema, type ToolDescriptionResult } from '../schemas';

const logger = createServiceLogger('analyse:langchain:chain:tool-description');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface ToolDescriptionInput {
  toolDefinitions: string;
  observedToolUsage: string;
  toolMisuseFindings: string;
}

// ---------------------------------------------------------------------------
// Chain execution
// ---------------------------------------------------------------------------

/**
 * Run the tool description quality evaluation chain.
 *
 * Evaluates all tool definitions for clarity, completeness, and disambiguation.
 * Returns per-tool scores and concrete patches.
 */
export async function runToolDescriptionChain(
  input: ToolDescriptionInput,
  overrideModel?: string
): Promise<ToolDescriptionResult> {
  const model = getJudgeModel(overrideModel);
  const structured = model.withStructuredOutput(ToolDescriptionResultSchema);
  const chain = toolDescriptionPrompt.pipe(structured);

  logger.info('Running tool description quality chain');

  const raw = await invokeWithInvalidModelRetry({
    chainName: 'tool_description',
    overrideModel,
    logger,
    invoke: () =>
      chain.invoke({
        toolDefinitions: input.toolDefinitions,
        observedToolUsage: input.observedToolUsage || '(No tool usage observed)',
        toolMisuseFindings: input.toolMisuseFindings || '(No tool misuse findings)',
      }),
  });

  const result = raw as unknown as ToolDescriptionResult;

  logger.info(
    {
      score: result.overallScore,
      toolsEvaluated: result.toolEvaluations.length,
      patches: result.patches.length,
    },
    'Tool description quality chain completed'
  );

  return result;
}
