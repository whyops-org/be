
const API_KEY = process.argv[2];
const BASE_URL = process.argv[3] || 'https://api.openai.com/v1';
const MODEL = process.argv[4] || 'gpt-3.5-turbo';

if (!API_KEY) {
  console.error('Usage: npm run test:auto-threading -- <API_KEY> [BASE_URL] [MODEL]');
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
  }
];

// --- Shared Identical Script for Users ---
const SCRIPT = [
  "Hello, I am a new user.",
  "What is the weather in Tokyo right now?",
  "Okay, convert 100 USD to JPY (assume rate 150).", // Context: Tokyo
  "Calculate 50 * 3 + 10.",
  "If the previous result was > 100, find news about 'Inflation'.", // Logic + Tool
  "Translate 'The weather is nice' to French.",
  "What is the stock price of AAPL?",
  "Compare AAPL price with MSFT price.", // Multi-tool
  "Calculate the square root of 144.",
  "If 12 * 12 is 144, send an email to boss@corp.com saying 'Math works'.", // Logic + Email
  "What is the weather in Paris?",
  "Translate 'Hello' to Spanish, German, and Italian.", // Multi-call loop potential
  "Search for news about 'SpaceX'.",
  "Calculate 2^10.",
  "What is the weather in New York?",
  "If it is sunny in New York (simulated), calculate 500/2.",
  "What is the stock price of TSLA?",
  "Translate the previous stock symbol to Morse code (simulate translation).",
  "Send an email to me@test.com with the weather in Tokyo from the start.", // Long context recall
  "Goodbye."
];

