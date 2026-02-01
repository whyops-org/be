import { createServiceLogger } from '@whyops/shared/logger';

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
  static parseResponse(data: any): ParsedResponse {
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

  /**
   * Parse a single SSE chunk from a streaming response
   */
  static parseStreamChunk(chunk: any, accumulated: ParsedResponse): ParsedResponse {
    const delta = chunk.choices?.[0]?.delta;
    const finishReason = chunk.choices?.[0]?.finish_reason;
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

    // Accumulate tool calls (simplified for now, robust tool call merging is complex)
    if (delta?.tool_calls) {
      if (!result.toolCalls) result.toolCalls = [];
      // This is a simplified merge. In reality, tool_calls stream by index.
      // For MVP, we might just store the final result if possible or rely on the final object.
      // But usually simply appending isn't enough for tool calls.
      // For now, we will just pass through what we have or implement proper merging later if needed.
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
      toolCalls: undefined,
      finishReason: undefined,
      usage: undefined,
    };
  }

  /**
   * Parse a response from the new /responses API
   */
  static parseResponsesResponse(data: any): ParsedResponse {
    let content = '';
    let toolCalls: any[] | undefined = undefined;
    let finishReason = data.status;

    if (data.output && Array.isArray(data.output)) {
      for (const item of data.output) {
        if (item.type === 'message') {
           // Extract text content
           if (item.content) {
            for (const part of item.content) {
              if (part.type === 'output_text') {
                content += part.text;
              }
            }
          }
          // Extract tool calls
          if (item.tool_calls) {
             if (!toolCalls) toolCalls = [];
             toolCalls.push(...item.tool_calls);
          }
        }
        
        // Extract direct function calls
        if (item.type === 'function_call') {
            if (!toolCalls) toolCalls = [];
            toolCalls.push({
                id: item.call_id || item.id,
                type: 'function',
                function: {
                    name: item.name,
                    arguments: item.arguments
                }
            });
        }
      }
    }

    return {
      content: content || undefined,
      toolCalls: toolCalls, 
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
   * Parse a stream chunk from the new /responses API
   * Note: The structure of streaming chunks for /responses is not fully documented publically yet
   * but typically follows a delta pattern. We will attempt to accumulate based on observed patterns
   * or fallback to basic accumulation.
   */
  static parseResponsesStreamChunk(chunk: any, accumulated: ParsedResponse): ParsedResponse {
    // Basic assumption: chunk matches the Response structure but with deltas
    // If exact structure is unknown, we might just look for commonly known fields or wait for docs.
    // For now, let's assume it sends 'output' updates.
    
    // Clone accumulated
    const result: ParsedResponse = { ...accumulated };
    
    if (chunk.id) result.id = chunk.id;
    if (chunk.created_at) result.created = chunk.created_at;
    if (chunk.status) result.finishReason = chunk.status;

    if (chunk.output && Array.isArray(chunk.output)) {
        for (const item of chunk.output) {
             // We need to match items by index or ID to correctly accumulate.
             // For simplicity in this "thin proxy", we will just append strings if we see them
             // This might duplicate if the chunk sends full state, but streaming usually sends deltas.
             // If OpenAI sends FULL state snapshots (unlikely for tokens), we'd need to replace.
             // If it sends deltas, we append.
             
             // Assuming delta for text:
             if (item.content) {
                 for (const part of item.content) {
                     if (part.type === 'output_text' && part.text) {
                         // Check if this is a delta or replace? 
                         // Standard chat chunks are deltas. 
                         // Let's assume delta for text.
                         result.content = (result.content || '') + part.text;
                     }
                 }
             }
             
             // Tool calls accumulation is complex without index matching. 
             // We'll skip complex tool accumulation for streaming in MVP 
             // unless we see 'tool_calls' delta.
        }
    }
    
    // Usage
    if (chunk.usage) {
        result.usage = {
            promptTokens: chunk.usage.input_tokens,
            completionTokens: chunk.usage.output_tokens,
            totalTokens: chunk.usage.total_tokens
        };
    }

    return result;
  }
}
