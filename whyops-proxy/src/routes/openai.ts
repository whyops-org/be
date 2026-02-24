import env from '@whyops/shared/env';
import { createServiceLogger } from '@whyops/shared/logger';
import type { ApiKeyAuthContext } from '@whyops/shared/middleware';
import { decodeSignature, encodeSignature, generateSpanId, generateThreadId, stripSignature } from '@whyops/shared/utils';
import { Hono } from 'hono';
import { OpenAIParser } from '../parsers/openai-parser';
import type {
  OpenAIChatCompletionRequest,
  OpenAIChatCompletionResponse,
  OpenAIChatCompletionChunk,
  OpenAIResponsesRequest,
  OpenAIResponsesResponse,
  OpenAIResponsesStreamEvent,
} from '../types/openai';
import { dispatchAnalyseEvent } from '../services/async-events';
import { copyProxyResponseHeaders, resolveProviderFromModel, validateResolvedProvider } from '../services/proxy-routing';
import { SseEventDecoder } from '../services/sse';

const logger = createServiceLogger('proxy:openai');
const app = new Hono();

function determineOpenAIRequestEventType(messages: any[] | undefined): 'user_message' | 'tool_result' {
  if (!messages || !Array.isArray(messages)) return 'user_message';

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const role = msg?.role;
    if (role === 'system') continue;
    if (role === 'tool' || role === 'function') return 'tool_result';
    return 'user_message';
  }

  return 'user_message';
}

function determineResponsesRequestEventType(input: OpenAIResponsesRequest['input']): 'user_message' | 'tool_result' {
  if (!input || typeof input === 'string') return 'user_message';
  if (!Array.isArray(input)) return 'user_message';

  for (let i = input.length - 1; i >= 0; i--) {
    const msg = input[i] as any;
    const role = msg?.role;
    if (role === 'system') continue;
    if (role === 'tool') return 'tool_result';
    return 'user_message';
  }

  return 'user_message';
}

function responseFromUpstreamError(status: number, contentType: string | null, body: string): Response {
  const headers = new Headers();
  if (contentType) {
    headers.set('content-type', contentType);
  }
  return new Response(body, { status, headers });
}

async function trackChatCompletionsStream(
  streamBody: ReadableStream<Uint8Array>,
  apiKey: string,
  traceId: string,
  providerId: string | undefined,
  agentName: string,
  model: string,
  isCustom: boolean,
  providerSlug: string | null | undefined,
  startTime: number
): Promise<void> {
  const reader = streamBody.getReader();
  const decoder = new TextDecoder();
  const sseDecoder = new SseEventDecoder();
  let accumulatedState = OpenAIParser.getInitialStreamState();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const textChunk = decoder.decode(value, { stream: true });
      const events = sseDecoder.push(textChunk);



      for (const data of events) {
        if (data === '[DONE]') {
          continue;
        }

        try {
          const parsed = JSON.parse(data) as OpenAIChatCompletionChunk;
          accumulatedState = OpenAIParser.parseStreamChunk(parsed, accumulatedState);
        } catch {
          // Ignore malformed chunks for analytics only path
        }
      }
    }

    const finalEvents = sseDecoder.flush();
    for (const data of finalEvents) {
      if (data === '[DONE]') continue;
      try {
        const parsed = JSON.parse(data) as OpenAIChatCompletionChunk;
        accumulatedState = OpenAIParser.parseStreamChunk(parsed, accumulatedState);
      } catch {
        // Ignore malformed chunks for analytics only path
      }
    }

    dispatchAnalyseEvent(apiKey, {
      traceId,
      spanId: generateSpanId(),
      eventType: 'llm_response',
      providerId,
      agentName,
      content: {
        content: accumulatedState.content,
        toolCalls: accumulatedState.toolCalls,
        finishReason: accumulatedState.finishReason,
      },
      metadata: {
        model,
        provider: isCustom ? 'custom' : 'openai',
        providerSlug: providerSlug || undefined,
        usage: accumulatedState.usage,
        latencyMs: Date.now() - startTime,
      }
    });
  } finally {
    reader.releaseLock();
  }
}

