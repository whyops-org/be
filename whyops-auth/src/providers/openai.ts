/**
 * OpenAI Provider Test Implementation
 * Tests connection by making an actual chat completion request
 */
import type { ProviderTestInput, ProviderTestResult } from './types';

const TIMEOUT_MS = 15000;

/**
 * Test OpenAI provider connection
 * Makes an actual chat completion request to verify the API key and model work
 */
export async function testProvider(input: ProviderTestInput): Promise<ProviderTestResult> {
  const { baseUrl, apiKey, model } = input;

  try {
    // Use the chat completions endpoint with the provided model
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: model,
        messages: [
          {
            role: 'user',
            content: 'Respond with exactly "OK" if you can read this message.',
          }
        ],
        max_tokens: 10,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = `OpenAI API error: ${response.status}`;

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
    const data = jsonData as { choices?: Array<{ message?: { content?: string } }> };

    // Verify we got a valid response with content
    if (!data.choices || !data.choices[0]?.message?.content) {
      return {
        success: false,
        message: 'Invalid response format from OpenAI',
      };
    }

    return {
      success: true,
      message: `Successfully connected to OpenAI using model "${model}"`,
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
      message: err.message || 'Failed to connect to OpenAI',
    };
  }
}
