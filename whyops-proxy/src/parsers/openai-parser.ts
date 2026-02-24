import { createServiceLogger } from '@whyops/shared/logger';
import type {
  OpenAIChatCompletionChunk,
  OpenAIChatCompletionResponse,
  OpenAIResponsesResponse,
  OpenAIResponsesStreamEvent,
  OpenAIToolCall,
} from '../types/openai';

const logger = createServiceLogger('proxy:parser:openai');

export interface ParsedResponse {
  content?: string;
  toolCalls?: any[];
  finishReason?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  id?: string;
  created?: number;
}

export class OpenAIParser {
  /**
   * Parse a non-streaming response from OpenAI
   */
  static parseResponse(data: OpenAIChatCompletionResponse): ParsedResponse {
    return {
      content: data.choices?.[0]?.message?.content,
      toolCalls: data.choices?.[0]?.message?.tool_calls,
      finishReason: data.choices?.[0]?.finish_reason,
      usage: data.usage ? {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
      } : undefined,
      id: data.id,
      created: data.created,
    };
  }

  static extractChatAnnotations(data: OpenAIChatCompletionResponse): any[] | undefined {
    const annotations = data.choices?.[0]?.message?.annotations;
    return annotations && annotations.length > 0 ? annotations : undefined;
  }

  static extractChatRefusal(data: OpenAIChatCompletionResponse): string | undefined {
    const refusal = data.choices?.[0]?.message?.refusal;
    return refusal || undefined;
  }

  /**
   * Parse a non-streaming response from OpenAI /responses
   */
  static parseResponsesResponse(data: OpenAIResponsesResponse): ParsedResponse {
    let content = '';
    const toolCalls: OpenAIToolCall[] = [];
    let finishReason: string | undefined = data.status;

    if (data.output && Array.isArray(data.output)) {
      for (const item of data.output) {
        if (item.type === 'message') {
          for (const part of item.content || []) {
            if (part.type === 'output_text') {
              content += part.text;
            }
            if ((part as any).type === 'refusal' && (part as any).refusal) {
              finishReason = 'refusal';
            }
          }
        }
        if (item.type === 'function_call') {
          toolCalls.push({
            id: item.call_id,
            type: 'function',
            function: {
              name: item.name,
              arguments: item.arguments,
            },
          });
        }
      }
    }
    if (!content && data.output_text) {
      content = data.output_text;
    }

    return {
      content: content || undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason: finishReason,
      usage: data.usage ? {
        promptTokens: data.usage.input_tokens,
        completionTokens: data.usage.output_tokens,
        totalTokens: data.usage.total_tokens,
      } : undefined,
      id: data.id,
      created: data.created_at,
    };
  }

  /**
   * Parse a single SSE chunk from a streaming response
   */
  static parseStreamChunk(chunk: OpenAIChatCompletionChunk, accumulated: ParsedResponse): ParsedResponse {
    const choice = chunk.choices?.[0];
    const delta = choice?.delta;
    const finishReason = choice?.finish_reason;
    const usage = chunk.usage;

    // Clone accumulated response
    const result: ParsedResponse = { ...accumulated };

    // Update ID and Created if present
    if (chunk.id) result.id = chunk.id;
    if (chunk.created) result.created = chunk.created;

    // Accumulate content
    if (delta?.content) {
      result.content = (result.content || '') + delta.content;
    }

    // Accumulate tool calls (merge by index, append argument deltas)
    if (delta?.tool_calls) {
      if (!result.toolCalls) result.toolCalls = [];

      for (const callDelta of delta.tool_calls) {
        const index = typeof callDelta.index === 'number' ? callDelta.index : 0;

        const existing = result.toolCalls[index] || {
          id: undefined,
          type: undefined,
          function: {
            name: undefined,
            arguments: '',
          },
        };

        if (callDelta.id) {
          existing.id = callDelta.id;
        }

        if (callDelta.type) {
          existing.type = callDelta.type;
        }

        if (callDelta.function?.name) {
          existing.function = existing.function || { name: undefined, arguments: '' };
          existing.function.name = callDelta.function.name;
        }

        if (callDelta.function?.arguments) {
          existing.function = existing.function || { name: undefined, arguments: '' };
          existing.function.arguments = (existing.function.arguments || '') + callDelta.function.arguments;
        }

        result.toolCalls[index] = existing;
      }
    }

    // Accumulate refusal text if streamed
    if (delta?.refusal) {
      result.finishReason = 'refusal';
      result.content = (result.content || '') + delta.refusal;
    }

    // Update finish reason
    if (finishReason) {
      result.finishReason = finishReason;
    }

    // Capture usage (usually in the last chunk)
    if (usage) {
      result.usage = {
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens,
      };
    }

    return result;
  }
  
