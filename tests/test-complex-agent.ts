import fs from 'fs';

const API_KEY = process.argv[2];
const BASE_URL = process.argv[3] || 'https://api.openai.com/v1';
const MODEL = process.argv[4] || 'gpt-3.5-turbo';

if (!API_KEY) {
  console.error('Usage: npm run test:complex-agent -- <API_KEY> [BASE_URL] [MODEL]');
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

// --- Helpers ---
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

// --- Main Logic ---
async function main() {
  console.log('🚀 Starting Complex Agent Test...');

  // 1. Setup User & Provider
  console.log('\n1️⃣  Setting up Identity...');
  const user = await post(`${AUTH_URL}/auth/register`, {
    email: `complex-agent-${Date.now()}@example.com`,
    password: 'password123',
    name: 'Complex Agent'
  });
  
  // Create a project (which auto-creates dev, staging, prod environments)
  const project = await post(`${AUTH_URL}/projects`, {
    name: 'Test Project',
    description: 'Project for complex agent testing'
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
  const TRACE_ID = `trace_complex_${Date.now()}`;
  const USER_ID = user.user.id;
  const PROJECT_ID = project.project.id;
  const ENVIRONMENT_ID = devEnv.id;
  const PROVIDER_ID = provider.id;

  console.log(`   ✅ Setup complete. Trace ID: ${TRACE_ID}`);

  // 2. Conversation Loop
  let conversationHistory: any[] = [
    { role: 'system', content: 'You are a helpful assistant with access to tools. Use them whenever needed.' }
  ];

  console.log(`\n2️⃣  Running ${PROMPTS.length} Turns...`);

  for (let i = 0; i < PROMPTS.length; i++) {
    const prompt = PROMPTS[i];
    console.log(`\n--- Turn ${i + 1}: "${prompt}" ---`);
    
    // Add user message
    conversationHistory.push({ role: 'user', content: prompt });

    // Send to Proxy
    let currentResponse = await post(`${PROXY_URL}/chat/completions`, {
      model: MODEL,
      messages: conversationHistory,
      tools: TOOLS,
      tool_choice: 'auto' // Let LLM decide
    }, { ...PROXY_AUTH, 'X-Thread-ID': TRACE_ID });

    // Handle potentially multiple tool calls in a loop
    while (currentResponse.choices[0].message.tool_calls) {
      const message = currentResponse.choices[0].message;
      const toolCalls = message.tool_calls;
      
      console.log(`   🛠️  LLM called ${toolCalls.length} tool(s): ${toolCalls.map((t: any) => t.function.name).join(', ')}`);
      
      // Add assistant message with tool calls to history
      conversationHistory.push(message);

      // Execute tools and collect outputs
      for (const toolCall of toolCalls) {
        const fnName = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments);
        let output = "";

        // Simulate execution
        if (fnName === 'get_weather') output = `Weather in ${args.location}: 22°C, Sunny`;
        else if (fnName === 'calculate') {
           try { output = String(eval(args.expression)); } catch { output = "Error"; }
        }
        else if (fnName === 'get_stock_price') output = `${args.ticker}: $150.00`;
        else if (fnName === 'search_news') output = `Found 2 articles about ${args.query}: 1. "Breakthrough in AI" 2. "Market Rally"`;
        else if (fnName === 'send_email') output = `Email sent to ${args.to} with subject "${args.subject}"`;
        else if (fnName === 'translate_text') output = `Translated to ${args.target_language}: [Translated: ${args.text}]`;
        else output = "Unknown tool";

        // Log execution to Analyse (Manual Step)
        await post(`${ANALYSE_URL}/events`, {
          eventType: 'tool_call',
          traceId: TRACE_ID,
          userId: USER_ID,
          projectId: PROJECT_ID,
          environmentId: ENVIRONMENT_ID,
          providerId: PROVIDER_ID,
          content: { toolName: fnName, input: args, output: output },
          metadata: { executionTimeMs: Math.floor(Math.random() * 500) }
        });

        // Add tool response to history
        conversationHistory.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: output
        });
      }

      // Send tool outputs back to LLM (Proxy)
      console.log('   🔄 Sending tool outputs back to LLM...');
      currentResponse = await post(`${PROXY_URL}/chat/completions`, {
        model: MODEL,
        messages: conversationHistory,
        tools: TOOLS
      }, { ...PROXY_AUTH, 'X-Thread-ID': TRACE_ID });
    }

    // Final text response
    const finalContent = currentResponse.choices[0].message.content;
    console.log(`   🤖 Response: ${finalContent?.substring(0, 50)}...`);
    conversationHistory.push({ role: 'assistant', content: finalContent });
    
    // Small delay to ensure timestamp ordering
    await sleep(500);
  }

  // 3. Verify Trace
  console.log('\n3️⃣  Verifying Trace...');
  await sleep(2000);
  const eventsRes = await fetch(`${ANALYSE_URL}/events?limit=200&traceId=${TRACE_ID}`);
  const eventsData = await eventsRes.json() as any;
  const totalEvents = eventsData.pagination.total;
  
  console.log(`   ✅ Total Events Captured: ${totalEvents}`);
  console.log(`   ✅ Trace saved to 'complex-agent-trace.json'`);
  fs.writeFileSync('complex-agent-trace.json', JSON.stringify(eventsData, null, 2));
}

main().catch(console.error);
