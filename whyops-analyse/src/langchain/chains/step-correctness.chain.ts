import { createServiceLogger } from '@whyops/shared/logger';
import { getJudgeModel, invokeWithInvalidModelRetry } from '../config';
import { stepCorrectnessPrompt } from '../prompts';
import { StepCorrectnessBatchSchema, type StepCorrectnessBatch, type StepCorrectnessResult } from '../schemas';

const logger = createServiceLogger('analyse:langchain:chain:step-correctness');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface StepCorrectnessInput {
  systemPrompt: string;
  /** Formatted trace steps as a readable string */
  traceSteps: string;
  /** Static analysis findings as context */
  staticFindings: string;
}

// ---------------------------------------------------------------------------
// Chain execution
// ---------------------------------------------------------------------------

/**
 * Run the step correctness evaluation chain.
 *
 * For large traces (>TRACE_MAP_REDUCE_LIMIT), the caller (judge.service)
 * is responsible for chunking and calling this multiple times, then merging.
 * This chain evaluates whatever steps it receives.
 */
export async function runStepCorrectnessChain(
  input: StepCorrectnessInput,
  overrideModel?: string
): Promise<StepCorrectnessResult[]> {
  const model = getJudgeModel(overrideModel);
  const structured = model.withStructuredOutput(StepCorrectnessBatchSchema);
  const chain = stepCorrectnessPrompt.pipe(structured);

  logger.info('Running step correctness chain');

  const raw = await invokeWithInvalidModelRetry({
    chainName: 'step_correctness',
    overrideModel,
    logger,
    invoke: () =>
      chain.invoke({
        systemPrompt: input.systemPrompt || '(No system prompt available)',
        traceSteps: input.traceSteps,
        staticFindings: input.staticFindings || '(No prior static findings)',
      }),
  });

  const result = raw as unknown as StepCorrectnessBatch;

  logger.info({ stepCount: result.steps.length }, 'Step correctness chain completed');

  return result.steps;
}
