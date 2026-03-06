# LangChain Integration Recipes

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

Use proxy mode when you can route model traffic through `whyops-proxy`.

Trace ID rule (proxy and manual):
- Resolve once per user turn with precedence:
  1. inbound context/header trace ID
  2. previously stored conversation trace ID
  3. generated UUID fallback
- Reuse the same value for all model/tool operations in that turn.

### Python (`langchain-openai`)

```python
import os
import uuid
from typing import Optional
from langchain_openai import ChatOpenAI

def resolve_trace_id(existing: Optional[str] = None, inbound: Optional[str] = None) -> str:
    return inbound or existing or str(uuid.uuid4())

trace_id = resolve_trace_id(
    existing=os.getenv("WHYOPS_TRACE_ID"),
    inbound=os.getenv("X_TRACE_ID"),
)

llm = ChatOpenAI(
    model="gpt-4o-mini",
    api_key=os.environ["WHYOPS_API_KEY"],
    base_url=f'{os.environ["WHYOPS_PROXY_URL"].rstrip("/")}/v1',
    default_headers={
        "X-Agent-Name": os.environ["WHYOPS_AGENT_NAME"],
        "X-Trace-ID": trace_id,
        "X-Thread-ID": trace_id,
    },
)

resp = llm.invoke("Write a one-line summary of WhyOps.")
print(resp.content)
```

Notes:
- `api_key`, `base_url`, and `default_headers` are supported `ChatOpenAI` init args.
- Proxy captures core LLM telemetry automatically.
- Integration policy requires manual emits for `tool_call_request` and `tool_call_response` even in proxy mode.
- If your app also calls embeddings APIs, emit `embedding_request` and `embedding_response` manually.

### Proxy mode manual supplement (required)

Even in proxy mode, keep a lightweight emitter for tool/embedding events:

```ts
await emitWhyOpsEvent({
  eventType: "tool_call_request",
  traceId,
  agentName: process.env.WHYOPS_AGENT_NAME!,
  content: { toolCalls: [{ name: toolName, arguments: toolArgs }] },
  metadata: { tool: toolName },
});

await emitWhyOpsEvent({
  eventType: "tool_call_response",
  traceId,
  agentName: process.env.WHYOPS_AGENT_NAME!,
  content: { toolResults: [{ name: toolName, output: toolOutput }] },
  metadata: { tool: toolName },
});
```

### TypeScript (`@langchain/openai`)

```ts
import { ChatOpenAI } from "@langchain/openai";
import { randomUUID } from "node:crypto";

function resolveTraceId(opts: { inbound?: string; existing?: string }) {
  return opts.inbound || opts.existing || randomUUID();
}

const traceId = resolveTraceId({
  inbound: process.env.X_TRACE_ID,
  existing: process.env.WHYOPS_TRACE_ID,
});
const proxyBase = process.env.WHYOPS_PROXY_URL!.replace(/\/$/, "");

const llm = new ChatOpenAI({
  model: "gpt-4o-mini",
  apiKey: process.env.WHYOPS_API_KEY,
  configuration: {
    baseURL: `${proxyBase}/v1`,
    defaultHeaders: {
      "X-Agent-Name": process.env.WHYOPS_AGENT_NAME!,
      "X-Trace-ID": traceId,
      "X-Thread-ID": traceId,
    },
  },
});

const resp = await llm.invoke("Write a one-line summary of WhyOps.");
console.log(resp.content);
```

Notes:
- JS `ChatOpenAI` accepts `configuration.baseURL` for endpoint routing.
- Keep `X-Agent-Name` constant per agent/component.
- Persist proxy response header `X-Trace-ID` when present, then reuse for follow-up turns.

## 2) Manual Events Mode

Use manual mode when proxy cannot be used. Keep provider traffic direct, and emit WhyOps events to:
- `POST {WHYOPS_ANALYSE_URL}/api/events/ingest`

### Event mapping from LangChain runtime events

- `on_chat_model_start` -> `user_message` (or `tool_result` if prior message is a tool result)
- `on_chat_model_end` -> `llm_response`
- `on_tool_start` -> `tool_call_request` (`metadata.tool` required)
- `on_tool_end` -> `tool_call_response` (`metadata.tool` required)
- embedding request wrapper -> `embedding_request`
- embedding response wrapper -> `embedding_response`
- any `*_error` -> `error`

For `llm_response` and `embedding_response`, always include:
- `metadata.model`
- `metadata.provider`

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

### TypeScript emitter + `streamEvents` mapping

