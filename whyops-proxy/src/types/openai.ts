export type OpenAIRole = 'system' | 'developer' | 'user' | 'assistant' | 'tool';

export interface OpenAIImageUrlPart {
  type: 'image_url';
  image_url: {
    url: string;
    detail?: 'auto' | 'low' | 'high';
  };
}

export interface OpenAITextPart {
  type: 'text';
  text: string;
}

export type OpenAIChatContentPart = OpenAITextPart | OpenAIImageUrlPart;

export interface OpenAIChatMessageBase {
  role: OpenAIRole;
  content: string | OpenAIChatContentPart[];
  name?: string;
}

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
  index?: number;
}

export interface OpenAIChatAssistantMessage extends OpenAIChatMessageBase {
  role: 'assistant';
  tool_calls?: OpenAIToolCall[] | null;
  refusal?: string | null;
}

export interface OpenAIChatToolMessage extends OpenAIChatMessageBase {
  role: 'tool';
  tool_call_id?: string;
}

export type OpenAIChatMessage = OpenAIChatMessageBase | OpenAIChatAssistantMessage | OpenAIChatToolMessage;

export interface OpenAIChatCompletionRequest {
  model: string;
  messages: OpenAIChatMessage[];
  temperature?: number;
  top_p?: number;
  n?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  max_completion_tokens?: number;
  stop?: string | string[] | null;
  stream?: boolean;
  stream_options?: {
    include_usage?: boolean;
  } | null;
  modalities?: Array<'text' | 'audio'>;
  audio?: {
    voice: string;
    format: 'mp3' | 'wav' | 'flac' | 'opus';
  } | null;
  response_format?: {
    type: 'text' | 'json_object' | 'json_schema';
    json_schema?: {
      name: string;
      description?: string;
      strict?: boolean;
      schema: Record<string, any>;
    };
  };
  tools?: Array<{
    type: 'function';
    function: {
      name: string;
      description?: string;
      strict?: boolean;
      parameters?: Record<string, any>;
    };
  }>;
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
  parallel_tool_calls?: boolean;
  reasoning_effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  seed?: number | null;
  prediction?: { type: 'content'; content: string | OpenAIChatContentPart[] } | null;
  logprobs?: boolean;
  top_logprobs?: number | null;
  logit_bias?: Record<string, number> | null;
  verbosity?: 'low' | 'medium' | 'high';
  store?: boolean;
  metadata?: Record<string, any>;
  prompt_cache_key?: string;
  prompt_cache_retention?: '24h';
  service_tier?: 'auto' | 'default' | 'flex' | 'priority';
  web_search_options?: Record<string, any>;
  safety_identifier?: string;
  [key: string]: any;
}

export interface OpenAIChatCompletionChoice {
  index: number;
  message: OpenAIChatAssistantMessage;
  logprobs?: any;
  finish_reason?: string | null;
}

export interface OpenAIChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  service_tier?: string;
  system_fingerprint?: string;
  choices: OpenAIChatCompletionChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: Record<string, any>;
    completion_tokens_details?: Record<string, any>;
  };
  [key: string]: any;
}

export interface OpenAIChatCompletionChunkChoice {
  index: number;
  delta: {
    role?: 'assistant';
    content?: string | null;
    tool_calls?: Array<{
      index?: number;
      id?: string;
      type?: 'function';
      function?: {
        name?: string;
        arguments?: string;
      };
    }> | null;
    refusal?: string | null;
  };
  logprobs?: any;
  finish_reason?: string | null;
}

export interface OpenAIChatCompletionChunk {
  id?: string;
  object: 'chat.completion.chunk';
  created?: number;
  model?: string;
  service_tier?: string;
  system_fingerprint?: string;
  choices?: OpenAIChatCompletionChunkChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: Record<string, any>;
    completion_tokens_details?: Record<string, any>;
  };
  [key: string]: any;
}

// /responses types
export type OpenAIResponsesInputContentPart =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url?: string; file_id?: string; detail?: 'auto' | 'low' | 'high' }
  | { type: 'input_file'; file_id: string };

export interface OpenAIResponsesInputMessage {
  role: OpenAIRole;
  content: string | OpenAIResponsesInputContentPart[];
}

