import { createServiceLogger } from '@whyops/shared/logger';
import { getJudgeModel, invokeWithInvalidModelRetry } from '../config';
import { costEfficiencyPrompt } from '../prompts';
import { CostEfficiencyResultSchema, type CostEfficiencyResult } from '../schemas';

const logger = createServiceLogger('analyse:langchain:chain:cost-efficiency');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface CostEfficiencyInput {
  traceStepsWithMetrics: string;
  staticCostFindings: string;
}

// ---------------------------------------------------------------------------
// Chain execution
// ---------------------------------------------------------------------------

/**
 * Run the cost/latency efficiency evaluation chain.
 *
 * Evaluates per-step model choices, token usage, and latency.
 * Produces a summary with estimated potential savings.
 */
export async function runCostEfficiencyChain(
  input: CostEfficiencyInput,
  overrideModel?: string
): Promise<CostEfficiencyResult> {
  const model = getJudgeModel(overrideModel);
  const structured = model.withStructuredOutput(CostEfficiencyResultSchema);
  const chain = costEfficiencyPrompt.pipe(structured);

  logger.info('Running cost efficiency chain');

  const raw = await invokeWithInvalidModelRetry({
    chainName: 'cost_efficiency',
    overrideModel,
    logger,
    invoke: () =>
      chain.invoke({
        traceStepsWithMetrics: input.traceStepsWithMetrics,
        staticCostFindings: input.staticCostFindings || '(No prior static cost findings)',
      }),
  });

  const result = raw as unknown as CostEfficiencyResult;

  logger.info(
    {
      score: result.overallScore,
      stepsEvaluated: result.stepEvaluations.length,
      potentialSavings: result.summary.potentialSavingsPercent,
    },
    'Cost efficiency chain completed'
  );

  return result;
}
