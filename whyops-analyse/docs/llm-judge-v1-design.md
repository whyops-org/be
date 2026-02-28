# LLM Judge v1 — Complete Design Document

## Overview

Stage 2 of the RALPH analysis pipeline. Adds semantic LLM-based judgment on top of Stage 1 static/deterministic findings.

**Hard requirement:** Strict JSON output only. No free text blobs.

The judge evaluates 5 dimensions, returns scored findings with machine-readable issue codes, and produces **concrete diff patches** for prompt quality and tool description improvements.

---

## 5 Judgment Dimensions

| # | Dimension | Scope | What It Evaluates | Produces Patches? |
|---|---|---|---|---|
| 1 | **Step Correctness** | Per-step | Did each LLM response follow instructions, stay grounded, avoid hallucination? | No |
| 2 | **Tool Choice Quality** | Per-step | Did the agent pick the right tool? Was there a better alternative? | Yes (tool description patches to guide better selection) |
| 3 | **Prompt Quality** | Trace-level | Is the system prompt clear, complete, non-contradictory, well-structured? | Yes (system prompt diff patches) |
| 4 | **Tool Description Quality** | Trace-level | Are tool names, descriptions, and parameter schemas clear and unambiguous? | Yes (tool definition diff patches) |
| 5 | **Cost/Latency Efficiency** | Per-step + Trace-level | Was the model choice appropriate? Could cheaper/faster models work? Were tokens wasted? | No |

### Input Requirements Per Dimension

| Dimension | Required Context |
|---|---|
| Step Correctness | `system_message`, `user_message` → `llm_response` pairs, tool results, step position in trace |
| Tool Choice | Available `tools[]`, user intent, chosen tool, candidate tool set (filtered), nearby step tool usage |
| Prompt Quality | Full `systemMessage` text (or segmented blocks for large prompts), observed agent behavior from trace |
| Tool Description Quality | `tools[]` JSON definitions (name, description, parameters schema), any tool misuse observed in trace |
| Cost/Latency Efficiency | Per-step: model, tokens, latency. Trace-level: total cost, task complexity estimate |

---

## Diff Patch System (V1)

### Philosophy
- Patches are **SUGGESTIONS**, never auto-applied
- Every patch includes `original` + `suggested` + `rationale` for human review
- Only generated when confidence > 0.7 — otherwise issue is reported without a patch
- Feeds directly into Stage 3 (Counterfactual Generator) as hypothesis input

### System Prompt Patches

```json
{
  "patches": [
    {
      "target": "system_prompt",
      "block": "policy",
      "operation": "replace",
      "original": "Always respond in JSON format.",
      "suggested": "Always respond in valid JSON. If you cannot produce valid JSON, return {\"error\": \"<reason>\"}.",
      "rationale": "No fallback for JSON generation failures"
    },
    {
      "target": "system_prompt",
      "block": "role",
      "operation": "append",
      "original": null,
      "suggested": "If the user's request falls outside your domain, say so explicitly rather than guessing.",
      "rationale": "No boundary instruction — agent may hallucinate on out-of-scope topics"
    }
  ]
}
```

### Tool Definition Patches

```json
{
  "patches": [
    {
      "target": "tool_definition",
      "toolName": "search_docs",
      "operation": "replace",
      "path": "description",
      "original": "Search documents",
      "suggested": "Search the knowledge base for relevant documents. Returns top 5 matches ranked by relevance. Use when the user asks about product features, policies, or documentation.",
      "rationale": "Description should specify when to use the tool and what it returns"
    },
    {
      "target": "tool_definition",
      "toolName": "search_docs",
      "operation": "replace",
      "path": "parameters.properties.query.description",
      "original": "",
      "suggested": "Natural language search query. Use specific keywords rather than full sentences.",
      "rationale": "LLMs perform better with explicit guidance on query format"
    }
  ]
}
```

### Tool Schema Patches (V1 Scope — Light-Touch Only)

V1 schema patches are limited to:
- Adding missing parameter descriptions
- Adding missing enum values when obvious from trace usage
- Suggesting type constraints (maxLength, pattern, etc.)

**NOT in V1 scope:** restructuring entire schemas, adding/removing parameters, changing types. That is Stage 3.

---

## Scaling Strategy — Hybrid Size-Adaptive Pattern

The same hybrid philosophy applies to all three scaling axes:

| Problem | Threshold | Small Path | Large Path |
|---|---|---|---|
| System prompt | ≤ 4K tokens | Single pass | Segment → per-block judge → cross-section synthesis |
| Tool definitions | ≤ 15 tools | Send all | Relevance filter → candidate set (8-15 tools) |
| Trace events | ≤ 30 events | Single pass | Per-step map → global reduce |

