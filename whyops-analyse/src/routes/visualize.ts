import { Hono } from 'hono';
import { LLMEvent } from '@whyops/shared/models';
import { createServiceLogger } from '@whyops/shared/logger';

const logger = createServiceLogger('analyse:visualize');
const app = new Hono();

// Helper to escape Mermaid string
function escapeMermaid(text: any): string {
  if (!text) return '';
  const str = typeof text === 'string' ? text : JSON.stringify(text);
  return str
    .replace(/["\n\r]/g, ' ') // Replace newlines and quotes
    .replace(/;/g, ',')       // Replace semicolons (Mermaid statement end)
    .trim()
    .substring(0, 50) + (str.length > 50 ? '...' : ''); // Truncate
}

// GET /api/visualize/:traceId/mermaid
app.get('/:traceId/mermaid', async (c) => {
  const traceId = c.req.param('traceId');

  try {
    const events = await LLMEvent.findAll({
      where: { traceId },
      order: [['stepId', 'ASC'], ['timestamp', 'ASC']],
    });

    if (events.length === 0) {
      return c.text('graph TD\n    NoEvents[No events found for this trace]');
    }

    let diagram = 'sequenceDiagram\n    participant User\n    participant Agent\n    participant Tool\n\n';
    
    let agentActive = false;

    for (const event of events) {
      const type = event.eventType;
      const content = event.content;

      if (type === 'user_message') {
        // User message
        let msg = '';
        if (Array.isArray(content)) {
          // Find the last actual user message in the array
          for (let i = content.length - 1; i >= 0; i--) {
            const item = content[i];
            if (item.role === 'user') {
              if (typeof item.content === 'string') {
                msg = item.content;
              } else if (Array.isArray(item.content)) {
                // Extract text from structured content
                msg = item.content
                  .filter((part: any) => part.type === 'input_text' || part.type === 'text')
                  .map((part: any) => part.text)
                  .join(' ');
              }
              break;
            }
          }
        } else if (typeof content === 'string') {
          msg = content;
        }
        
        if (msg) {
          diagram += `    User->>Agent: ${escapeMermaid(msg)}\n`;
          if (!agentActive) {
            diagram += `    activate Agent\n`;
            agentActive = true;
          }
        }
      } 
      
      else if (type === 'llm_response') {
        // LLM Response
        if (content.toolCalls && content.toolCalls.length > 0) {
          // Tool Call Request
          if (agentActive) {
            diagram += `    deactivate Agent\n`;
            agentActive = false;
          }
          
          for (const tool of content.toolCalls) {
            const funcName = tool.function?.name || 'unknown_tool';
            let args = tool.function?.arguments || '';
            try {
               const parsedArgs = JSON.parse(args);
               delete parsedArgs._whyops_trace_id; 
               args = JSON.stringify(parsedArgs);
            } catch {}
            
            diagram += `    Agent->>Tool: Call ${funcName}(${escapeMermaid(args)})\n`;
            diagram += `    activate Tool\n`;
          }
        } else if (content.content) {
          // Text Response
          diagram += `    Agent->>User: ${escapeMermaid(content.content)}\n`;
          if (agentActive) {
            diagram += `    deactivate Agent\n`;
            agentActive = false;
          }
        }
      } 
      
      else if (type === 'tool_call') {
        // Tool Execution Result
        const toolName = content.toolName || 'Tool';
        const output = typeof content.output === 'string' ? content.output : JSON.stringify(content.output);
        diagram += `    Tool-->>Agent: Result from ${toolName}: ${escapeMermaid(output)}\n`;
        diagram += `    deactivate Tool\n`;
        
        if (!agentActive) {
          diagram += `    activate Agent\n`;
          agentActive = true;
        }
      } 
      
      else if (type === 'error') {
        diagram += `    Agent--xUser: Error: ${escapeMermaid(content.message || JSON.stringify(content))}\n`;
        if (agentActive) {
          diagram += `    deactivate Agent\n`;
          agentActive = false;
        }
      }
    }

    return c.text(diagram);
  } catch (error: any) {
    logger.error({ error }, 'Failed to generate mermaid chart');
    return c.text('graph TD\n    Error[Failed to generate chart]');
  }
});

export default app;