  /**
   * Initial empty state for streaming accumulation
   */
  static getInitialStreamState(): ParsedResponse {
    return {
      content: '',
      toolCalls: [],
      finishReason: undefined,
      usage: undefined,
    };
  }

  /**
   * Parse a stream chunk from the new /responses API
   * Note: The structure of streaming chunks for /responses is not fully documented publically yet
   * but typically follows a delta pattern. We will attempt to accumulate based on observed patterns
   * or fallback to basic accumulation.
   */
  static parseResponsesStreamChunk(
    event: OpenAIResponsesStreamEvent,
    accumulated: ParsedResponse,
    toolCallState?: Map<string, OpenAIToolCall>
  ): ParsedResponse {
    const result: ParsedResponse = { ...accumulated };

    if (event.type === 'response.created' || event.type === 'response.in_progress' || event.type === 'response.completed' || event.type === 'response.failed' || event.type === 'response.incomplete') {
      const response = (event as any).response as OpenAIResponsesResponse;
      if (response?.id) result.id = response.id;
      if (response?.created_at) result.created = response.created_at;
      if (response?.status) result.finishReason = response.status;
      if (response?.usage) {
        result.usage = {
          promptTokens: response.usage.input_tokens,
          completionTokens: response.usage.output_tokens,
          totalTokens: response.usage.total_tokens,
        };
      }
    }

    if (event.type === 'response.output_text.delta') {
      result.content = (result.content || '') + event.delta;
    }

    if (event.type === 'response.output_text.done') {
      if (!result.content) result.content = event.text;
    }

    if (event.type === 'response.refusal.delta') {
      result.finishReason = 'refusal';
      result.content = (result.content || '') + event.delta;
    }

    if (event.type === 'response.refusal.done') {
      result.finishReason = 'refusal';
    }

    if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
      const item = event.item as any;
      if (item?.type === 'function_call') {
        if (!result.toolCalls) result.toolCalls = [];
        const existing = toolCallState?.get(item.id) || {
          id: item.call_id || item.id,
          type: 'function',
          function: {
            name: item.name,
            arguments: item.arguments || '',
          },
        };
        if (item.name) existing.function.name = item.name;
        if (item.arguments) existing.function.arguments = item.arguments;
        toolCallState?.set(item.id, existing);
        result.toolCalls = Array.from(toolCallState?.values() || [existing]);
      }
    }

    if (event.type === 'response.function_call_arguments.delta') {
      if (!result.toolCalls) result.toolCalls = [];
      const existing = toolCallState?.get(event.item_id) || {
        id: event.item_id,
        type: 'function',
        function: {
          name: '',
          arguments: '',
        },
      };
      existing.function.arguments = (existing.function.arguments || '') + event.delta;
      toolCallState?.set(event.item_id, existing);
      result.toolCalls = Array.from(toolCallState?.values() || [existing]);
    }

    if (event.type === 'response.function_call_arguments.done') {
      const existing = toolCallState?.get(event.item_id);
      if (existing) {
        existing.function.arguments = event.arguments || existing.function.arguments;
        toolCallState?.set(event.item_id, existing);
        result.toolCalls = Array.from(toolCallState?.values());
      }
    }

    return result;
  }
}