async function trackResponsesStream(
  streamBody: ReadableStream<Uint8Array>,
  apiKey: string,
  traceId: string,
  providerId: string | undefined,
  agentName: string,
  model: string,
  isCustom: boolean,
  providerSlug: string | null | undefined,
  startTime: number
): Promise<void> {
  const reader = streamBody.getReader();
  const decoder = new TextDecoder();
  const sseDecoder = new SseEventDecoder();
  let accumulatedState = OpenAIParser.getInitialStreamState();
  const toolCallState = new Map<string, any>();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const textChunk = decoder.decode(value, { stream: true });
      const events = sseDecoder.push(textChunk);

      for (const data of events) {
        if (data === '[DONE]') {
          continue;
        }

        try {
          const parsed = JSON.parse(data) as OpenAIResponsesStreamEvent;
          accumulatedState = OpenAIParser.parseResponsesStreamChunk(parsed, accumulatedState, toolCallState);
        } catch {
          // Ignore malformed chunks for analytics only path
        }
      }
    }

    const finalEvents = sseDecoder.flush();
    for (const data of finalEvents) {
      if (data === '[DONE]') continue;
      try {
        const parsed = JSON.parse(data) as OpenAIResponsesStreamEvent;
        accumulatedState = OpenAIParser.parseResponsesStreamChunk(parsed, accumulatedState, toolCallState);
      } catch {
        // Ignore malformed chunks for analytics only path
      }
    }

    dispatchAnalyseEvent(apiKey, {
      traceId,
      spanId: generateSpanId(),
      eventType: 'llm_response',
      providerId,
      agentName,
      content: {
        content: accumulatedState.content,
        toolCalls: accumulatedState.toolCalls,
        finishReason: accumulatedState.finishReason || 'stop',
      },
      metadata: {
        model,
        provider: isCustom ? 'custom' : 'openai',
        providerSlug: providerSlug || undefined,
        usage: accumulatedState.usage,
        latencyMs: Date.now() - startTime,
      }
    });
  } finally {
    reader.releaseLock();
  }
}

