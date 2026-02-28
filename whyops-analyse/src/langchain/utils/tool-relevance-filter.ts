import { THRESHOLDS } from '../config';
import { createServiceLogger } from '@whyops/shared/logger';

const logger = createServiceLogger('analyse:langchain:tool-filter');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface ToolDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, any>;
  [key: string]: any;
}

export interface ToolFilterInput {
  /** All tools available to the agent */
  allTools: ToolDefinition[];
  /** The tool the agent actually chose (null if agent didn't call any tool) */
  chosenToolName: string | null;
  /** The user message / intent for this step */
  userMessage: string;
  /** Tool names used in nearby steps (±3 steps) for context */
  nearbyToolNames: string[];
}

export interface ToolFilterResult {
  /** Whether filtering was applied */
  wasFiltered: boolean;
  /** The candidate tool set for the judge */
  candidateTools: ToolDefinition[];
  /** Total tools available (for reporting) */
  totalToolsAvailable: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract words from a string (lowercase, deduped) */
function extractWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s_-]/g, ' ')
      .split(/[\s_-]+/)
      .filter((w) => w.length > 2)
  );
}

/** Check if two tool names share a prefix (e.g., account_get, account_update) */
function sharePrefix(a: string, b: string): boolean {
  const partsA = a.toLowerCase().split(/[_\-./]/);
  const partsB = b.toLowerCase().split(/[_\-./]/);
  return partsA.length > 0 && partsB.length > 0 && partsA[0] === partsB[0];
}

/** Check if two tools belong to the same functional category */
function sameCategory(a: string, b: string): boolean {
  if (sharePrefix(a, b)) return true;
  // Also check suffix patterns (e.g., get_user, get_order → both "get_" prefix)
  const partsA = a.toLowerCase().split(/[_\-./]/);
  const partsB = b.toLowerCase().split(/[_\-./]/);
  if (partsA.length > 1 && partsB.length > 1) {
    return partsA[partsA.length - 1] === partsB[partsB.length - 1];
  }
  return false;
}

/** Keyword overlap ratio between two texts */
function keywordOverlap(textA: string, textB: string): number {
  const wordsA = extractWords(textA);
  const wordsB = extractWords(textB);
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let overlap = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) overlap++;
  }
  return overlap / Math.max(wordsA.size, wordsB.size);
}

// ---------------------------------------------------------------------------
// Relevance scoring
// ---------------------------------------------------------------------------
function scoreToolRelevance(
  tool: ToolDefinition,
  chosenToolName: string | null,
  userMessage: string,
  nearbyToolNames: string[]
): number {
  // Chosen tool always gets max score
  if (chosenToolName && tool.name === chosenToolName) return 1.0;

  let score = 0;

  // Name similarity with chosen tool
  if (chosenToolName) {
    if (sharePrefix(tool.name, chosenToolName)) score += 0.4;
    else if (sameCategory(tool.name, chosenToolName)) score += 0.25;
  }

  // Description keyword overlap with user message
  const descriptionText = [tool.name, tool.description || ''].join(' ');
  const overlap = keywordOverlap(descriptionText, userMessage);
  score += overlap * 0.3;

  // Name keyword overlap with user message
  const nameOverlap = keywordOverlap(tool.name.replace(/[_\-.]/g, ' '), userMessage);
  score += nameOverlap * 0.15;

  // Used in nearby steps
  if (nearbyToolNames.includes(tool.name)) score += 0.2;

  return Math.min(score, 1.0);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Filters tools to a relevant candidate set for the judge:
 * - If ≤ TOOL_FULL_SEND_LIMIT → send all (no filtering)
 * - Otherwise → score relevance, take top TOOL_CANDIDATE_CAP
 */
export function filterToolsForJudge(input: ToolFilterInput): ToolFilterResult {
  const { allTools, chosenToolName, userMessage, nearbyToolNames } = input;

  // Small tool set — no filtering needed
  if (allTools.length <= THRESHOLDS.TOOL_FULL_SEND_LIMIT) {
    return {
      wasFiltered: false,
      candidateTools: allTools,
      totalToolsAvailable: allTools.length,
    };
  }

  // Score each tool
  const scored = allTools.map((tool) => ({
    tool,
    score: scoreToolRelevance(tool, chosenToolName, userMessage, nearbyToolNames),
  }));

  // Sort descending by score
  scored.sort((a, b) => b.score - a.score);

  // Take top N
  const candidates = scored.slice(0, THRESHOLDS.TOOL_CANDIDATE_CAP).map((s) => s.tool);

  // Ensure chosen tool is always included (should be score=1.0, but safety check)
  if (chosenToolName && !candidates.some((t) => t.name === chosenToolName)) {
    const chosenTool = allTools.find((t) => t.name === chosenToolName);
    if (chosenTool) {
      candidates.unshift(chosenTool);
    }
  }

  logger.debug(
    {
      totalTools: allTools.length,
      candidateCount: candidates.length,
      chosenTool: chosenToolName,
    },
    'Tool relevance filtering applied'
  );

  return {
    wasFiltered: true,
    candidateTools: candidates,
    totalToolsAvailable: allTools.length,
  };
}
