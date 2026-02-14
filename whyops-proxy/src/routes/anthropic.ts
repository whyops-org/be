import env from '@whyops/shared/env';
import { createServiceLogger } from '@whyops/shared/logger';
import { generateSpanId, generateThreadId } from '@whyops/shared/utils';
import { Provider } from '@whyops/shared/models';
import { decrypt } from '@whyops/shared/utils';
import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { sendToAnalyse } from '../services/analyse';

const logger = createServiceLogger('proxy:anthropic');
const app = new Hono();

/**
 * Parse model field to extract provider slug and actual model name
 * Format: "provider-slug/model-name" or just "model-name"
 * Returns: { providerSlug: string | null, actualModel: string }
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

// Anthropic Messages endpoint
app.post('/messages', async (c) => {
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

  const threadId = c.req.header('X-Thread-ID') || generateThreadId();
  const spanId = generateSpanId();

  logger.info({
    model: actualModel,
    providerSlug,
    isCustom,
    stream: isStreaming,
    threadId,
  }, 'Anthropic request received');

  try {
    // Build request to Anthropic
    const anthropicUrl = `${provider.baseUrl}/messages`;
    const headers = {
      'x-api-key': provider.apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
      'User-Agent': 'WhyOps-Proxy/1.0',
    };

    if (isStreaming) {
      // Handle streaming response
      return stream(c, async (stream) => {
        const response = await fetch(anthropicUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
          const error = await response.text();
          logger.error({ status: response.status, error }, 'Anthropic API error');
          
          // Send error to analyse service (non-blocking)
          sendToAnalyse(auth.apiKey, {
            eventType: 'llm_response',
            threadId,
            spanId,
            providerId: provider?.id,
            entityName,
            provider: 'anthropic',
            model: requestBody.model,
            messages: requestBody.messages,
            error: error,
            latencyMs: Date.now() - startTime,
          }).catch(err => logger.error({ err }, 'Failed to send error to analyse'));
          
          await stream.write(JSON.stringify({ error: 'Provider API error', details: error }));
          return;
        }

        // Collect chunks for logging
        const chunks: any[] = [];
        let accumulatedResponse: any = {
          id: '',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: '' }],
          model: requestBody.model,
          stop_reason: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        };

        const reader = response.body?.getReader();
        const decoder = new TextDecoder();

        if (!reader) {
          throw new Error('No response body');
        }

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            
            // Parse SSE format
            const lines = chunk.split('\n').filter(line => line.trim().startsWith('data: '));
            
            for (const line of lines) {
              const data = line.replace('data: ', '').trim();

              try {
                const parsed = JSON.parse(data);
                chunks.push(parsed);
                
                // Accumulate content based on event type
                if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
                  accumulatedResponse.content[0].text += parsed.delta.text;
                }
                if (parsed.type === 'message_delta' && parsed.delta?.stop_reason) {
                  accumulatedResponse.stop_reason = parsed.delta.stop_reason;
                }
                if (parsed.type === 'message_start' && parsed.message) {
                  accumulatedResponse.id = parsed.message.id;
                  accumulatedResponse.usage = parsed.message.usage;
                }
                
                // Forward to client
                await stream.write(`data: ${data}\n\n`);
              } catch (e) {
                // Skip invalid JSON
                logger.warn({ line }, 'Failed to parse SSE chunk');
              }
            }
          }

          // Send to analyse service (non-blocking)
          const latencyMs = Date.now() - startTime;
          sendToAnalyse(auth.apiKey, {
            eventType: 'llm_response',
            threadId,
            spanId,
            providerId: provider?.id,
            entityName,
            provider: 'anthropic',
            model: requestBody.model,
            systemPrompt: requestBody.system,
            messages: requestBody.messages,
            temperature: requestBody.temperature,
            maxTokens: requestBody.max_tokens,
            response: {
              content: accumulatedResponse.content[0].text,
              finishReason: accumulatedResponse.stop_reason,
            },
            usage: accumulatedResponse.usage ? {
              promptTokens: accumulatedResponse.usage.input_tokens,
              completionTokens: accumulatedResponse.usage.output_tokens,
              totalTokens: accumulatedResponse.usage.input_tokens + accumulatedResponse.usage.output_tokens,
            } : undefined,
            latencyMs,
          }).catch(err => logger.error({ err }, 'Failed to send to analyse'));

          logger.info({ threadId, latencyMs, chunksCount: chunks.length }, 'Streaming completed');
          
        } finally {
          reader.releaseLock();
        }
      });
    } else {
      // Handle non-streaming response
      const response = await fetch(anthropicUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(env.PROXY_TIMEOUT_MS),
      });

      const latencyMs = Date.now() - startTime;
      const responseData = await response.json() as {
        content?: { text?: string }[],
        stop_reason?: string,
        usage?: { input_tokens: number, output_tokens: number }
        [key: string]: any
      };

      if (!response.ok) {
        logger.error({ status: response.status, responseData }, 'Anthropic API error');
        
        // Send error to analyse service (non-blocking)
        sendToAnalyse(auth.apiKey, {
          eventType: 'llm_response',
          threadId,
          spanId,
          providerId: provider?.id,
          entityName,
          provider: 'anthropic',
          model: requestBody.model,
          messages: requestBody.messages,
          error: JSON.stringify(responseData),
          latencyMs,
        }).catch(err => logger.error({ err }, 'Failed to send error to analyse'));
        
        return c.json(responseData, response.status as any);
      }

      // Send to analyse service (non-blocking)
      sendToAnalyse(auth.apiKey, {
        eventType: 'llm_response',
        threadId,
        spanId,
        providerId: provider?.id,
        entityName,
        provider: 'anthropic',
        model: requestBody.model,
        systemPrompt: requestBody.system,
        messages: requestBody.messages,
        temperature: requestBody.temperature,
        maxTokens: requestBody.max_tokens,
        response: {
          content: responseData.content?.[0]?.text,
          finishReason: responseData.stop_reason,
        },
        usage: responseData.usage ? {
          promptTokens: responseData.usage.input_tokens,
          completionTokens: responseData.usage.output_tokens,
          totalTokens: responseData.usage.input_tokens + responseData.usage.output_tokens,
        } : undefined,
        latencyMs,
      }).catch(err => logger.error({ err }, 'Failed to send to analyse'));

      logger.info({ threadId, latencyMs, model: requestBody.model }, 'Request completed');

      // Return response to client
      return c.json(responseData);
    }
  } catch (error: any) {
    const latencyMs = Date.now() - startTime;
    logger.error({ error, threadId }, 'Request failed');

    // Send error to analyse service (non-blocking)
    sendToAnalyse(auth.apiKey, {
      eventType: 'llm_response',
      threadId,
      spanId,
      providerId: provider?.id,
      entityName,
      provider: 'anthropic',
      model: requestBody.model,
      messages: requestBody.messages,
      error: error.message,
      latencyMs,
    }).catch(err => logger.error({ err }, 'Failed to send error to analyse'));

    return c.json({ error: error.message }, 500);
  }
});

export default app;
