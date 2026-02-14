/**
 * Anthropic Provider Test Implementation
 * Tests connection by making an actual messages API request
 */
import type { ProviderTestInput, ProviderTestResult } from './types';

const TIMEOUT_MS = 15000;

/**
 * Test Anthropic provider connection
 * Makes an actual messages API request to verify the API key and model work
 */
export async function testProvider(input: ProviderTestInput): Promise<ProviderTestResult> {
  const { baseUrl, apiKey, model } = input;

  try {
    // Anthropic uses the messages API endpoint
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: model,
        max_tokens: 10,
        messages: [
          {
            role: 'user',
            content: 'Respond with exactly "OK" if you can read this message.',
          }
        ],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = `Anthropic API error: ${response.status}`;

      try {
        const errorJson = JSON.parse(errorText);
        errorMessage = errorJson.error?.message || errorJson.message || errorMessage;
      } catch {
        // Use status text if not JSON
        errorMessage = `${response.statusText}`;
      }

      return {
        success: false,
        message: errorMessage,
      };
    }

    const jsonData = await response.json();
    const data = jsonData as { content?: Array<{ text?: string }> };

    // Verify we got a valid response with content
    if (!data.content || !data.content[0]?.text) {
      return {
        success: false,
        message: 'Invalid response format from Anthropic',
      };
    }

    return {
      success: true,
      message: `Successfully connected to Anthropic using model "${model}"`,
    };
  } catch (error: unknown) {
    // Handle specific error types
    const err = error as { name?: string; code?: string; message?: string; cause?: { code?: string } };

    if (err.name === 'TimeoutError' || err.code === 'ETIMEDOUT') {
      return {
        success: false,
        message: 'Connection timeout - check base URL',
      };
    }

    if (err.cause?.code === 'ENOTFOUND') {
      return {
        success: false,
        message: 'Invalid base URL - host not found',
      };
    }

    if (err.cause?.code === 'ECONNREFUSED') {
      return {
        success: false,
        message: 'Connection refused - check base URL',
      };
    }

    return {
      success: false,
      message: err.message || 'Failed to connect to Anthropic',
    };
  }
}
