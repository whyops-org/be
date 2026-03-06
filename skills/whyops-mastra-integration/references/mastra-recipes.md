# Mastra Integration Recipes

Use these templates after reading `whyops-service-contract.md`.

## 0) Mandatory Agent Init (All Modes)

Call init before first traced traffic and whenever system prompt/tool schema changes.

```bash
curl -X POST "${WHYOPS_ANALYSE_URL%/}/api/entities/init" \
  -H "Authorization: Bearer ${WHYOPS_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "agentName": "'"${WHYOPS_AGENT_NAME}"'",
    "metadata": {
      "systemPrompt": "You are a concise assistant.",
      "tools": [
        {
          "name": "search_docs",
          "inputSchema": "{\"type\":\"object\",\"properties\":{\"query\":{\"type\":\"string\"}},\"required\":[\"query\"]}",
          "outputSchema": "{\"type\":\"object\",\"properties\":{\"results\":{\"type\":\"array\"}}}",
          "description": "Search internal docs."
        }
      ]
    }
  }'
```

## 1) Proxy Mode (Preferred)

Use proxy mode when Mastra model traffic can be routed through `whyops-proxy`.

Trace ID rule (proxy and manual):
- Resolve once per user turn with precedence:
  1. server context thread ID (`requestContext` or legacy `runtimeContext`)
  2. inbound trace/thread header
  3. previously stored conversation trace ID
  4. generated UUID fallback
- Reuse the same value for all model/tool operations in that turn.

### Server middleware: attach thread ID to Mastra context first

```ts
import { MASTRA_THREAD_ID_KEY } from "@mastra/core/memory";

mastraServer.use(async (context, next) => {
  // v1: requestContext is the canonical runtime context
  const requestContext = context.get("requestContext");

  const inboundThreadId =
    context.req.headers.get("x-thread-id") ||
    context.req.headers.get("x-trace-id") ||
    context.req.headers.get("x-request-id");

  if (requestContext && inboundThreadId) {
    requestContext.set(MASTRA_THREAD_ID_KEY, inboundThreadId);
    // Optional compatibility key for app code
    requestContext.set("whyopsTraceId", inboundThreadId);
  }

  await next();
});
```

Notes:
- If you are on older Mastra server APIs, read/write the same value on `runtimeContext` instead of `requestContext`.
- All WhyOps integration code should read thread/trace ID from this context first.

### TypeScript (`@mastra/core` + `@ai-sdk/openai`)

```ts
import { Agent } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";
import { MASTRA_THREAD_ID_KEY } from "@mastra/core/memory";
import { createOpenAI } from "@ai-sdk/openai";
import { randomUUID } from "node:crypto";

function resolveTraceId(opts: { inbound?: string; existing?: string }) {
  return opts.inbound || opts.existing || randomUUID();
}

function createWhyOpsProxyModel(traceId: string) {
  const provider = createOpenAI({
    apiKey: process.env.WHYOPS_API_KEY!,
    baseURL: `${process.env.WHYOPS_PROXY_URL!.replace(/\/$/, "")}/v1`,
    headers: {
      "X-Agent-Name": process.env.WHYOPS_AGENT_NAME || "support-agent",
      "X-Trace-ID": traceId,
      "X-Thread-ID": traceId,
    },
  });

  return provider("gpt-4o-mini");
}

const agent = new Agent({
  name: process.env.WHYOPS_AGENT_NAME || "support-agent",
  instructions: "You are a concise support assistant.",
  model: ({ requestContext }) => {
    const traceId = resolveTraceId({
      inbound:
        requestContext?.get(MASTRA_THREAD_ID_KEY) ||
        requestContext?.get("whyopsTraceId"),
      existing: requestContext?.get("conversationTraceId"),
    });
    return createWhyOpsProxyModel(traceId);
  },
});

const requestContext = new RequestContext();
requestContext.set(MASTRA_THREAD_ID_KEY, process.env.X_THREAD_ID || process.env.X_TRACE_ID);
requestContext.set("whyopsTraceId", process.env.X_TRACE_ID);
requestContext.set("conversationTraceId", process.env.WHYOPS_TRACE_ID);

const result = await agent.generate(
  [{ role: "user", content: "Give me a one-line status update." }],
  { requestContext },
);

// Persist for the next turn when proxy returns it
const responseTraceId =
  result.response?.headers?.["x-trace-id"] ??
  result.response?.headers?.["X-Trace-ID"];
if (responseTraceId) {
  requestContext.set("conversationTraceId", responseTraceId);
}
```

