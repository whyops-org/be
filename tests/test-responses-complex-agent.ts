import fs from 'fs';

const API_KEY = process.argv[2];
const BASE_URL = process.argv[3] || 'https://api.openai.com/v1';
const MODEL = process.argv[4] || 'gpt-4o';

if (!API_KEY) {
  console.error('Usage: npm run test:responses:complex-agent -- <API_KEY> [BASE_URL] [MODEL]');
  process.exit(1);
}

const AUTH_URL = 'http://localhost:8082/api';
const PROXY_URL = 'http://localhost:8080/v1';
const ANALYSE_URL = 'http://localhost:8081/api';

const HEADERS = { 'Content-Type': 'application/json' };

// --- Tools Definition ---
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get current weather for a location',
      parameters: {
        type: 'object',
        properties: { location: { type: 'string' } },
        required: ['location']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'calculate',
      description: 'Perform a mathematical calculation',
      parameters: {
        type: 'object',
        properties: { expression: { type: 'string' } },
        required: ['expression']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_stock_price',
      description: 'Get stock price for a ticker symbol',
      parameters: {
        type: 'object',
        properties: { ticker: { type: 'string' } },
        required: ['ticker']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_news',
      description: 'Search for recent news articles about a topic',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'send_email',
      description: 'Send an email to a recipient',
      parameters: {
        type: 'object',
        properties: { 
          to: { type: 'string' },
          subject: { type: 'string' },
          body: { type: 'string' }
        },
        required: ['to', 'subject', 'body']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'translate_text',
      description: 'Translate text from one language to another',
      parameters: {
        type: 'object',
        properties: { 
          text: { type: 'string' },
          target_language: { type: 'string' }
        },
        required: ['text', 'target_language']
      }
    }
  }
];

// --- Scenarios ---
const PROMPTS = [
  "What's the weather in Tokyo?",
  "Calculate 55 * 1024.",
  "What is the stock price of AAPL?",
  "Search for news about 'AI Agents' and then email a summary to boss@company.com.", // Multi-tool (Search -> Email)
  "Calculate the square root of 144 plus 10.",
  "Check the weather in Paris and London.", // Parallel tools potentially
  "If I buy 10 shares of MSFT, how much will it cost?", // Stock + Calc
  "Translate 'Hello world' to Spanish and German.", // Multi-call (Translate x2)
  "What is the price of GOOGL vs META?", // Multi-call (Stock x2)
  "Find news about Tesla and check its stock price.", // News + Stock
  "Calculate 2 to the power of 10 and email the result to me@test.com.", // Calc + Email
  "What's the weather in Miami?",
  "Translate the latest news headline about 'SpaceX' to French.", // News -> Translate
  "Divide 1000 by 7.",
  "Send an email to support@help.com saying 'My calculations are wrong' if 5+5 does not equal 10." // Logic + Calc + Email
];

async function post(url: string, body: any, headers: any = {}): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...HEADERS, ...headers },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Request failed: ${res.status} ${text}`);
  }
  return res.json();
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('🚀 Starting Complex Agent Test (Responses API)...');

  // 1. Setup User & Provider
  const user = await post(`${AUTH_URL}/auth/register`, {
    email: `complex-resp-${Date.now()}@example.com`,
    password: 'password123',
    name: 'Complex Agent'
  });
  
  // Create a project (which auto-creates dev, staging, prod environments)
  const project = await post(`${AUTH_URL}/projects`, {
    name: 'Test Responses Project',
    description: 'Project for complex agent testing with responses API'
  }, { 'Authorization': `Bearer ${user.token}` });

  // Get the development environment ID
  const devEnv = project.environments.find((env: any) => env.name === 'DEVELOPMENT');
  if (!devEnv) {
    throw new Error('DEVELOPMENT environment not found in project');
  }

  const provider = await post(`${AUTH_URL}/providers`, {
    name: 'Agent Provider',
    type: 'openai',
    baseUrl: BASE_URL,
    apiKey: API_KEY
  }, { 'Authorization': `Bearer ${user.token}` });

  const key = await post(`${AUTH_URL}/api-keys`, {
    projectId: project.project.id,
    environmentId: devEnv.id,
    providerId: provider.id,
    name: 'Agent Key'
  }, { 'Authorization': `Bearer ${user.token}` });

  const PROXY_AUTH = { 'Authorization': `Bearer ${key.apiKey}` };
  const TRACE_ID = `trace_resp_${Date.now()}`;
  const USER_ID = user.user.id;
  const PROJECT_ID = project.project.id;
  const ENVIRONMENT_ID = devEnv.id;
  const PROVIDER_ID = provider.id;

  console.log(`   ✅ Setup complete. Trace ID: ${TRACE_ID}`);

  // 2. Conversation Loop
  let conversationHistory: any[] = []; // Input items

  for (let i = 0; i < PROMPTS.length; i++) {
    const prompt = PROMPTS[i];
    console.log(`\n--- Turn ${i + 1}: "${prompt}" ---`);
    
    conversationHistory.push({ 
        role: 'user', 
        content: [{ type: 'input_text', text: prompt }] 
    });

    // Send to Proxy
    let currentResponse = await post(`${PROXY_URL}/responses`, {
      model: MODEL,
      input: conversationHistory,
      tools: TOOLS,
      tool_choice: 'auto'
    }, { ...PROXY_AUTH, 'X-Thread-ID': TRACE_ID });

    // Handle potential tool calls
    let loopCount = 0;
    while (loopCount < 5) {
        let toolCalls: any[] = [];
        
        // Find tool calls in output (messages or direct function_call items)
        if (currentResponse.output) {
            for (const item of currentResponse.output) {
                // Scenario A: Message with tool_calls
                if (item.type === 'message' && item.role === 'assistant' && item.tool_calls) {
                    toolCalls.push(...item.tool_calls);
                    conversationHistory.push(item);
                }
                // Scenario B: Direct function_call items
                else if (item.type === 'function_call') {
                    toolCalls.push({
                        id: item.call_id || item.id,
                        type: 'function',
                        function: {
                            name: item.name,
                            arguments: item.arguments
                        }
                    });
                    conversationHistory.push(item); // Push raw item to history for continuity
                }
                // Scenario C: Plain Text
                else if (item.type === 'message' && item.role === 'assistant' && item.content) {
                     // Check if it's just text
                     console.log(`   🤖 Response: ${JSON.stringify(item.content).substring(0, 50)}...`);
                     conversationHistory.push(item);
                }
                // Scenario D: Reasoning (Ignore for logic, keep for history)
                else if (item.type === 'reasoning') {
                    conversationHistory.push(item);
                }
            }
        }

        if (toolCalls.length === 0) break;

        console.log(`   🛠️  LLM called ${toolCalls.length} tool(s): ${toolCalls.map((t: any) => t.function.name).join(', ')}`);
        
        // Execute tools
        for (const toolCall of toolCalls) {
            const fnName = toolCall.function.name;
            let args: any = {};
            try {
                args = JSON.parse(toolCall.function.arguments);
            } catch (e) {
                console.error("Failed to parse args", toolCall.function.arguments);
            }
            
            // CHECK FOR TRACE ID INJECTION
            if (args._whyops_trace_id) {
                console.log(`   ✨ Trace ID Detected in Tool Args: ${args._whyops_trace_id}`);
            } else {
                console.warn(`   ⚠️ Trace ID MISSING in Tool Args!`);
            }

            let output = "";

            if (fnName === 'get_weather') output = `Weather in ${args.location}: 22°C, Sunny`;
            else if (fnName === 'calculate') {
               try { output = String(eval(args.expression)); } catch { output = "Error"; }
            }
            else output = "Unknown tool";

            // Log execution
            await post(`${ANALYSE_URL}/events`, {
              eventType: 'tool_call',
              traceId: TRACE_ID,
              userId: USER_ID,
              projectId: PROJECT_ID,
              environmentId: ENVIRONMENT_ID,
              providerId: PROVIDER_ID,
              content: { toolName: fnName, input: args, output: output },
              metadata: { executionTimeMs: 100 }
            });

            // Add tool output to history
            // For /responses API, use function_call_output type
            conversationHistory.push({
              type: 'function_call_output',
              call_id: toolCall.id,
              output: output
            });

        }

        console.log('   🔄 Sending tool outputs back to LLM...');
        currentResponse = await post(`${PROXY_URL}/responses`, {
            model: MODEL,
            input: conversationHistory,
            tools: TOOLS
        }, { ...PROXY_AUTH, 'X-Thread-ID': TRACE_ID });
        
        loopCount++;
    }
    
    await sleep(500);
  }

  // 3. Verify Trace
  console.log('\n3️⃣  Verifying Trace...');
  await sleep(2000);
  const eventsRes = await fetch(`${ANALYSE_URL}/events?limit=200&traceId=${TRACE_ID}`);
  const eventsData = await eventsRes.json() as any;
  const totalEvents = eventsData.pagination.total;
  
  console.log(`   ✅ Total Events Captured: ${totalEvents}`);
  console.log(`   ✅ Trace saved to 'complex-agent-resp-trace.json'`);
  fs.writeFileSync('complex-agent-resp-trace.json', JSON.stringify(eventsData, null, 2));
}

main().catch(console.error);