// --- Helpers (Hoisted) ---
async function post(url: string, body: any, headers: any = {}): Promise<any> {
  const maxRetries = 5;
  let attempt = 0;
  
  while (attempt < maxRetries) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { ...HEADERS, ...headers },
        body: JSON.stringify(body)
      });
      
      if (res.status === 429) {
        attempt++;
        if (attempt >= maxRetries) {
          const text = await res.text();
          throw new Error(`Request failed after ${maxRetries} retries: ${res.status} ${text}`);
        }
        // Exponential backoff: 3s, 6s, 12s, 24s
        const waitTime = Math.min(3000 * Math.pow(2, attempt - 1), 30000);
        console.log(`   ⚠️ Rate limit hit. Waiting ${waitTime/1000}s before retry ${attempt}/${maxRetries}...`);
        await sleep(waitTime);
        continue;
      }

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Request failed: ${res.status} ${text}`);
      }
      return res.json();
    } catch (e: any) {
      if (e.message?.includes('Request failed')) throw e;
      if (attempt >= maxRetries - 1) throw e;
      attempt++;
      await sleep(1000);
    }
  }
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// --- User Simulation Class ---
class SimulatedUser {
  name: string;
  authHeader: any;
  history: any[];
  userId: string;
  providerId: string;
  
  projectId: string;
  environmentId: string;
  
  constructor(name: string, authHeader: any, userId: string, projectId: string, environmentId: string, providerId: string) {
    this.name = name;
    this.authHeader = authHeader;
    this.userId = userId;
    this.projectId = projectId;
    this.environmentId = environmentId;
    this.providerId = providerId;
    this.history = [
      { role: 'system', content: 'You are a helpful assistant.' }
    ];
  }

  async runTurn(prompt: string) {
    // console.log(`\n🔹 [${this.name}] Says: "${prompt}"`); // Reduce log spam
    this.history.push({ role: 'user', content: prompt });

    let response = await post(`${PROXY_URL}/chat/completions`, {
      model: MODEL,
      messages: this.history,
      tools: TOOLS,
      tool_choice: 'auto'
    }, { ...this.authHeader });

    // Handle Tool Calls Loop
    let loopCount = 0;
    while (response.choices[0].message.tool_calls && loopCount < 5) { // Prevent infinite loops
      loopCount++;
      const msg = response.choices[0].message;
      // console.log(`   ⚙️ [${this.name}] Tool Call: ${msg.tool_calls.length}`);
      this.history.push(msg);

      for (const tool of msg.tool_calls) {
        const fn = tool.function.name;
        let args: any = {};
        try {
            args = JSON.parse(tool.function.arguments);
        } catch (e) {
            console.error('Failed to parse tool arguments', tool.function.arguments);
        }

        // Extract injected Trace ID
        const traceId = args._whyops_trace_id;
        
        // Log Tool Execution to Analyse Service (Simulating what a real agent SDK would do)
        if (traceId) {
            // console.log(`   📝 [${this.name}] Logging Tool Call to Trace: ${traceId}`);
            await post(`${ANALYSE_URL}/events`, {
                eventType: 'tool_call',
                traceId: traceId,
                userId: this.userId,
                projectId: this.projectId,
                environmentId: this.environmentId,
                providerId: this.providerId,
                content: {
                    toolName: fn,
                    input: args,
                    output: "Simulated Output" 
                },
                metadata: {
                    executionTimeMs: 50
                }
            }).catch(e => console.error("Failed to log tool event", e));
        }

        let output = "Done";

        if (fn === 'get_weather') output = "Sunny, 25C";
        if (fn === 'calculate') {
            try { 
                const expr = args.expression
                    .replace('sqrt', 'Math.sqrt')
                    .replace('^', '**');
                output = String(eval(expr)); 
            } catch { output = "Error"; }
        }
        if (fn === 'translate_text') output = `[Translated: ${args.text}]`;
        if (fn === 'get_stock_price') output = "150.00";
        if (fn === 'search_news') output = "News found.";
        if (fn === 'send_email') output = "Email sent.";

        this.history.push({
          role: 'tool',
          tool_call_id: tool.id,
          content: output
        });
      }

      response = await post(`${PROXY_URL}/chat/completions`, {
        model: MODEL,
        messages: this.history,
        tools: TOOLS
      }, { ...this.authHeader });
    }

    const answer = response.choices[0].message.content;
    // console.log(`   🤖 [${this.name}] Response: "${answer?.substring(0, 20)}..."`);
    this.history.push({ role: 'assistant', content: answer });
  }
}

// --- Main Logic ---
async function main() {
  console.log('🚀 Starting Massive Auto-Threading Stress Test...');
  console.log('   - 5 Concurrent Users');
  console.log('   - 20 Turns each');
  console.log('   - Identical Prompts (Collision Risk High)');
  console.log('   - No Client-Side Trace IDs');

  // 1. Setup Identity
  const setupEmail = `stress-thread-${Date.now()}@example.com`;
  const user = await post(`${AUTH_URL}/auth/register`, {
    email: setupEmail,
    password: 'password123',
    name: 'Stress Tester'
  });
  
  // Create a project (which auto-creates dev, staging, prod environments)
  const project = await post(`${AUTH_URL}/projects`, {
    name: 'Stress Test Project',
    description: 'Project for auto-threading stress test'
  }, { 'Authorization': `Bearer ${user.token}` });

  // Get the development environment ID
  const devEnv = project.environments.find((env: any) => env.name === 'DEVELOPMENT');
  if (!devEnv) {
    throw new Error('DEVELOPMENT environment not found in project');
  }

  const provider = await post(`${AUTH_URL}/providers`, {
    name: 'Stress Provider',
    type: 'openai',
    baseUrl: BASE_URL,
    apiKey: API_KEY
  }, { 'Authorization': `Bearer ${user.token}` });

  const key = await post(`${AUTH_URL}/api-keys`, {
    projectId: project.project.id,
    environmentId: devEnv.id,
    providerId: provider.id,
    name: 'Stress Key'
  }, { 'Authorization': `Bearer ${user.token}` });

  const PROXY_AUTH = { 'Authorization': `Bearer ${key.apiKey}` };
  const PROJECT_ID = project.project.id;
  const ENVIRONMENT_ID = devEnv.id;
  
  console.log(`✅ Identity Setup: ${setupEmail}`);

  // 2. Initialize 5 Users
  const USERS = [
    new SimulatedUser("User 1", PROXY_AUTH, user.user.id, PROJECT_ID, ENVIRONMENT_ID, provider.id),
    new SimulatedUser("User 2", PROXY_AUTH, user.user.id, PROJECT_ID, ENVIRONMENT_ID, provider.id),
    new SimulatedUser("User 3", PROXY_AUTH, user.user.id, PROJECT_ID, ENVIRONMENT_ID, provider.id),
    new SimulatedUser("User 4", PROXY_AUTH, user.user.id, PROJECT_ID, ENVIRONMENT_ID, provider.id),
    new SimulatedUser("User 5", PROXY_AUTH, user.user.id, PROJECT_ID, ENVIRONMENT_ID, provider.id)
  ];

  console.log('\n🏁 Starting Interleaved Conversations...');

  // 3. Run Interleaved Turns
  // We process turn 1 for ALL users, then turn 2 for ALL users...
  // This maximizes the chance that they all have identical history "User: Hi, Agent: Hi"
  // at the same time, forcing the signature check to be the ONLY differentiator.
  
  for (let i = 0; i < SCRIPT.length; i++) {
    const prompt = SCRIPT[i];
    process.stdout.write(`\nTurn ${i + 1}/${SCRIPT.length}: `);
    
    // Execute all users in parallel for this turn
    const promises = USERS.map(u => u.runTurn(prompt).then(() => process.stdout.write(`[${u.name} OK] `)));
    await Promise.all(promises);
    
    // Delay between turns to respect rate limits
    await sleep(2000);
  }

  // 4. Verification
  console.log('\n\n🔍 Verifying Traces...');
  await sleep(5000); // Wait for analytics flush

  const threadsRes = await fetch(`${ANALYSE_URL}/threads?limit=100&userId=${user.user.id}`);
  const threadsData = await threadsRes.json() as any;
  
  const threadCount = threadsData.threads.length;
  
  console.log(`\n📊 Results:`);
  console.log(`   Expected Threads: ${USERS.length}`);
  console.log(`   Actual Threads:   ${threadCount}`);
  
  if (threadCount === USERS.length) {
    console.log('✅ SUCCESS: Perfect separation of identical concurrent conversations!');
    
    // Check event counts roughly match
    // (They might differ slightly due to tool call retries or LLM variation, but should be close)
    for (const t of threadsData.threads) {
        console.log(`   - Thread ${t.threadId}: ${t.eventCount} events`);
    }
  } else {
    console.error('❌ FAILURE: Thread count mismatch!');
    if (threadCount < USERS.length) console.log("   -> Some conversations merged (Collision)");
    if (threadCount > USERS.length) console.log("   -> Some conversations split (Broken Context)");
  }
}

main().catch(console.error);
