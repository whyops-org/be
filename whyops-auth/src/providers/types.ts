/**
 * Provider test interface
 * Each provider implementation should export a testProvider function
 */
export interface ProviderTestInput {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface ProviderTestResult {
  success: boolean;
  message: string;
}

/**
 * Base provider test function type
 */
export type ProviderTestFunction = (input: ProviderTestInput) => Promise<ProviderTestResult>;