```ts
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
  eventType: WhyOpsEventType,
  payload: Record<string, unknown> & { traceId: string },
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

let step = 0;
const traceId = crypto.randomUUID();

for await (const ev of chain.streamEvents(input, { version: "v2" })) {
  step += 1;
  const base = {
    traceId,
    agentName: process.env.WHYOPS_AGENT_NAME!,
    stepId: step,
    parentStepId: step > 1 ? step - 1 : undefined,
    timestamp: new Date().toISOString(),
  };

  if (ev.event === "on_chat_model_start") {
    await emitWhyOpsEvent("user_message", {
      ...base,
      eventType: "user_message",
      content: ev.data?.input,
      metadata: { model: "unknown", provider: "unknown" },
    });
  } else if (ev.event === "on_chat_model_end") {
    await emitWhyOpsEvent("llm_response", {
      ...base,
      eventType: "llm_response",
      content: ev.data?.output,
      metadata: { model: "gpt-4o-mini", provider: "openai" },
    });
  } else if (ev.event === "on_tool_start") {
    await emitWhyOpsEvent("tool_call_request", {
      ...base,
      eventType: "tool_call_request",
      content: ev.data?.input,
      metadata: { tool: ev.name ?? "unknown_tool" },
    });
  } else if (ev.event === "on_tool_end") {
    await emitWhyOpsEvent("tool_call_response", {
      ...base,
      eventType: "tool_call_response",
      content: ev.data?.output,
      metadata: { tool: ev.name ?? "unknown_tool" },
    });
  } else if (ev.event.endsWith("_error")) {
    await emitWhyOpsEvent("error", {
      ...base,
      eventType: "error",
      content: ev.data,
      metadata: {},
    });
  }
}

// For embeddings usage, wrap your embeddings client calls:
await emitWhyOpsEvent("embedding_request", {
  eventType: "embedding_request",
  traceId,
  agentName: process.env.WHYOPS_AGENT_NAME!,
  metadata: { model: "text-embedding-3-small", provider: "openai" },
  content: { input: "example text" },
});

// ... call provider embeddings API ...

await emitWhyOpsEvent("embedding_response", {
  eventType: "embedding_response",
  traceId,
  agentName: process.env.WHYOPS_AGENT_NAME!,
  metadata: { model: "text-embedding-3-small", provider: "openai" },
  content: { embeddingCount: 1, firstEmbeddingDimensions: 1536 },
});
```

### Python emitter + `astream_events` mapping

```python
import os
import uuid
import requests
from datetime import datetime, timezone

def emit_whyops_event(payload: dict) -> None:
    requests.post(
        f'{os.environ["WHYOPS_ANALYSE_URL"].rstrip("/")}/api/events/ingest',
        headers={
            "Content-Type": "application/json",
            "Authorization": f'Bearer {os.environ["WHYOPS_API_KEY"]}',
            "X-Trace-ID": str(payload["traceId"]),
            "X-Thread-ID": str(payload["traceId"]),
        },
        json=payload,
        timeout=3,
    ).raise_for_status()

trace_id = str(uuid.uuid4())
step = 0

async for ev in chain.astream_events(input_data, version="v2"):
    step += 1
    base = {
        "traceId": trace_id,
        "agentName": os.environ["WHYOPS_AGENT_NAME"],
        "stepId": step,
        "parentStepId": step - 1 if step > 1 else None,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }

    if ev["event"] == "on_chat_model_start":
        emit_whyops_event({
            **base,
            "eventType": "user_message",
            "content": ev.get("data", {}).get("input"),
            "metadata": {"model": "unknown", "provider": "unknown"},
        })
    elif ev["event"] == "on_chat_model_end":
        emit_whyops_event({
            **base,
            "eventType": "llm_response",
            "content": ev.get("data", {}).get("output"),
            "metadata": {"model": "gpt-4o-mini", "provider": "openai"},
        })
    elif ev["event"] == "on_tool_start":
        emit_whyops_event({
            **base,
            "eventType": "tool_call_request",
            "content": ev.get("data", {}).get("input"),
            "metadata": {"tool": ev.get("name", "unknown_tool")},
        })
    elif ev["event"] == "on_tool_end":
        emit_whyops_event({
            **base,
            "eventType": "tool_call_response",
            "content": ev.get("data", {}).get("output"),
            "metadata": {"tool": ev.get("name", "unknown_tool")},
        })
    elif ev["event"].endswith("_error"):
        emit_whyops_event({
            **base,
            "eventType": "error",
            "content": ev.get("data"),
            "metadata": {},
        })
```

## 3) Verification Checklist

1. Run one end-to-end LangChain request.
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