### A. Long System Prompt Handling

#### Flow
```
Input: system prompt
  │
  ├─ prompt ≤ 4K tokens?
  │   YES → Single-pass full judgment (one LLM call)
  │   NO  ↓
  │
  ├─ Heuristic segmentation
  │   Split on: markdown headers, "Role:"/"Instructions:" patterns,
  │   numbered sections, blank-line-delimited paragraphs
  │   → Produces named blocks: [role, policy, tooling, examples, constraints, ...]
  │   → If only 1 block produced (unstructured prompt) → LLM segmentation fallback
  │
  ├─ Per-block judgment (parallelizable)
  │   block:role     → { score, issues, patches }
  │   block:policy   → { score, issues, patches }
  │   block:tooling  → { score, issues, patches }
  │   ...
  │
  ├─ Cross-section synthesis pass
  │   Input: all per-block results + block summaries (NOT full text again)
  │   Checks: contradictions between blocks, missing sections, ordering issues, redundancy
  │   Output: cross-section issues + overall score
  │
  └─ Merged result
      → All per-block issues + patches
      → Cross-section issues
      → Overall prompt quality score
```

#### What Synthesis Catches That Per-Block Misses
- **Contradictions**: Role says "be concise" but Examples show verbose outputs
- **Redundancy**: Same instruction in policy AND constraints
- **Missing sections**: No error handling, no fallback behavior
- **Ordering problems**: Examples before the rules they demonstrate

#### Segmentation Approach
1. **Primary: Heuristic (no LLM call)**
   - Split on markdown headers (`##`, `###`)
   - Split on keyword patterns (`Role:`, `Instructions:`, `Tools:`, `Examples:`, `Constraints:`)
   - Split on numbered sections
   - Fallback: paragraph-level split with ~500 token chunks

2. **Fallback: LLM segmentation (one cheap call)**
   - Only triggered when heuristic produces a single block
   - Asks LLM to identify semantic sections and return JSON block map

### B. Many Tools Handling

#### Problem Scale
| Agent Type | Typical Tool Count |
|---|---|
| Simple chatbot | 2–5 tools |
| Customer support | 10–20 tools |
| Coding agent | 20–40 tools |
| Enterprise orchestrator | 50–100+ tools |

#### Flow
```
Input: N tools + step being judged
  │
  ├─ N ≤ 15?
  │   YES → Send all tools to judge
  │   NO  ↓
  │
  ├─ Deterministic relevance filter
  │   ├─ Always include: the chosen tool
  │   ├─ Keyword match: tool name/description overlaps with user message
  │   ├─ Category match: tools sharing prefix/domain (account_*, search_*)
  │   ├─ Recent usage: tools used in nearby steps of the trace
  │   → Produces candidate set of ~8-15 tools
  │   → Cap at 20 by relevance score
  │
  ├─ Judge evaluates tool choice against candidate set
  │   Input: user intent, candidate tools, chosen tool
  │   Output: score, better alternatives, patches
  │
  └─ Edge cases:
      NO_TOOL_CALLED → widen filter, show top 5 relevant unused tools
      UNKNOWN_TOOL   → flag as hallucinated tool name
      MULTI_TOOL_STEP → judge each call independently
```

#### Relevance Scoring Algorithm
```
scoreToolRelevance(tool, userMessage, chosenTool):
  if tool == chosenTool → 1.0 (always include)
  score = 0
  + 0.4 if name shares prefix/suffix with chosen tool
  + 0.3 × keyword overlap between tool.description and userMessage
  + 0.3 if same functional category (shared naming convention)
  + 0.2 if used in nearby steps of this trace
  → cap at 1.0
```

#### Token Cost Savings
| Tool Count | Without filter | With filter |
|---|---|---|
| 10 tools | ~2K tokens | ~2K tokens (same) |
| 40 tools | ~8K tokens/step | ~3K tokens |
| 100 tools | ~20K tokens/step | ~3-4K tokens |

### C. Long Trace Handling (Map-Reduce)

For traces with > 30 events:
1. **Map phase**: Judge each step independently (parallelizable)
2. **Reduce phase**: Global synthesis pass over per-step scores
   - Identifies trace-level patterns (degradation over time, cascading errors)
   - Produces overall trace quality score
   - No raw events re-sent — only per-step summaries

---

## LangChain.js Integration

### Packages
```json
{
  "@langchain/core": "^0.3.x",
  "@langchain/openai": "^0.4.x",
  "zod": "^3.24.x"
}
```