Notes:
- Keep `X-Agent-Name` stable per Mastra agent.
- If using `agent.stream(...)`, read `await streamResult.response` and persist `headers["x-trace-id"]` similarly.
- Mastra model gateways can also be used for centralized proxy routing; keep the same trace header behavior.
- Integration policy requires manual emits for `tool_call_request` and `tool_call_response` even in proxy mode.
- If your app also calls embeddings APIs, emit `embedding_request` and `embedding_response` manually.

### Proxy mode manual supplement (required)

```ts
await emitWhyOpsEvent({
  eventType: "tool_call_request",
  traceId,
  agentName: process.env.WHYOPS_AGENT_NAME || "support-agent",
  content: { toolCalls: [{ name: toolName, arguments: toolArgs }] },
  metadata: { tool: toolName },
});

await emitWhyOpsEvent({
  eventType: "tool_call_response",
  traceId,
  agentName: process.env.WHYOPS_AGENT_NAME || "support-agent",
  content: { toolResults: [{ name: toolName, output: toolOutput }] },
  metadata: { tool: toolName },
});
```

## 2) Manual Events Mode

Use manual mode when proxy cannot be used. Keep provider traffic direct, and emit WhyOps events to:
- `POST {WHYOPS_ANALYSE_URL}/api/events/ingest`

### Event mapping from Mastra stream chunks (`fullStream`)

- send one `user_message` at turn start
- `tool-call` -> `tool_call_request` (`metadata.tool` required)
- `tool-result` -> `tool_call_response` (`metadata.tool` required)
- `finish` -> `llm_response` (`metadata.model` and `metadata.provider` required)
- embedding request wrapper -> `embedding_request`
- embedding response wrapper -> `embedding_response`
- `error` -> `error`

### Shared payload shape

```json
{
  "eventType": "llm_response",
  "traceId": "trace-uuid",
  "agentName": "support-agent",
  "spanId": "optional-span-id",
  "stepId": 3,
  "parentStepId": 2,
  "timestamp": "2026-03-04T00:00:00.000Z",
  "content": {},
  "metadata": {}
}
```

### TypeScript emitter + `Agent.stream(...).fullStream` mapping

