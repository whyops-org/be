/**
 * Provider Test Registry
 * Maps provider types to their test implementations
 * Add new providers here to make them available for testing
 */
import { testProvider as openaiTest } from './openai';
import { testProvider as anthropicTest } from './anthropic';
import type { ProviderTestFunction, ProviderTestInput, ProviderTestResult } from './types';

// Registry of provider test functions
const providerTests: Record<string, ProviderTestFunction> = {
  openai: openaiTest,
  anthropic: anthropicTest,
};

/**
 * Get the test function for a specific provider type
 */
export function getProviderTest(type: string): ProviderTestFunction | undefined {
  return providerTests[type.toLowerCase()];
}

/**
 * Check if a provider type has a test implementation
 */
export function hasProviderTest(type: string): boolean {
  return type.toLowerCase() in providerTests;
}

/**
 * Test a provider connection using the appropriate provider implementation
 */
export async function testProvider(
  type: string,
  input: ProviderTestInput
): Promise<ProviderTestResult> {
  const testFn = getProviderTest(type);

  if (!testFn) {
    return {
      success: false,
      message: `Unknown provider type: ${type}`,
    };
  }

  return testFn(input);
}

// Export types for consumers
export type { ProviderTestInput, ProviderTestResult };
