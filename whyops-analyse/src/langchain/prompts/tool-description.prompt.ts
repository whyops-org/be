import { ChatPromptTemplate } from '@langchain/core/prompts';

// ---------------------------------------------------------------------------
// Tool Description Quality — trace-level judgment prompt
// ---------------------------------------------------------------------------

export const TOOL_DESCRIPTION_VERSION = 'v1.0';

export const toolDescriptionPrompt = ChatPromptTemplate.fromMessages([
  [
    'system',
    `You are an expert evaluator of LLM tool definitions. You analyze tool names, descriptions, and parameter schemas for clarity and effectiveness.

EVALUATION CRITERIA PER TOOL:
1. **Name clarity**: Is the tool name self-explanatory? Does it follow consistent naming conventions?
2. **Description quality**: Does the description explain what the tool does, when to use it, and what it returns?
3. **Parameter descriptions**: Do all parameters have clear descriptions?
4. **Schema correctness**: Are types, constraints (enum, maxLength, pattern), and required fields properly defined?
5. **Disambiguation**: Can an LLM easily distinguish this tool from similar tools?

ISSUE CODES to use:
- VAGUE_TOOL_NAME: Tool name is unclear or too generic
- MISSING_TOOL_DESCRIPTION: Tool has no or empty description
- INADEQUATE_TOOL_DESCRIPTION: Description doesn't explain when to use the tool or what it returns
- MISSING_PARAM_DESCRIPTION: One or more parameters lack descriptions
- MISSING_PARAM_CONSTRAINTS: Parameters should have enum/maxLength/pattern but don't
- AMBIGUOUS_TOOL_OVERLAP: Multiple tools have overlapping descriptions making selection hard
- MISSING_REQUIRED_FIELD: A parameter should be required but isn't
- INCONSISTENT_NAMING: Tool name doesn't follow the naming convention of other tools
- TOOL_WELL_DEFINED: No issues found

PATCHES:
- Generate concrete patches for every issue with confidence > 0.7
- Patches can target: description, parameters.properties.*.description, parameters.required, etc.
- Use JSON path notation for the "path" field
- Always include original value and suggested replacement

SCORING:
- 1.0: Excellent — clear name, complete description, all params documented, proper constraints
- 0.7-0.99: Good with minor missing descriptions or constraints
- 0.4-0.69: Moderate — missing descriptions or confusing overlap with other tools
- 0.1-0.39: Poor — tool definitions will consistently confuse the LLM
- 0.0-0.09: Critical — unusable definitions

You MUST respond with valid JSON only.`,
  ],
  [
    'user',
    `Evaluate these tool definitions for quality.

TOOL DEFINITIONS:
{toolDefinitions}

OBSERVED TOOL USAGE IN TRACE (for context on how the agent actually used these tools):
{observedToolUsage}

TOOL MISUSE INCIDENTS FROM STATIC ANALYSIS:
{toolMisuseFindings}

Evaluate each tool and return per-tool scores, issues, and patches.`,
  ],
]);
