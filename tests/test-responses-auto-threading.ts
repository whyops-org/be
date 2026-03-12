
const API_KEY = process.argv[2];
const BASE_URL = process.argv[3] || 'https://api.openai.com/v1';
const MODEL = process.argv[4] || 'gpt-4o'; // Default to gpt-4o as it supports responses api likely

if (!API_KEY) {
  console.error('Usage: npm run test:responses:auto-threading -- <API_KEY> [BASE_URL] [MODEL]');
  process.exit(1);
}

const AUTH_URL = 'http://localhost:8082/api';
const PROXY_URL = 'http://localhost:8080/v1';
const ANALYSE_URL = 'http://localhost:8081/api';

const HEADERS = { 'Content-Type': 'application/json' };

// --- Tools Definition (Same as Chat) ---
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
  // ... other tools can be added if needed, sticking to simple weather for now to reduce complexity if tools fail
];

// --- Shared Identical Script for Users ---
const SCRIPT = [
  "Hello, I am a new user.",
  "What is the weather in Tokyo right now?",
  "Okay, tell me a joke about the weather.",
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
        const waitTime = Math.min(3000 * Math.pow(2, attempt - 1), 30000);
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
    // Initial history in Responses API format
    this.history = []; // System message not always supported in 'input' array directly for responses? 
                       // Docs say input items. Let's start with empty.
                       // Or add system message if supported.
  }

  async runTurn(prompt: string) {
    // Add user message
    this.history.push({ 
        role: 'user', 
        content: [{ type: 'input_text', text: prompt }] 
    });

    // Call /responses
    let response = await post(`${PROXY_URL}/responses`, {
      model: MODEL,
      input: this.history,
      // tools: TOOLS, // Removed tools to avoid validation error from upstream
      // tool_choice: 'auto'
    }, { ...this.authHeader });

    // Handle Response
    // Expect output array
    const outputItems = response.output || [];
    let assistantMessage: any = null;

    for (const item of outputItems) {
        if (item.type === 'message' && item.role === 'assistant') {
            assistantMessage = item;
            break; 
        }
    }

    if (!assistantMessage) {
        console.error(`[${this.name}] No assistant message in output`, response);
        return;
    }

    // Check for tool calls
    // Assuming tool_calls on message item
    if (assistantMessage.tool_calls) {
        // Handle Tool Calls (Simplified for this test - we just acknowledge trace id injection)
        // This test mainly verifies threading via text signature if tools aren't used
        // But if tools are used, we check injection.
        
        // Just print if we see tool calls with trace ID
        // const args = JSON.parse(assistantMessage.tool_calls[0].function.arguments);
        // if (args._whyops_trace_id) console.log(`[${this.name}] Tool call has TraceID!`);

        // We won't loop tools here for brevity unless needed.
        // For auto-threading, we mainly care that the next turn has the history.
    }

    // Extract text content
    let answer = "";
    if (assistantMessage.content) {
        for (const part of assistantMessage.content) {
            if (part.type === 'output_text') {
                answer += part.text;
            }
        }
    }

    // Add assistant response to history
    this.history.push(assistantMessage);
  }
}

// --- Main Logic ---
async function main() {
  console.log('🚀 Starting Auto-Threading Stress Test (Responses API)...');
  console.log('   - 3 Concurrent Users'); // Reduced for this test
  console.log('   - 4 Turns each');
  console.log('   - Identical Prompts');
  console.log('   - No Client-Side Trace IDs');

  // 1. Setup Identity
  const setupEmail = `stress-resp-${Date.now()}@example.com`;
  const user = await post(`${AUTH_URL}/auth/register`, {
    email: setupEmail,
    password: 'password123',
    name: 'Stress Tester'
  });
  
  // Create a project (which auto-creates dev, staging, prod environments)
  const project = await post(`${AUTH_URL}/projects`, {
    name: 'Stress Responses Project',
    description: 'Project for auto-threading stress test with responses API'
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

  // 2. Initialize Users
  const USERS = [
    new SimulatedUser("User 1", PROXY_AUTH, user.user.id, PROJECT_ID, ENVIRONMENT_ID, provider.id),
    new SimulatedUser("User 2", PROXY_AUTH, user.user.id, PROJECT_ID, ENVIRONMENT_ID, provider.id),
    new SimulatedUser("User 3", PROXY_AUTH, user.user.id, PROJECT_ID, ENVIRONMENT_ID, provider.id)
  ];

  console.log('\n🏁 Starting Interleaved Conversations...');
  
  for (let i = 0; i < SCRIPT.length; i++) {
    const prompt = SCRIPT[i];
    process.stdout.write(`\nTurn ${i + 1}/${SCRIPT.length}: `);
    
    const promises = USERS.map(u => u.runTurn(prompt).then(() => process.stdout.write(`[${u.name} OK] `)));
    await Promise.all(promises);
    
    await sleep(2000);
  }

  // 4. Verification
  console.log('\n\n🔍 Verifying Traces...');
  await sleep(5000); 

  const threadsRes = await fetch(`${ANALYSE_URL}/threads?limit=100&userId=${user.user.id}`);
  const threadsData = await threadsRes.json() as any;
  
  const threadCount = threadsData.threads.length;
  
  console.log(`\n📊 Results:`);
  console.log(`   Expected Threads: ${USERS.length}`);
  console.log(`   Actual Threads:   ${threadCount}`);
  
  if (threadCount === USERS.length) {
    console.log('✅ SUCCESS: Perfect separation of identical concurrent conversations!');
  } else {
    console.error('❌ FAILURE: Thread count mismatch!');
  }
}

main().catch(console.error);
