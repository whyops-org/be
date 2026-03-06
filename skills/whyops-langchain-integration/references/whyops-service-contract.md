# WhyOps Service Contract (This Repo)

This reference summarizes the live integration contract from:
- `whyops-auth`
- `whyops-proxy`
- `whyops-analyse`
- `shared/src/middleware`

Use this as the source of truth for skill output.

## 1) Auth Service (`whyops-auth`)

### Purpose
- Session-based control plane for projects, providers, and WhyOps API keys.

### Relevant routes
- `GET /api/config`: returns service base URLs (`authBaseUrl`, `proxyBaseUrl`, `analyseBaseUrl`).
- `POST /api/providers`: create provider (OpenAI/Anthropic/custom base URL + provider key).
- `POST /api/projects`: create project (with environments).
- `POST /api/api-keys`: create WhyOps API key.
- `GET /api/api-keys/:id/unmasked`: reveal stored key value for owned key.

### Auth characteristics
- Key management APIs are session protected (`requireSession` middleware).
- API keys accepted by shared validation currently use prefixes:
  - `whyops_`
  - `YOPS-`

## 2) Proxy Service (`whyops-proxy`)

### Purpose
- Front-door model proxy that auto-emits WhyOps trace events.

### Relevant routes
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/messages` (Anthropic messages)
- `GET /v1/models`

### Required request auth/headers
- API key auth required on `/v1/*` (`Authorization: Bearer <WHYOPS_API_KEY>` or `X-API-Key`).
- `X-Agent-Name` is required on chat/responses/messages routes; missing value returns `400`.

### Trace behavior
- Accepts `X-Trace-ID` or `X-Thread-ID`.
- Generates a trace ID when absent.
- Returns trace headers on responses.

### Event behavior
- Emits async events (`user_message` or `tool_result`, `llm_response`, `llm_thinking`, `error`).
- Dispatch path:
  - preferred: Redis stream enqueue
  - fallback: `POST {ANALYSE_URL}/api/events/ingest` with API key bearer token.

## 3) Analyse Service (`whyops-analyse`)

### Purpose
- Event ingestion, persistence, and query APIs.

### Relevant routes
- `POST /api/events/ingest`: async enqueue path (recommended for manual mode).
- `POST /api/events`: direct sync create path.
- `POST /api/events/tool-result`: convenience route that forces `eventType=tool_call_response`.
- `POST /api/entities/init`: register/update agent version metadata (`agentName`, `metadata.systemPrompt`, `metadata.tools[]`).
- `GET /api/events/help`: event schema and required metadata guidance.
- `GET /api/events?traceId=...`: retrieve ingested events.

### Agent initialization requirement
- `POST /api/entities/init` is mandatory before sending runtime events for a newly integrated agent.
- Re-run `init` whenever system prompt or tool schema changes.

### Auth requirements
- Analyse APIs run unified auth middleware and reject unauthenticated requests.
- Provide one of:
  - WhyOps API key (`Authorization: Bearer <WHYOPS_API_KEY>`), or
  - Session/context headers (`X-User-Id`, `X-Project-Id`, `X-Environment-Id`).
- API key is strongly preferred for LangChain server integrations.

### Event schema essentials
- Supported `eventType`:
  - `user_message`
  - `llm_response`
  - `embedding_request`
  - `embedding_response`
  - `llm_thinking`
  - `tool_call`
  - `tool_call_request`
  - `tool_call_response`
  - `tool_result`
  - `error`
- Required common fields:
  - `eventType`
  - `traceId`
  - `agentName` (or `entityName`, but normalize to `agentName`)

### Trace ID transport for manual ingestion
- Events API validation requires `traceId` in JSON body.
- Send `X-Trace-ID` header as well for cross-service log correlation and parity with proxy traffic.
- Optional: mirror the same value in `X-Thread-ID` for compatibility.
- Do not rely on trace headers alone; body `traceId` remains mandatory.

### Validation constraints to honor
- `llm_response` must include:
  - `metadata.model`
  - `metadata.provider`
- `embedding_response` must include:
  - `metadata.model`
  - `metadata.provider`
- `tool_call_request` and `tool_call_response` must include:
  - `metadata.tool`
- If auth context cannot resolve `userId/projectId/environmentId`, ingest fails.

### Persistence behavior
- `POST /api/events/ingest` usually returns `202` with `{ accepted: true }` when queued.
- If queueing is unavailable, service falls back to direct write.
- Step IDs can be omitted; service auto-resolves sequence by trace.

## 4) Practical Integration Implications

- Always call `POST /api/entities/init` before traffic and after prompt/tool contract changes.
- Proxy mode handles core LLM events, but integration policy requires manual emission of `tool_call_request` and `tool_call_response` (and embedding events when applicable).
- Manual mode must map runtime events to WhyOps schema with required metadata and include both payload `traceId` + trace header.
- Always propagate one trace ID across model/tool events for each user execution path.
