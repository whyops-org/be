import { zValidator } from '@hono/zod-validator';
import { createServiceLogger } from '@whyops/shared/logger';
import { Hono } from 'hono';
import { z } from 'zod';
import { AnalysisService } from '../services/analysis.service';
import { JudgeService, ALL_DIMENSIONS, type JudgeDimension } from '../services/judge.service';

const logger = createServiceLogger('analyse:analyses');
const app = new Hono();

const runAnalysisSchema = z.object({
  traceId: z.string().min(1).max(128),
  mode: z.enum(['quick', 'standard', 'deep']).optional(),
});

const runJudgeSchema = z.object({
  traceId: z.string().min(1).max(128),
  dimensions: z
    .array(z.enum(['step_correctness', 'tool_choice', 'prompt_quality', 'tool_description', 'cost_efficiency']))
    .optional(),
  judgeModel: z.string().max(64).optional(),
  mode: z.enum(['quick', 'standard', 'deep']).optional(),
});

// POST /api/analyses
app.post(
  '/',
  zValidator('json', runAnalysisSchema, (result, c) => {
    if (!result.success) {
      const errors = result.error.errors.map((e) => ({
        field: e.path.join('.'),
        message: e.message,
        code: e.code,
      }));
      return c.json({ error: 'Validation failed', details: errors }, 400);
    }
  }),
  async (c) => {
    const auth = c.get('whyopsAuth');
    if (!auth) {
      return c.json({ error: 'Unauthorized: authentication required' }, 401);
    }

    try {
      const data = c.req.valid('json');
      const result = await AnalysisService.runStaticAnalysis({
        traceId: data.traceId,
        userId: auth.userId,
        mode: data.mode,
      });

      return c.json({
        success: true,
        analysis: result,
      }, 201);
    } catch (error: any) {
      if (error?.message === 'TRACE_NOT_FOUND') {
        return c.json({ success: false, error: 'Trace not found' }, 404);
      }
      logger.error({ error }, 'Failed to run analysis');
      return c.json({ success: false, error: 'Failed to run analysis' }, 500);
    }
  }
);

// POST /api/analyses/judge — LLM Judge v1
app.post(
  '/judge',
  zValidator('json', runJudgeSchema, (result, c) => {
    if (!result.success) {
      const errors = result.error.errors.map((e) => ({
        field: e.path.join('.'),
        message: e.message,
        code: e.code,
      }));
      return c.json({ error: 'Validation failed', details: errors }, 400);
    }
  }),
  async (c) => {
    const auth = c.get('whyopsAuth');
    if (!auth) {
      return c.json({ error: 'Unauthorized: authentication required' }, 401);
    }

    try {
      const data = c.req.valid('json');
      const result = await JudgeService.runLLMJudge({
        traceId: data.traceId,
        userId: auth.userId,
        dimensions: data.dimensions as JudgeDimension[] | undefined,
        judgeModel: data.judgeModel,
        mode: data.mode,
      });

      return c.json(
        {
          success: true,
          analysis: result,
        },
        201
      );
    } catch (error: any) {
      if (error?.message === 'TRACE_NOT_FOUND') {
        return c.json({ success: false, error: 'Trace not found' }, 404);
      }
      if (error?.message === 'JUDGE_NOT_CONFIGURED') {
        return c.json(
          {
            success: false,
            error: 'LLM Judge not configured. Set JUDGE_LLM_API_KEY environment variable.',
          },
          500
        );
      }
      logger.error({ error }, 'Failed to run LLM judge');
      return c.json({ success: false, error: 'Failed to run LLM judge' }, 500);
    }
  }
);

// GET /api/analyses/trace/:traceId
app.get('/trace/:traceId', async (c) => {
  const auth = c.get('whyopsAuth');
  if (!auth) {
    return c.json({ error: 'Unauthorized: authentication required' }, 401);
  }

  try {
    const traceId = c.req.param('traceId');
    const analyses = await AnalysisService.listAnalysesByTrace(traceId, auth.userId);
    if (!analyses) {
      return c.json({ success: false, error: 'Trace not found' }, 404);
    }
    return c.json({ success: true, analyses });
  } catch (error: any) {
    logger.error({ error }, 'Failed to list analyses by trace');
    return c.json({ success: false, error: 'Failed to list analyses' }, 500);
  }
});

// GET /api/analyses/:analysisId
app.get('/:analysisId', async (c) => {
  const auth = c.get('whyopsAuth');
  if (!auth) {
    return c.json({ error: 'Unauthorized: authentication required' }, 401);
  }

  try {
    const analysisId = c.req.param('analysisId');
    const analysis = await AnalysisService.getAnalysisById(analysisId, auth.userId);
    if (!analysis) {
      return c.json({ success: false, error: 'Analysis not found' }, 404);
    }
    return c.json({ success: true, analysis });
  } catch (error: any) {
    logger.error({ error }, 'Failed to fetch analysis');
    return c.json({ success: false, error: 'Failed to fetch analysis' }, 500);
  }
});

export default app;