```ts
import { Agent } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";
import { MASTRA_THREAD_ID_KEY } from "@mastra/core/memory";
import { randomUUID } from "node:crypto";

type WhyOpsEventType =
  | "user_message"
  | "tool_result"
  | "llm_response"
  | "embedding_request"
  | "embedding_response"
  | "tool_call_request"
  | "tool_call_response"
  | "llm_thinking"
  | "error";

async function emitWhyOpsEvent(
  payload: Record<string, unknown> & { eventType: WhyOpsEventType; traceId: string },
) {
  await fetch(`${process.env.WHYOPS_ANALYSE_URL!.replace(/\/$/, "")}/api/events/ingest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.WHYOPS_API_KEY!}`,
      "X-Trace-ID": payload.traceId,
      "X-Thread-ID": payload.traceId,
    },
    body: JSON.stringify(payload),
  });
}

function resolveTraceId(opts: { inbound?: string; existing?: string }) {
  return opts.inbound || opts.existing || randomUUID();
}

const requestContext = new RequestContext();
requestContext.set(MASTRA_THREAD_ID_KEY, process.env.X_THREAD_ID || process.env.X_TRACE_ID);
requestContext.set("whyopsTraceId", process.env.X_TRACE_ID);
requestContext.set("conversationTraceId", process.env.WHYOPS_TRACE_ID);

const traceId = resolveTraceId({
  inbound: requestContext.get(MASTRA_THREAD_ID_KEY) || requestContext.get("whyopsTraceId"),
  existing: requestContext.get("conversationTraceId"),
});

let stepId = 0;
const agentName = process.env.WHYOPS_AGENT_NAME || "support-agent";
const providerName = "openai"; // set to your direct provider

await emitWhyOpsEvent({
  eventType: "user_message",
  traceId,
  agentName,
  stepId: ++stepId,
  timestamp: new Date().toISOString(),
  content: { role: "user", text: "Give me a one-line status update." },
  metadata: {},
});

const streamResult = await agent.stream(
  [{ role: "user", content: "Give me a one-line status update." }],
  { requestContext },
);

const responseMeta = await streamResult.response;
const modelName = responseMeta?.modelId || "unknown";

for await (const chunk of streamResult.fullStream) {
  if (chunk.type === "tool-call") {
    await emitWhyOpsEvent({
      eventType: "tool_call_request",
      traceId,
      agentName,
      stepId: ++stepId,
      parentStepId: stepId > 1 ? stepId - 1 : undefined,
      timestamp: new Date().toISOString(),
      content: chunk,
      metadata: { tool: chunk.toolName || "unknown_tool" },
    });
  } else if (chunk.type === "tool-result") {
    await emitWhyOpsEvent({
      eventType: "tool_call_response",
      traceId,
      agentName,
      stepId: ++stepId,
      parentStepId: stepId > 1 ? stepId - 1 : undefined,
      timestamp: new Date().toISOString(),
      content: chunk,
      metadata: { tool: chunk.toolName || "unknown_tool" },
    });
  } else if (chunk.type === "error") {
    await emitWhyOpsEvent({
      eventType: "error",
      traceId,
      agentName,
      stepId: ++stepId,
      parentStepId: stepId > 1 ? stepId - 1 : undefined,
      timestamp: new Date().toISOString(),
      content: chunk,
      metadata: {},
    });
  }
}

const finalText = await streamResult.text;
const usage = await streamResult.usage;

await emitWhyOpsEvent({
  eventType: "llm_response",
  traceId,
  agentName,
  stepId: ++stepId,
  parentStepId: stepId > 1 ? stepId - 1 : undefined,
  timestamp: new Date().toISOString(),
  content: { text: finalText },
  metadata: {
    model: modelName,
    provider: providerName,
    usage,
  },
});

// For embeddings usage, wrap your embeddings client calls:
await emitWhyOpsEvent({
  eventType: "embedding_request",
  traceId,
  agentName,
  stepId: ++stepId,
  timestamp: new Date().toISOString(),
  content: { input: "example text" },
  metadata: { model: "text-embedding-3-small", provider: providerName },
});

// ... call provider embeddings API ...

await emitWhyOpsEvent({
  eventType: "embedding_response",
  traceId,
  agentName,
  stepId: ++stepId,
  timestamp: new Date().toISOString(),
  content: { embeddingCount: 1, firstEmbeddingDimensions: 1536 },
  metadata: { model: "text-embedding-3-small", provider: providerName },
});
```

Notes:
- Body `traceId` is required by WhyOps analyse validation.
- Keep `X-Trace-ID` header equal to payload `traceId` on each ingest request.
- Use `/api/events` instead of `/api/events/ingest` only when synchronous persistence is required.

## 3) Verification Checklist

1. Run one end-to-end Mastra request.
2. Confirm mandatory init call completed successfully:
   - `POST {WHYOPS_ANALYSE_URL}/api/entities/init`
3. Capture the trace ID used by the app.
3. Confirm event ingestion:
   - `GET {WHYOPS_ANALYSE_URL}/api/events?traceId=<TRACE_ID>&include=metadata`
4. Confirm event sequence includes at least:
   - `user_message`
   - `llm_response`
5. Confirm proxy mode still emits manually:
   - `tool_call_request`
   - `tool_call_response`
6. If tools run, confirm both:
   - `tool_call_request`
   - `tool_call_response`
7. If embeddings run, confirm both:
   - `embedding_request`
   - `embedding_response`