// OpenAI Chat Completions endpoint
app.post('/chat/completions', async (c) => {
  const auth = c.get('whyopsAuth') as ApiKeyAuthContext;
  const requestBody = await c.req.json() as OpenAIChatCompletionRequest;
  const isStreaming = requestBody.stream === true;

  const startTime = Date.now();
  const agentName = c.req.header('X-Agent-Name');

  if (!agentName) {
    return c.json({ error: 'Missing required header: X-Agent-Name' }, 400);
  }

  const { provider, isCustom, providerSlug, actualModel } = await resolveProviderFromModel(
    auth.userId,
    requestBody.model,
    auth.provider
  );

  const providerValidation = validateResolvedProvider(provider);
  if (!providerValidation.valid) {
    return c.json({ error: providerValidation.message }, 400);
  }

  // Use actual model for the API call
  requestBody.model = actualModel;

  // 1. Try to find traceId from Headers
  let traceId = c.req.header('X-Trace-ID') || c.req.header('X-Thread-ID');

  // 2. If not found, try to extract hidden signature from the last assistant message
  if (!traceId && requestBody.messages?.length > 0) {
    // Iterate backwards to find the last assistant message
    for (let i = requestBody.messages.length - 1; i >= 0; i--) {
      const msg = requestBody.messages[i];
      if (msg.role === 'assistant' && msg.content) {
        const extractedId = decodeSignature(msg.content);
        if (extractedId) {
          traceId = extractedId;
          logger.debug({ traceId }, 'Extracted traceId from invisible signature');
          break;
        }
      }
    }
  }

  // 3. Fallback to generating new trace if not provided or found
  if (!traceId) {
    traceId = generateThreadId();
  }

  // Generate a distinct span ID for this interaction request
  const requestSpanId = generateSpanId();

  logger.info({
    model: actualModel,
    providerSlug,
    isCustom,
    stream: isStreaming,
    traceId,
  }, 'OpenAI request received');

  // CLEANUP: Strip signatures from history before sending to OpenAI
  // This is crucial so the LLM doesn't see the hidden characters
  if (requestBody.messages) {
    requestBody.messages = requestBody.messages.map((msg: any) => {
      if (typeof msg.content === 'string') {
        return { ...msg, content: stripSignature(msg.content) };
      }
      return msg;
    });
  }

  // Send request event to analyse
  dispatchAnalyseEvent(auth.apiKey, {
    traceId,
    spanId: requestSpanId,
    eventType: determineOpenAIRequestEventType(requestBody.messages),
    providerId: provider.id,
    agentName,
    content: requestBody.messages,
    metadata: {
      model: actualModel,
      provider: isCustom ? 'custom' : 'openai',
      providerSlug: providerSlug || undefined,
      params: {
        temperature: requestBody.temperature,
        maxTokens: (requestBody as any).max_tokens ?? requestBody.max_completion_tokens,
        topP: requestBody.top_p,
        frequencyPenalty: requestBody.frequency_penalty,
        presencePenalty: requestBody.presence_penalty,
        reasoningEffort: requestBody.reasoning_effort,
      }
    }
  });

  try {
    const openaiUrl = `${provider.baseUrl}/chat/completions`;
    const headers = {
      'Authorization': `Bearer ${provider.apiKey}`,
      'Content-Type': 'application/json',
      'User-Agent': 'WhyOps-Proxy/1.0',
    };

    // Prepare the invisible signature to inject into the response
    const signature = encodeSignature(traceId);

    if (isStreaming) {
      const response = await fetch(openaiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
      });

      // Handle non-200 responses from OpenAI
      if (!response.ok) {
        const errorBody = await response.text();
        logger.error({ status: response.status, errorBody }, 'OpenAI API error');

        dispatchAnalyseEvent(auth.apiKey, {
          traceId,
          spanId: generateSpanId(),
          eventType: 'error',
          providerId: provider.id,
          agentName,
          content: { error: errorBody, status: response.status },
          metadata: { latencyMs: Date.now() - startTime }
        });

        return responseFromUpstreamError(response.status, response.headers.get('content-type'), errorBody);
      }

      // Stream the response back to the client while also tracking analytics
      if (!response.body) {
        throw new Error('No response body');
      }

      const [clientBranch, analyticsBranch] = response.body.tee();
      trackChatCompletionsStream(
        analyticsBranch,
        auth.apiKey,
        traceId,
        provider.id,
        agentName,
        requestBody.model,
        isCustom,
        providerSlug,
        startTime
      ).catch((error) => logger.warn({ error, traceId }, 'Failed to parse OpenAI streaming analytics'));

      const upstreamHeaders = copyProxyResponseHeaders(response.headers);
      upstreamHeaders.set('X-Trace-ID', traceId);
      upstreamHeaders.set('X-Thread-ID', traceId);

      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
      const writer = writable.getWriter();
      const reader = clientBranch.getReader();
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      const sseDecoder = new SseEventDecoder();
      let signatureSent = false;

      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const textChunk = decoder.decode(value, { stream: true });
            const events = sseDecoder.push(textChunk);

            for (const data of events) {
              if (data === '[DONE]') {
                if (!signatureSent) {
                  const signatureChunk = {
                    id: 'gen-signature',
                    object: 'chat.completion.chunk',
                    created: Date.now(),
                    model: requestBody.model,
                    choices: [{
                      index: 0,
                      delta: { content: signature },
                      finish_reason: null
                    }]
                  };

                  await writer.write(encoder.encode(`data: ${JSON.stringify(signatureChunk)}\n\n`));
                  signatureSent = true;
                }

                await writer.write(encoder.encode('data: [DONE]\n\n'));
                continue;
              }

              await writer.write(encoder.encode(`data: ${data}\n\n`));
            }
          }

          const finalEvents = sseDecoder.flush();
          for (const data of finalEvents) {
            if (data === '[DONE]') {
              if (!signatureSent) {
                const signatureChunk = {
                  id: 'gen-signature',
                  object: 'chat.completion.chunk',
                  created: Date.now(),
                  model: requestBody.model,
                  choices: [{
                    index: 0,
                    delta: { content: signature },
                    finish_reason: null
                  }]
                };

                await writer.write(encoder.encode(`data: ${JSON.stringify(signatureChunk)}\n\n`));
                signatureSent = true;
              }

              await writer.write(encoder.encode('data: [DONE]\n\n'));
              continue;
            }

            await writer.write(encoder.encode(`data: ${data}\n\n`));
          }
        } catch (streamError) {
          logger.warn({ streamError, traceId }, 'OpenAI stream forwarding interrupted');
        } finally {
          reader.releaseLock();
          await writer.close();
        }
      })();

      return new Response(readable, {
        status: response.status,
        headers: upstreamHeaders,
      });
    } else {
      // Non-streaming logic
      const response = await fetch(openaiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(env.PROXY_TIMEOUT_MS),
      });

      const latencyMs = Date.now() - startTime;
      const responseData = await response.json() as OpenAIChatCompletionResponse;

      if (!response.ok) {
        // ... error handling ...
        dispatchAnalyseEvent(auth.apiKey, {
          traceId,
          spanId: generateSpanId(),
          eventType: 'error',
          providerId: provider.id,
          agentName,
          content: responseData,
          metadata: { latencyMs }
        });
        return c.json(responseData, response.status as any);
      }

      // Inject signature into response content
      if (responseData.choices && responseData.choices[0] && responseData.choices[0].message) {
        // 1. Inject Invisible Signature into Content
        if (responseData.choices[0].message.content) {
          responseData.choices[0].message.content += signature;
        }

        // 2. Inject Trace ID into Tool Call Arguments (Non-Streaming)
        if (responseData.choices[0].message.tool_calls) {
          try {
            responseData.choices[0].message.tool_calls = responseData.choices[0].message.tool_calls.map((toolCall: any) => {
              if (toolCall.function && toolCall.function.arguments) {
                const args = JSON.parse(toolCall.function.arguments);
                args._whyops_trace_id = traceId; // Inject Trace ID
                toolCall.function.arguments = JSON.stringify(args);
              }
              return toolCall;
            });
          } catch (e) {
            logger.warn({ error: e }, 'Failed to inject traceId into tool calls');
          }
        }
      }

      const parsedResponse = OpenAIParser.parseResponse(responseData);
      const annotations = OpenAIParser.extractChatAnnotations(responseData);
      const refusal = OpenAIParser.extractChatRefusal(responseData);
      
      // Strip signature from content before saving to DB
      if (parsedResponse.content) {
        parsedResponse.content = stripSignature(parsedResponse.content);
      }

      // 2. Send Response Event
      dispatchAnalyseEvent(auth.apiKey, {
        traceId,
        spanId: generateSpanId(),
        eventType: 'llm_response',
        providerId: provider.id,
        agentName,
        content: {
          content: parsedResponse.content,
          toolCalls: parsedResponse.toolCalls, // Ensure tool calls are passed
          finishReason: parsedResponse.finishReason,
          refusal,
          annotations,
        },
        metadata: {
          model: requestBody.model,
          provider: isCustom ? 'custom' : 'openai',
          providerSlug: providerSlug || undefined,
          usage: parsedResponse.usage,
          latencyMs,
        }
      });

      return c.json(responseData);
    }
  } catch (error: any) {
    // ... error handling ...
    const latencyMs = Date.now() - startTime;
    dispatchAnalyseEvent(auth.apiKey, {
      traceId: traceId!,
      spanId: generateSpanId(),
      eventType: 'error',
      providerId: provider.id,
      agentName,
      content: { message: error.message },
      metadata: { latencyMs }
    });
    return c.json({ error: error.message }, 500);
  }
});