### LiteLLM Proxy
All judge LLM calls go through a **LiteLLM proxy** which exposes an OpenAI-compatible `/v1` endpoint.
This means we always use `ChatOpenAI` from `@langchain/openai` regardless of the underlying model.
LiteLLM handles routing to the correct provider (Azure OpenAI, Anthropic, etc.).

- **Base URL**: Configured via `JUDGE_LLM_BASE_URL`
- **Default model**: `azure/gpt-4.1` (GPT-4.1 on Azure via LiteLLM)
- **Auth**: `JUDGE_LLM_API_KEY` is the LiteLLM proxy key

### Key Features Used
1. **`withStructuredOutput(zodSchema)`** — Forces strict JSON matching Zod schemas. No free text.
2. **`ChatPromptTemplate`** — Reusable, versioned prompt templates per dimension
3. **`RunnableSequence` / `RunnableParallel`** (LCEL) — Composable evaluation pipelines
4. **Model factory via LiteLLM** — Swap judge model by changing `JUDGE_LLM_MODEL` env var (e.g. `azure/gpt-4.1`, `gpt-4o-mini`, `claude-3.5-sonnet`)

---

## File Structure

```
whyops-analyse/src/
├── langchain/                              # All LangChain code isolated here
│   ├── config.ts                           # LLM model factory, API key, thresholds
│   ├── schemas/                            # Zod schemas for structured output
│   │   ├── step-correctness.schema.ts
│   │   ├── tool-choice.schema.ts
│   │   ├── prompt-quality.schema.ts
│   │   ├── tool-description.schema.ts
│   │   ├── cost-efficiency.schema.ts
│   │   ├── shared.schema.ts                # Shared types (Issue, Patch, etc.)
│   │   └── index.ts
│   ├── prompts/                            # Prompt templates per dimension
│   │   ├── step-correctness.prompt.ts
│   │   ├── tool-choice.prompt.ts
│   │   ├── prompt-quality.prompt.ts
│   │   ├── tool-description.prompt.ts
│   │   ├── cost-efficiency.prompt.ts
│   │   └── index.ts
│   ├── chains/                             # LCEL evaluation chains
│   │   ├── step-correctness.chain.ts
│   │   ├── tool-choice.chain.ts
│   │   ├── prompt-quality.chain.ts
│   │   ├── tool-description.chain.ts
│   │   ├── cost-efficiency.chain.ts
│   │   └── index.ts
│   ├── utils/                              # Scaling utilities
│   │   ├── prompt-segmenter.ts             # Heuristic + LLM fallback segmentation
│   │   ├── tool-relevance-filter.ts        # Deterministic tool candidate filtering
│   │   └── index.ts
│   └── index.ts                            # Public API for the langchain module
├── services/
│   ├── analysis.service.ts                 # Existing static analyzer (Stage 1)
│   ├── judge.service.ts                    # NEW: LLM Judge orchestrator (Stage 2)
│   └── ...
├── routes/
│   ├── analyses.ts                         # Existing + new POST /api/analyses/judge
│   └── ...
```

---

## API Endpoint

### `POST /api/analyses/judge`

#### Request
```json
{
  "traceId": "trace-abc-123",
  "dimensions": ["step_correctness", "tool_choice", "prompt_quality", "tool_description", "cost_efficiency"],
  "judgeModel": "gpt-4o-mini",
  "mode": "standard"
}
```

- `dimensions` optional — defaults to all 5
- `judgeModel` optional — defaults to env `JUDGE_LLM_MODEL` or `gpt-4o-mini`
- `mode` optional — `quick` (skip synthesis passes) / `standard` / `deep` (lower confidence thresholds)

#### Response
```json
{
  "success": true,
  "analysis": {
    "id": "uuid",
    "traceId": "trace-abc-123",
    "status": "completed",
    "rubricVersion": "judge-v1",
    "judgeModel": "gpt-4o-mini",
    "mode": "standard",
    "summary": {
      "overallScore": 0.72,
      "dimensionScores": {
        "step_correctness": 0.85,
        "tool_choice": 0.60,
        "prompt_quality": 0.55,
        "tool_description": 0.70,
        "cost_efficiency": 0.90
      },
      "totalIssues": 8,
      "totalPatches": 4,
      "bySeverity": { "low": 3, "medium": 4, "high": 1 }
    },
    "findings": [
      {
        "id": "uuid",
        "stepId": null,
        "dimension": "prompt_quality",
        "score": 0.55,
        "severity": "medium",
        "confidence": 0.88,
        "evidence": {
          "issues": [
            { "code": "CONTRADICTORY_INSTRUCTIONS", "detail": "..." },
            { "code": "MISSING_ERROR_HANDLING", "detail": "..." }
          ]
        },
        "recommendation": {
          "patches": [
            {
              "target": "system_prompt",
              "block": "policy",
              "operation": "replace",
              "original": "...",
              "suggested": "...",
              "rationale": "..."
            }
          ]
        }
      }
    ]
  }
}
```

