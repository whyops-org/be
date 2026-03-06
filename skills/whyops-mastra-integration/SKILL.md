---
name: whyops-mastra-integration
description: >-
  Integrate WhyOps with Mastra applications using two supported modes: WhyOps
  proxy mode and direct manual event ingestion mode. Use when tasks mention
  Mastra Agent.generate/Agent.stream, fullStream chunk handling, RequestContext,
  model router/provider config, WhyOps auth/proxy/analyse services, or when
  adding WhyOps API key auth, X-Agent-Name/X-Trace-ID headers, mandatory
  /api/entities/init, manual tool request/response events in proxy mode,
  embedding events, analyse ingest headers, and WhyOps event payload mapping.
---

# WhyOps Mastra Integration

## Overview

Implement production-safe WhyOps tracing for Mastra in either:
1. `proxy` mode (recommended): route model calls through `whyops-proxy`, then also emit required manual events for `tool_call_request` / `tool_call_response` and embedding traces.
2. `manual` mode: emit all WhyOps events directly to `whyops-analyse` from Mastra runtime events.

## Required Context Load

Read these files before making changes:
- `references/whyops-service-contract.md` for exact auth/proxy/analyse behavior in this repo.
- `references/mastra-recipes.md` for TypeScript implementation templates.

## Workflow

1. Detect integration mode:
- Choose `proxy` when the app can route model traffic through an OpenAI-compatible base URL with custom headers.
- Choose `manual` when traffic must stay direct to provider, needs selective instrumentation, or uses unsupported proxy paths.

2. Gather required runtime inputs:
- WhyOps API key for request auth.
- Agent identity (`agentName`) used consistently across traces.
- WhyOps URLs (`PROXY_URL` and/or `ANALYSE_URL`).
- Thread/trace ID source strategy for each user turn (middleware context first, then carry-forward, then generated).
- Agent init payload (`systemPrompt` + tool definitions with `name`, `inputSchema`, `outputSchema`, `description`).

3. Implement mode-specific wiring:
- Always call `POST /api/entities/init` before first traced turn and whenever agent prompt/tools change.
- For `proxy`, patch Mastra model provider initialization and request context propagation, then add manual emitter for `tool_call_request` / `tool_call_response`; if embeddings are used, emit `embedding_request` / `embedding_response`.
- For `manual`, add an emitter, map Mastra stream events to WhyOps event types, and send trace headers plus payload `traceId`.

4. Validate end-to-end:
- Execute one full user turn with at least one model response.
- Confirm events exist for the same trace in WhyOps analyse APIs.

## Implementation Rules

- Keep one stable trace ID per user request/tool loop.
- `POST /api/entities/init` is mandatory for every new integration rollout and after any prompt/tool contract change.
- In Mastra server middleware, attach validated thread ID to context and treat it as source of truth:
  - v1: set `MASTRA_THREAD_ID_KEY` (or `threadId`) on `requestContext` from `context.get('requestContext')`
  - v0: set equivalent value on `runtimeContext` from `context.get('runtimeContext')`
- Compute trace ID once at turn start with this precedence:
  1. middleware context thread ID (`requestContext`/`runtimeContext`)
  2. incoming headers (`x-trace-id`, `x-thread-id`) or app-level request id
  3. stored conversation/session trace ID
  4. generated UUID fallback
- In proxy mode always send:
  - `X-Agent-Name`
  - `X-Trace-ID` (and `X-Thread-ID` mirror when possible for compatibility)
- In proxy mode, still manually emit:
  - `tool_call_request` and `tool_call_response` (`metadata.tool` required)
  - `embedding_request` and `embedding_response` when embedding APIs are used
- In manual mode always send:
  - event payload field `traceId` (required by analyse schema)
  - request header `X-Trace-ID` (plus optional `X-Thread-ID` mirror) on `/api/events/ingest` and `/api/events`
- For `llm_response` and `embedding_response`, ensure `metadata.model` and `metadata.provider`.
- For `tool_call_request` and `tool_call_response`, ensure `metadata.tool`.
- Prefer `POST /api/events/ingest` for non-blocking writes; use `/api/events` only when synchronous persistence is required.
- If Mastra model response metadata returns `headers.x-trace-id`/`headers.X-Trace-ID`, persist and reuse it for subsequent turns in the same thread.

## Mode Selection Guidance

- Use `proxy` as default.
- Use `manual` only when proxy cannot be applied cleanly.
- In proxy mode, do not skip manual tool request/response emission.

## Deliverable Checklist

Before completing, ensure all are true:
- Mode choice is explicit and justified.
- Mandatory `POST /api/entities/init` call is implemented and verified.
- Auth and required headers are implemented correctly.
- Trace ID propagation is consistent.
- Event schema constraints are respected.
- Tool request/response events are emitted manually even in proxy mode.
- Embedding events are emitted and validated when embeddings are used.
- A retrieval check confirms events are visible in analyse APIs.
