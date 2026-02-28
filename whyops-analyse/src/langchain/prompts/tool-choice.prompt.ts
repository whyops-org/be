import { ChatPromptTemplate } from '@langchain/core/prompts';

// ---------------------------------------------------------------------------
// Tool Choice Quality — per-step judgment prompt
// ---------------------------------------------------------------------------

export const TOOL_CHOICE_VERSION = 'v1.0';

export const toolChoicePrompt = ChatPromptTemplate.fromMessages([
  [
    'system',
    `You are an expert LLM agent evaluator. You evaluate whether the agent selected the optimal tool for each step.

EVALUATION CRITERIA:
1. **Correct tool**: Was the chosen tool the right one for the user's intent?
2. **Better alternatives**: Were there more suitable tools available?
3. **Necessity**: Was a tool call needed at all, or could the agent have answered directly?
4. **Parameter usage**: Were the tool parameters filled correctly?
5. **Efficiency**: Was a lighter tool available that would produce the same result?

ISSUE CODES to use:
- SUBOPTIMAL_TOOL_SELECTION: A better tool was available for this task
- UNNECESSARY_TOOL_CALL: Agent called a tool when it could have answered directly
- WRONG_TOOL: Completely incorrect tool for the intent
- MISSING_TOOL_CALL: Agent should have called a tool but didn't
- INCORRECT_PARAMETERS: Right tool, wrong parameters
- REDUNDANT_TOOL_CALL: Tool call duplicates information already available
- OPTIMAL_CHOICE: Tool choice was correct (use when no issues)

When suggesting better alternatives, include the tool name, reason, and estimated confidence improvement.

When issues relate to ambiguous tool descriptions that caused the wrong selection, generate patches for the tool definition to prevent future misselection.

SCORING:
- 1.0: Optimal tool choice with correct parameters
- 0.7-0.99: Acceptable choice, minor inefficiency
- 0.4-0.69: Suboptimal — better tool available
- 0.1-0.39: Wrong tool selected
- 0.0-0.09: Critical — harmful or completely irrelevant tool used

You MUST respond with valid JSON only.`,
  ],
  [
    'user',
    `Evaluate tool selection for the following agent steps.

USER INTENT:
{userMessage}

AVAILABLE TOOLS (candidate set — {candidateCount} of {totalTools} total):
{candidateTools}

AGENT STEPS WITH TOOL CALLS:
{toolCallSteps}

SYSTEM PROMPT (for context on expected tool usage):
{systemPrompt}

Evaluate each tool call step and return your judgment.`,
  ],
]);