---

## Structured Output Schemas (Complete)

### Shared Types
```typescript
// Issue — machine-readable problem identifier
{ code: string, detail: string }

// Patch — suggested change
{
  target: "system_prompt" | "tool_definition",
  toolName?: string,
  block?: string,
  operation: "replace" | "append" | "remove",
  path?: string,
  original: string | null,
  suggested: string,
  rationale: string
}
```

### Per-Step Judgment Schema (step_correctness, tool_choice)
```typescript
{
  stepId: number,
  dimension: string,
  score: number,          // 0-1
  severity: "low" | "medium" | "high" | "critical",
  confidence: number,     // 0-1
  issues: Issue[],
  recommendation: {
    action: string,
    detail: string
  },
  // tool_choice only:
  chosenTool?: string,
  betterAlternatives?: { toolName: string, reason: string, confidenceGain: number }[],
  patches?: Patch[]
}
```

### Trace-Level Judgment Schema (prompt_quality, tool_description, cost_efficiency)
```typescript
{
  dimension: string,
  overallScore: number,   // 0-1
  severity: "low" | "medium" | "high" | "critical",
  confidence: number,     // 0-1
  issues: Issue[],
  recommendation: {
    action: string,
    detail: string
  },
  patches?: Patch[]       // prompt_quality + tool_description only
}
```

---

## Environment Configuration

New env vars required:
```env
# LLM Judge Configuration (via LiteLLM proxy)
JUDGE_LLM_BASE_URL=https://litellm.whiteocean-2fb73b80.centralindia.azurecontainerapps.io/v1
JUDGE_LLM_API_KEY=sk-...          # LiteLLM proxy API key
JUDGE_LLM_MODEL=azure/gpt-4.1    # Default judge model (routed through LiteLLM)
JUDGE_LLM_TEMPERATURE=0          # Deterministic judging
JUDGE_MAX_RETRIES=2               # Retry on LLM failures
```

---

## Design Decisions

| Decision | Choice | Reasoning |
|---|---|---|
| Judge model default | `azure/gpt-4.1` via LiteLLM | GPT-4.1 on Azure, routed through LiteLLM proxy for provider flexibility |
| Map-reduce for long traces | Per-step → global synthesis | Handles 100+ event traces |
| Dimension independence | Each dimension = own chain | Add/remove/parallelize easily |
| Static findings as context | Stage 1 findings fed to Stage 2 | LLM focuses on semantic, not deterministic |
| Versioning | `rubricVersion: "judge-v1"` | Enables A/B testing judge versions |
| LiteLLM proxy | `JUDGE_LLM_BASE_URL` + `JUDGE_LLM_API_KEY` | Single proxy, swap models without code changes, WhyOps's own keys |
| Diffs in V1 | Yes, with guardrails | Immediately actionable; feeds Stage 3 |
| Confidence threshold for patches | > 0.7 | Low-confidence patches risk bad suggestions |
| Heuristic-first segmentation | Regex/keyword → LLM fallback | Saves LLM calls for structured prompts |
| Tool relevance filtering | Deterministic scoring | No LLM call overhead for filtering |

---

## Persistence

Uses existing tables with no schema changes:

- `trace_analyses` — one row per judge run, `rubric_version = 'judge-v1'`, `judge_model` filled
- `trace_analysis_findings` — one row per dimension finding, `evidence` JSONB holds issues + score, `recommendation` JSONB holds patches
- Stage 1 static findings and Stage 2 judge findings coexist in the same tables, distinguished by `rubric_version`

---

## Error Handling

| Scenario | Behavior |
|---|---|
| LLM API key missing | Return 500 with `JUDGE_NOT_CONFIGURED` error |
| LLM returns invalid JSON | Retry up to `JUDGE_MAX_RETRIES`, then save finding with `confidence: 0` and raw error |
| Trace has no events | Skip step-level dimensions, still run prompt/tool quality if data available |
| No system prompt on trace | Skip `prompt_quality` dimension, note in summary |
| No tools on trace | Skip `tool_choice` + `tool_description` dimensions, note in summary |
| Single dimension fails | Other dimensions still complete, partial results returned |

---

## Future Extensions (Not V1)

- Batch judging across multiple traces
- Custom rubric upload (user-defined dimensions)
- Judge model A/B testing
- Async webhook on completion
- Cost tracking per judge run
- Stage 3 integration: auto-generate hypothesis experiments from patches
