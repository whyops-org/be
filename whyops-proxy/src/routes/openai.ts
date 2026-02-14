import env from '@whyops/shared/env';
import { createServiceLogger } from '@whyops/shared/logger';
import { Provider } from '@whyops/shared/models';
import { decodeSignature, decrypt, encodeSignature, generateSpanId, generateThreadId, stripSignature } from '@whyops/shared/utils';
import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { OpenAIParser } from '../parsers/openai-parser';
import { sendToAnalyse } from '../services/analyse';

const logger = createServiceLogger('proxy:openai');
const app = new Hono();

/**
 * Parse model field to extract provider slug and actual model name
 * Format: "provider-slug/model-name" or just "model-name"
 * Returns: { providerSlug: string | null, model: string }
 */
function parseModelField(model: string): { providerSlug: string | null; actualModel: string } {
  if (!model || !model.includes('/')) {
    return { providerSlug: null, actualModel: model };
  }

  const parts = model.split('/');
  // If it looks like a slug (contains dash), treat first part as slug
  if (parts[0].includes('-')) {
    return { providerSlug: parts[0], actualModel: parts.slice(1).join('/') };
  }

  // Otherwise, treat as just model name
  return { providerSlug: null, actualModel: model };
}

/**
 * Get provider by slug or return default from auth context
 */
async function getProviderBySlugOrDefault(
  userId: string,
  providerSlug: string | null,
  defaultProvider: any
): Promise<{ provider: any; isCustom: boolean }> {
  // If no slug provided, use default provider from API key
  if (!providerSlug) {
    return { provider: defaultProvider, isCustom: false };
  }

  // Try to find provider by slug
  const provider = await Provider.findOne({
    where: {
      userId,
      slug: providerSlug,
      isActive: true,
    },
  });

  if (provider) {
    // Decrypt the API key
    const decryptedApiKey = decrypt(provider.apiKey);
    return {
      provider: {
        ...provider.toJSON(),
        apiKey: decryptedApiKey,
      },
      isCustom: true,
    };
  }

  // Fall back to default provider if slug not found
  logger.warn({ providerSlug }, 'Provider slug not found, using default');
  return { provider: defaultProvider, isCustom: false };
}