export interface OpenAIResponsesRequest {
  model: string;
  input: string | OpenAIResponsesInputMessage[];
  instructions?: string | null;
  previous_response_id?: string | null;
  temperature?: number | null;
  top_p?: number | null;
  max_output_tokens?: number | null;
  max_tool_calls?: number | null;
  stream?: boolean | null;
  truncation?: 'auto' | 'disabled' | null;
  text?: {
    format?: {
      type: 'text' | 'json_object' | 'json_schema';
      name?: string;
      description?: string;
      strict?: boolean;
      schema?: Record<string, any>;
    };
  };
  tools?: Array<Record<string, any>>;
  tool_choice?: any;
  parallel_tool_calls?: boolean | null;
  reasoning?: { effort?: 'low' | 'medium' | 'high' | null; summary?: 'auto' | 'concise' | 'detailed' | null } | null;
  include?: string[] | null;
  top_logprobs?: number | null;
  background?: boolean | null;
  prompt?: { id: string; version?: string; variables?: Record<string, any> } | null;
  store?: boolean | null;
  metadata?: Record<string, any>;
  user?: string | null;
  service_tier?: 'auto' | 'default' | 'flex' | 'priority' | null;
  [key: string]: any;
}

export type OpenAIResponsesOutputItem =
  | { type: 'message'; id: string; status: string; role: 'assistant'; content: Array<{ type: 'output_text'; text: string; annotations?: any[]; logprobs?: any } | { type: 'refusal'; refusal: string } | { type: 'output_audio'; id: string; data?: string; transcript?: string }> }
  | { type: 'reasoning'; id: string; status: string; summary?: Array<{ type: 'summary_text'; text: string }>; encrypted_content?: string }
  | { type: 'function_call'; id: string; call_id: string; status?: string; name: string; arguments: string }
  | { type: 'function_call_output'; id: string; call_id: string; status?: string; output: string }
  | { type: 'web_search_call'; id: string; status?: string; action?: { type: string; query?: string } }
  | { type: 'file_search_call'; id: string; status?: string; queries?: string[]; results?: any[] | null }
  | { type: 'code_interpreter_call'; id: string; status?: string; code?: string; outputs?: any[] }
  | { type: 'computer_call'; id: string; status?: string; action?: Record<string, any> };

export interface OpenAIResponsesResponse {
  id: string;
  object: 'response';
  created_at: number;
  status: string;
  error?: { code: string; message: string } | null;
  incomplete_details?: { reason: string } | null;
  instructions?: string | null;
  model?: string;
  max_output_tokens?: number | null;
  max_tool_calls?: number | null;
  previous_response_id?: string | null;
  parallel_tool_calls?: boolean;
  store?: boolean;
  truncation?: string;
  temperature?: number | null;
  top_p?: number | null;
  service_tier?: string;
  background?: boolean;
  metadata?: Record<string, any>;
  user?: string | null;
  prompt?: Record<string, any> | null;
  reasoning?: Record<string, any> | null;
  text?: Record<string, any> | null;
  tool_choice?: any;
  tools?: any[];
  output?: OpenAIResponsesOutputItem[];
  output_text?: string | null;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    input_tokens_details?: Record<string, any>;
    output_tokens_details?: Record<string, any>;
  };
  [key: string]: any;
}

export type OpenAIResponsesStreamEvent =
  | { type: 'response.created'; sequence_number: number; response: OpenAIResponsesResponse }
  | { type: 'response.in_progress'; sequence_number: number; response: OpenAIResponsesResponse }
  | { type: 'response.output_item.added'; sequence_number: number; output_index: number; item: OpenAIResponsesOutputItem }
  | { type: 'response.output_item.done'; sequence_number: number; output_index: number; item: OpenAIResponsesOutputItem }
  | { type: 'response.content_part.added'; sequence_number: number; output_index: number; content_index: number; item_id: string; part: any }
  | { type: 'response.content_part.done'; sequence_number: number; output_index: number; content_index: number; item_id: string; part: any }
  | { type: 'response.output_text.delta'; sequence_number: number; output_index: number; content_index: number; item_id: string; delta: string }
  | { type: 'response.output_text.done'; sequence_number: number; output_index: number; content_index: number; item_id: string; text: string }
  | { type: 'response.function_call_arguments.delta'; sequence_number: number; output_index: number; item_id: string; delta: string }
  | { type: 'response.function_call_arguments.done'; sequence_number: number; output_index: number; item_id: string; arguments: string }
  | { type: 'response.refusal.delta'; sequence_number: number; output_index?: number; item_id?: string; delta: string }
  | { type: 'response.refusal.done'; sequence_number: number; output_index?: number; item_id?: string; refusal: string }
  | { type: 'response.completed'; sequence_number: number; response: OpenAIResponsesResponse }
  | { type: 'response.failed'; sequence_number?: number; response: OpenAIResponsesResponse }
  | { type: 'response.incomplete'; sequence_number?: number; response: OpenAIResponsesResponse };
