import { Hono } from 'hono';
import { ThreadController } from '../controllers';

const app = new Hono();

// POST /api/threads/match - Match request history to an existing thread
app.post('/match', ThreadController.matchThread);

// GET /api/threads - List all threads with duration
app.get('/', ThreadController.listThreads);

// GET /api/threads/:threadId - Get complete thread details
app.get('/:threadId', ThreadController.getThreadDetail);

// GET /api/threads/:threadId/graph - Get decision graph for thread
app.get('/:threadId/graph', ThreadController.getThreadGraph);

export default app;
