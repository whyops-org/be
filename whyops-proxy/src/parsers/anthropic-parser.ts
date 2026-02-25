import { createServiceLogger } from '@whyops/shared/logger';
import type { AnthropicMessageResponse, AnthropicStreamEvent } from '../types/anthropic';

const logger = createServiceLogger('proxy:parser:anthropic');

export interface ParsedResponse {
  content?: string;
  toolCalls?: any[];
  finishReason?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  thinkingBlocks?: Array<
    | { type: 'thinking'; thinking: string; signature?: string }
    | { type: 'redacted_thinking'; data: string }
  >;
  id?: string;
  created?: number;
}

export class AnthropicParser {
  /**
   * Parse a non-streaming response from Anthropic
   */
  static parseResponse(data: AnthropicMessageResponse): ParsedResponse {
    let content = '';
    const toolCalls: any[] = [];
    const thinkingBlocks: ParsedResponse['thinkingBlocks'] = [];

    if (Array.isArray(data.content)) {
      for (const block of data.content) {
        if (block.type === 'text' && (block as any).text) {
          content += (block as any).text;
        }
        if (block.type === 'thinking') {
          thinkingBlocks?.push({
            type: 'thinking',
            thinking: (block as any).thinking || '',
            signature: (block as any).signature,
          });
        }
        if (block.type === 'redacted_thinking') {
          thinkingBlocks?.push({
            type: 'redacted_thinking',
            data: (block as any).data || '',
          });
        }
        if (block.type === 'tool_use' || block.type === 'server_tool_use') {
          const input = (block as any).input ?? {};
          toolCalls.push({
            id: (block as any).id,
            type: 'function',
            function: {
              name: (block as any).name,
              arguments: JSON.stringify(input),
            },
          });
        }
      }
    }

    return {
      content: content || undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason: data.stop_reason || undefined,
      thinkingBlocks: thinkingBlocks && thinkingBlocks.length > 0 ? thinkingBlocks : undefined,
      usage: data.usage ? {
        promptTokens: data.usage.input_tokens,
        completionTokens: data.usage.output_tokens,
        totalTokens: data.usage.input_tokens + data.usage.output_tokens,
      } : undefined,
      id: data.id,
      created: Date.now(), // Anthropic doesn't always send created timestamp in same format
    };
  }

  /**
   * Parse a single SSE event from a streaming response
   * Anthropic streaming is event-based (message_start, content_block_delta, etc.)
   */
  static parseStreamEvent(
    data: AnthropicStreamEvent,
    accumulated: ParsedResponse,
    toolCallState?: Map<number, any>,
    thinkingState?: Map<number, any>
  ): ParsedResponse {
    const result: ParsedResponse = { ...accumulated };

    switch (data.type) {
      case 'message_start':
        if (data.message?.id) result.id = data.message.id;
        if (data.message?.usage) {
          // Initial input usage
          result.usage = {
            promptTokens: data.message.usage.input_tokens,
            completionTokens: 0,
            totalTokens: data.message.usage.input_tokens,
          };
        }
        break;

      case 'content_block_start':
        if (data.content_block?.type === 'tool_use' || data.content_block?.type === 'server_tool_use') {
          const input = (data.content_block as any).input ?? {};
          const index = data.index ?? 0;
          const toolCall = {
            id: (data.content_block as any).id,
            type: 'function',
            function: {
              name: (data.content_block as any).name,
              arguments: Object.keys(input).length > 0 ? JSON.stringify(input) : '',
            },
          };
          if (toolCallState) toolCallState.set(index, toolCall);
          result.toolCalls = Array.from(toolCallState?.values() || [toolCall]);
        }
        if (data.content_block?.type === 'thinking') {
          const index = data.index ?? 0;
          if (thinkingState) {
            thinkingState.set(index, { type: 'thinking', thinking: '', signature: '' });
          }
        }
        if (data.content_block?.type === 'redacted_thinking') {
          const index = data.index ?? 0;
          if (thinkingState) {
            thinkingState.set(index, { type: 'redacted_thinking', data: (data.content_block as any).data || '' });
          }
        }
        break;

      case 'content_block_delta':
        if (data.delta?.type === 'text_delta') {
          result.content = (result.content || '') + data.delta.text;
        }
        if (data.delta?.type === 'thinking_delta') {
          const index = data.index ?? 0;
          const existing = thinkingState?.get(index);
          if (existing && existing.type === 'thinking') {
            existing.thinking = (existing.thinking || '') + data.delta.thinking;
            thinkingState?.set(index, existing);
          }
        }
        if (data.delta?.type === 'signature_delta') {
          const index = data.index ?? 0;
          const existing = thinkingState?.get(index);
          if (existing && existing.type === 'thinking') {
            existing.signature = data.delta.signature;
            thinkingState?.set(index, existing);
          }
        }
        if (data.delta?.type === 'input_json_delta') {
          const index = data.index ?? 0;
          const existing = toolCallState?.get(index);
          if (existing) {
            existing.function.arguments = (existing.function.arguments || '') + data.delta.partial_json;
            toolCallState?.set(index, existing);
            result.toolCalls = toolCallState
              ? Array.from(toolCallState.values())
              : [existing];
          }
        }
        if (thinkingState) {
          result.thinkingBlocks = Array.from(thinkingState.values());
        }
        break;

      case 'message_delta':
        if (data.delta?.stop_reason) {
          result.finishReason = data.delta.stop_reason;
        }
        if (data.usage) {
          // Update output usage
          const currentInput = result.usage?.promptTokens || 0;
          const output = data.usage.output_tokens;
          result.usage = {
            promptTokens: currentInput,
            completionTokens: output,
            totalTokens: currentInput + output,
          };
        }
        break;
        
      case 'message_stop':
        // Final event
        break;
      case 'error':
        result.finishReason = 'error';
        break;
    }

    return result;
  }

  static getInitialStreamState(): ParsedResponse {
    return {
      content: '',
      toolCalls: undefined,
      finishReason: undefined,
      usage: undefined,
      thinkingBlocks: undefined,
    };
  }
}