// OpenAI Chat Completions endpoint
app.post('/chat/completions', async (c) => {
  const auth = c.get('auth');
  const requestBody = await c.req.json();
  const isStreaming = requestBody.stream === true;

  const startTime = Date.now();
  const entityName = c.req.header('X-Entity-Name');

  // Parse provider slug from model field (format: provider-slug/model or just model)
  const { providerSlug, actualModel } = parseModelField(requestBody.model);

  // Get provider - either by slug or from API key's default
  const { provider, isCustom } = await getProviderBySlugOrDefault(
    auth.userId,
    providerSlug,
    auth.provider
  );

  // Use actual model for the API call
  requestBody.model = actualModel;

  // 1. Try to find traceId from Headers
  let traceId = c.req.header('X-Thread-ID');

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
  sendToAnalyse(auth.apiKey, {
    traceId,
    spanId: requestSpanId,
    eventType: 'user_message',
    providerId: provider.id,
    entityName,
    content: requestBody.messages,
    metadata: {
      model: actualModel,
      provider: isCustom ? 'custom' : 'openai',
      providerSlug: providerSlug || undefined,
      params: {
        temperature: requestBody.temperature,
        maxTokens: requestBody.max_tokens,
      }
    }
  }).catch(err => logger.error({ err }, 'Failed to send request event'));

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
      return stream(c, async (stream) => {
        const response = await fetch(openaiUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
          // ... error handling ...
          const error = await response.text();
          logger.error({ status: response.status, error }, 'OpenAI API error');
          
          sendToAnalyse(auth.apiKey, {
            traceId: traceId!, // Assertion as we ensure it exists
            spanId: generateSpanId(),
            eventType: 'error',
            providerId: provider.id,
            entityName,
            content: { error, status: response.status },
            metadata: { latencyMs: Date.now() - startTime }
          });
          
          await stream.write(JSON.stringify({ error: 'Provider API error', details: error }));
          return;
        }

        let accumulatedState = OpenAIParser.getInitialStreamState();
        const reader = response.body?.getReader();
        const decoder = new TextDecoder();
        let signatureSent = false;

        if (!reader) throw new Error('No response body');

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split('\n').filter(line => line.trim().startsWith('data: '));
            
            for (const line of lines) {
              const data = line.replace('data: ', '').trim();
              if (data === '[DONE]') {
                // Inject signature in the final chunk (or as a separate chunk before DONE)
                if (!signatureSent) {
                   const signatureChunk = {
                     id: accumulatedState.id || "gen-signature",
                     object: "chat.completion.chunk",
                     created: Date.now(),
                     model: requestBody.model,
                     choices: [{
                       index: 0,
                       delta: { content: signature }, // Inject invisible signature
                       finish_reason: null
                     }]
                   };
                   await stream.write(`data: ${JSON.stringify(signatureChunk)}\n\n`);
                   signatureSent = true;
                }

                await stream.write(`data: [DONE]\n\n`);
                continue;
              }
              try {
                const parsed = JSON.parse(data);
                accumulatedState = OpenAIParser.parseStreamChunk(parsed, accumulatedState);
                await stream.write(`data: ${data}\n\n`);
              } catch (e) { }
            }
          }

          // ... (Send Response Event logic) ...
          sendToAnalyse(auth.apiKey, {
            traceId: traceId!,
            spanId: generateSpanId(),
            eventType: 'llm_response',
            providerId: provider.id,
            entityName,
            content: {
              content: accumulatedState.content,
              toolCalls: accumulatedState.toolCalls,
              finishReason: accumulatedState.finishReason,
            },
            metadata: {
              model: requestBody.model,
              provider: 'openai',
              usage: accumulatedState.usage,
              latencyMs: Date.now() - startTime,
            }
          }).catch(err => logger.error({ err }, 'Failed to send response event'));

        } finally {
          reader.releaseLock();
        }
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
      const responseData = await response.json() as any;

      if (!response.ok) {
        // ... error handling ...
        sendToAnalyse(auth.apiKey, {
          traceId,
          spanId: generateSpanId(),
          eventType: 'error',
          providerId: provider.id,
          entityName,
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
      
      // Strip signature from content before saving to DB
      if (parsedResponse.content) {
        parsedResponse.content = stripSignature(parsedResponse.content);
      }

      // 2. Send Response Event
      sendToAnalyse(auth.apiKey, {
        traceId,
        spanId: generateSpanId(),
        eventType: 'llm_response',
        providerId: provider.id,
        entityName,
        content: {
          content: parsedResponse.content,
          toolCalls: parsedResponse.toolCalls, // Ensure tool calls are passed
          finishReason: parsedResponse.finishReason,
        },
        metadata: {
          model: requestBody.model,
          provider: 'openai',
          usage: parsedResponse.usage,
          latencyMs,
        }
      }).catch(err => logger.error({ err }, 'Failed to send response event'));

      return c.json(responseData);
    }
  } catch (error: any) {
    // ... error handling ...
    const latencyMs = Date.now() - startTime;
    sendToAnalyse(auth.apiKey, {
      traceId: traceId!,
      spanId: generateSpanId(),
      eventType: 'error',
      providerId: provider.id,
      entityName,
      content: { message: error.message },
      metadata: { latencyMs }
    });
    return c.json({ error: error.message }, 500);
  }
});

// Other OpenAI endpoints can be added here (embeddings, images, etc.)

// OpenAI Responses endpoint
app.post('/responses', async (c) => {
  const auth = c.get('auth');
  const requestBody = await c.req.json();
  const isStreaming = requestBody.stream === true;

  const startTime = Date.now();
  const entityName = c.req.header('X-Entity-Name');

  const { providerSlug, actualModel } = parseModelField(requestBody.model);

  // Get provider - either by slug or from API key's default
  const { provider } = await getProviderBySlugOrDefault(
    auth.userId,
    providerSlug,
    auth.provider
  );
  
  // 1. Try to find traceId from Headers
  let traceId = c.req.header('X-Thread-ID');

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
  c.header('X-Thread-ID', traceId);

  sendToAnalyse(auth.apiKey, {

    traceId,
    spanId: requestSpanId,
    eventType: 'user_message',
    providerId: provider.id,
    entityName,
    content: requestBody.input || requestBody.conversation, // Log input
    metadata: {
      model: requestBody.model,
      provider: 'openai',
      params: {
        temperature: requestBody.temperature,
      }
    }
  }).catch(err => logger.error({ err }, 'Failed to send request event'));

  try {
    const provider = auth.provider;
    const openaiUrl = `${provider.baseUrl}/responses`;
    const headers = {
      'Authorization': `Bearer ${provider.apiKey}`,
      'Content-Type': 'application/json',
      'User-Agent': 'WhyOps-Proxy/1.0',
    };

    // Prepare the invisible signature to inject into the response
    const signature = encodeSignature(traceId);

    if (isStreaming) {
      return stream(c, async (stream) => {
        const response = await fetch(openaiUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
          const error = await response.text();
          logger.error({ status: response.status, error }, 'OpenAI API error');
          
          sendToAnalyse(auth.apiKey, {
            traceId: traceId!,
            spanId: generateSpanId(),
            eventType: 'error',
            providerId: provider.id,
            entityName,
            content: { error, status: response.status },
            metadata: { latencyMs: Date.now() - startTime }
          });
          
          await stream.write(JSON.stringify({ error: 'Provider API error', details: error }));
          return;
        }

        // Pass-through streaming with background logging
        const reader = response.body?.getReader();
        if (!reader) throw new Error('No response body');

        // Async logging without blocking stream
        (async () => {
             const decoder = new TextDecoder();
             let accumulatedState = OpenAIParser.getInitialStreamState();
             // We need a separate reader or clone? 
             // Response body reader can only be read once.
             // We are reading it in the loop below.
             // We must hook into the loop below.
        })();

        const decoder = new TextDecoder();
        let accumulatedState = OpenAIParser.getInitialStreamState();

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            // 1. Write to client immediately (Low Latency)
            await stream.write(value);

            // 2. Accumulate for analytics
            try {
                const chunkStr = decoder.decode(value, { stream: true });
                const lines = chunkStr.split('\n').filter(line => line.trim().startsWith('data: '));
                for (const line of lines) {
                    const data = line.replace('data: ', '').trim();
                    if (data === '[DONE]') continue;
                    try {
                        const parsed = JSON.parse(data);
                        accumulatedState = OpenAIParser.parseResponsesStreamChunk(parsed, accumulatedState);
                    } catch (e) {}
                }
            } catch (e) {
                // Ignore parsing errors during streaming to avoid disruption
            }
          }
          
           // Send Response Event after stream ends
           sendToAnalyse(auth.apiKey, {
            traceId: traceId!,
            spanId: generateSpanId(),
            eventType: 'llm_response',
            providerId: provider.id,
            entityName,
            content: {
              content: accumulatedState.content,
              // toolCalls: accumulatedState.toolCalls, // Tool calls in streaming /responses tricky to capture perfectly yet
              finishReason: accumulatedState.finishReason || 'stop',
            },
            metadata: {
              model: requestBody.model,
              provider: 'openai',
              usage: accumulatedState.usage,
              latencyMs: Date.now() - startTime,
            }
          }).catch(err => logger.error({ err }, 'Failed to send response event'));

        } finally {
          reader.releaseLock();
        }
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
      const responseData = await response.json() as any;

      if (!response.ok) {
        sendToAnalyse(auth.apiKey, {
          traceId,
          spanId: generateSpanId(),
          eventType: 'error',
          providerId: provider.id,
          entityName,
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
      sendToAnalyse(auth.apiKey, {
        traceId,
        spanId: generateSpanId(),
        eventType: 'llm_response',
        providerId: provider.id,
        entityName,
        content: {
          content: parsedResponse.content,
          finishReason: parsedResponse.finishReason,
        },
        metadata: {
          model: requestBody.model,
          provider: 'openai',
          usage: parsedResponse.usage,
          latencyMs,
        }
      }).catch(err => logger.error({ err }, 'Failed to send response event'));

      return c.json(responseData);
    }
  } catch (error: any) {
    const latencyMs = Date.now() - startTime;
    sendToAnalyse(auth.apiKey, {
      traceId: traceId!,
      spanId: generateSpanId(),
      eventType: 'error',
      providerId: provider.id,
      entityName,
      content: { message: error.message },
      metadata: { latencyMs }
    });
    return c.json({ error: error.message }, 500);
  }
});

// OpenAI Models endpoint
app.get('/models', async (c) => {
  const auth = c.get('auth');
  
  try {
    const provider = auth.provider;
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