// Other OpenAI endpoints can be added here (embeddings, images, etc.)

// OpenAI Responses endpoint
app.post('/responses', async (c) => {
  const auth = c.get('whyopsAuth') as ApiKeyAuthContext;
  const requestBody = await c.req.json() as OpenAIResponsesRequest;
  const isStreaming = requestBody.stream === true;

  const startTime = Date.now();
  const agentName = c.req.header('X-Agent-Name');

  if (!agentName) {
    return c.json({ error: 'Missing required header: X-Agent-Name' }, 400);
  }

  const { provider, isCustom, providerSlug, actualModel } = await resolveProviderFromModel(
    auth.userId,
    requestBody.model,
    auth.provider
  );
  const providerValidation = validateResolvedProvider(provider);
  if (!providerValidation.valid) {
    return c.json({ error: providerValidation.message }, 400);
  }
  requestBody.model = actualModel;
  
  // 1. Try to find traceId from Headers
  let traceId = c.req.header('X-Trace-ID') || c.req.header('X-Thread-ID');

  // 2. If not found, try to extract hidden signature from the last assistant message in 'input'
  // The 'input' field in /responses can be a string (prompt) or an array (conversation history)
  if (!traceId && requestBody.input && Array.isArray(requestBody.input)) {
    // Iterate backwards to find the last assistant message
    for (let i = requestBody.input.length - 1; i >= 0; i--) {
      const item = requestBody.input[i];
      // Skip non-message items (e.g. reasoning blocks)
      if (item.type && item.type !== 'message') continue;

      // Check if it's a message from assistant
      if (item.role === 'assistant' && item.content) {
        // Content can be string or array of parts
        if (typeof item.content === 'string') {
           const extractedId = decodeSignature(item.content);
           if (extractedId) {
             traceId = extractedId;
             break;
           }
        } else if (Array.isArray(item.content)) {
           // Check text parts
           for (const part of item.content) {
             // Support both output_text (from response) and generic text parts
             if ((part.type === 'output_text' || part.type === 'text') && part.text) {
               const extractedId = decodeSignature(part.text);
               if (extractedId) {
                 traceId = extractedId;
                 break;
               }
             }
           }
        }
        if (traceId) break;
      }
    }
    if (traceId) {
        logger.debug({ traceId }, 'Extracted traceId from invisible signature in /responses input');
    }
  }

  // 3. Fallback to generating new trace if not provided
  if (!traceId) {
    traceId = generateThreadId();
  }

  // Generate a distinct span ID for this interaction request
  const requestSpanId = generateSpanId();

  // CLEANUP: Strip signatures from input history before sending to OpenAI
  // Handle String Input
  if (typeof requestBody.input === 'string') {
     requestBody.input = stripSignature(requestBody.input);
  }
  // Handle Array Input
  else if (requestBody.input && Array.isArray(requestBody.input)) {
    requestBody.input = requestBody.input.map((item: any) => {
      // Skip non-message items
      if (item.type && item.type !== 'message') return item;

      if (item.role === 'assistant' && item.content) {
        if (typeof item.content === 'string') {
          return { ...item, content: stripSignature(item.content) };
        } else if (Array.isArray(item.content)) {
          return {
            ...item,
            content: item.content.map((part: any) => {
              if ((part.type === 'output_text' || part.type === 'text') && part.text) {
                return { ...part, text: stripSignature(part.text) };
              }
              return part;
            })
          };
        }
      }
      return item;
    });
  }

  logger.info({
    model: requestBody.model,
    stream: isStreaming,
    traceId,
  }, 'OpenAI Responses API request received');
  
  // Set Trace ID in Response Header for client awareness
  c.header('X-Trace-ID', traceId);
  c.header('X-Thread-ID', traceId);

  dispatchAnalyseEvent(auth.apiKey, {

    traceId,
    spanId: requestSpanId,
    eventType: determineResponsesRequestEventType(requestBody.input),
    providerId: provider.id,
    agentName,
    content: requestBody.input || requestBody.conversation, // Log input
    metadata: {
      model: requestBody.model,
      provider: isCustom ? 'custom' : 'openai',
      providerSlug: providerSlug || undefined,
      params: {
        temperature: requestBody.temperature,
        maxOutputTokens: requestBody.max_output_tokens,
        topP: requestBody.top_p,
        truncation: requestBody.truncation,
        reasoning: requestBody.reasoning,
        toolChoice: requestBody.tool_choice,
        parallelToolCalls: requestBody.parallel_tool_calls,
      }
    }
  });

  try {
    const openaiUrl = `${provider.baseUrl}/responses`;
    const headers = {
      'Authorization': `Bearer ${provider.apiKey}`,
      'Content-Type': 'application/json',
      'User-Agent': 'WhyOps-Proxy/1.0',
    };

    // Prepare the invisible signature to inject into the response
    const signature = encodeSignature(traceId);

    if (isStreaming) {
      const response = await fetch(openaiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        logger.error({ status: response.status, errorBody }, 'OpenAI API error');

        dispatchAnalyseEvent(auth.apiKey, {
          traceId,
          spanId: generateSpanId(),
          eventType: 'error',
          providerId: provider.id,
          agentName,
          content: { error: errorBody, status: response.status },
          metadata: { latencyMs: Date.now() - startTime }
        });

        return responseFromUpstreamError(response.status, response.headers.get('content-type'), errorBody);
      }

      if (!response.body) {
        throw new Error('No response body');
      }

      const [clientBranch, analyticsBranch] = response.body.tee();
      trackResponsesStream(
        analyticsBranch,
        auth.apiKey,
        traceId,
        provider.id,
        agentName,
        requestBody.model,
        isCustom,
        providerSlug,
        startTime
      ).catch((error) => logger.warn({ error, traceId }, 'Failed to parse OpenAI /responses streaming analytics'));

      const upstreamHeaders = copyProxyResponseHeaders(response.headers);
      upstreamHeaders.set('X-Trace-ID', traceId);
      upstreamHeaders.set('X-Thread-ID', traceId);

      return new Response(clientBranch, {
        status: response.status,
        headers: upstreamHeaders,
      });
    } else {
      // Non-streaming logic
      const response = await fetch(openaiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(env.PROXY_TIMEOUT_MS),
      });

      const latencyMs = Date.now() - startTime;
      const responseData = await response.json() as OpenAIResponsesResponse;

      if (!response.ok) {
        dispatchAnalyseEvent(auth.apiKey, {
          traceId,
          spanId: generateSpanId(),
          eventType: 'error',
          providerId: provider.id,
          agentName,
          content: responseData,
          metadata: { latencyMs }
        });
        return c.json(responseData, response.status as any);
      }

      // Inject signature into response content
      // Logic for /responses structure: output[].content[].text
      if (responseData.output && Array.isArray(responseData.output)) {
        let signatureInjected = false;
        for (const item of responseData.output) {
            // Handle Standard Message Output
            if (item.type === 'message') {
                if (item.content) {
                    // Find the first text output to append signature
                    const textPart = item.content.find((part: any) => part.type === 'output_text');
                    if (textPart && !signatureInjected) {
                        textPart.text += signature;
                        signatureInjected = true; 
                    }
                }

                // Inject Trace ID into Tool Call Arguments (Message embedded)
                if (item.tool_calls) {
                  try {
                    item.tool_calls = item.tool_calls.map((toolCall: any) => {
                      if (toolCall.function && toolCall.function.arguments) {
                        const args = JSON.parse(toolCall.function.arguments);
                        args._whyops_trace_id = traceId; // Inject Trace ID
                        toolCall.function.arguments = JSON.stringify(args);
                      }
                      return toolCall;
                    });
                  } catch (e) {
                    logger.warn({ error: e }, 'Failed to inject traceId into message tool calls');
                  }
                }
            }
            
            // Handle Direct Function Call Item (Azure/OpenRouter specific?)
            if (item.type === 'function_call') {
                 if (item.arguments) {
                     try {
                        const args = JSON.parse(item.arguments);
                        args._whyops_trace_id = traceId; // Inject Trace ID
                        item.arguments = JSON.stringify(args);
                     } catch (e) {
                        logger.warn({ error: e }, 'Failed to inject traceId into function_call item');
                     }
                 }
            }
        }
      }

      const parsedResponse = OpenAIParser.parseResponsesResponse(responseData);
      
      // Strip signature from content before saving to DB
      if (parsedResponse.content) {
        parsedResponse.content = stripSignature(parsedResponse.content);
      }

      // 2. Send Response Event
      dispatchAnalyseEvent(auth.apiKey, {
        traceId,
        spanId: generateSpanId(),
        eventType: 'llm_response',
        providerId: provider.id,
        agentName,
        content: {
          content: parsedResponse.content,
          toolCalls: parsedResponse.toolCalls,
          finishReason: parsedResponse.finishReason,
        },
        metadata: {
          model: requestBody.model,
          provider: isCustom ? 'custom' : 'openai',
          providerSlug: providerSlug || undefined,
          usage: parsedResponse.usage,
          latencyMs,
        }
      });

      return c.json(responseData);
    }
  } catch (error: any) {
    const latencyMs = Date.now() - startTime;
    dispatchAnalyseEvent(auth.apiKey, {
      traceId: traceId!,
      spanId: generateSpanId(),
      eventType: 'error',
      providerId: provider.id,
      agentName,
      content: { message: error.message },
      metadata: { latencyMs }
    });
    return c.json({ error: error.message }, 500);
  }
});

// OpenAI Models endpoint
app.get('/models', async (c) => {
  const auth = c.get('whyopsAuth') as ApiKeyAuthContext;
  
  try {
    const { provider } = await resolveProviderFromModel(auth.userId, 'models', auth.provider);
    const providerValidation = validateResolvedProvider(provider);
    if (!providerValidation.valid) {
      return c.json({ error: providerValidation.message }, 400);
    }

    const response = await fetch(`${provider.baseUrl}/models`, {
      headers: {
        'Authorization': `Bearer ${provider.apiKey}`,
      },
    });

    const data = await response.json();
    return c.json(data);
  } catch (error: any) {
    logger.error({ error }, 'Failed to fetch models');
    return c.json({ error: error.message }, 500);
  }
});

export default app;
