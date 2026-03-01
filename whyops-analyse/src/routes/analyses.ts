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
      const accept = c.req.header('accept') || '';
      const wantsStream =
        c.req.query('stream') === 'true' || accept.includes('application/x-ndjson');

      if (wantsStream) {
        const encoder = new TextEncoder();

        const stream = new ReadableStream({
          start(controller) {
            let closed = false;
            let sentFailedSnapshot = false;

            const writeChunk = async (chunk: unknown) => {
              if (closed) return;
              try {
                controller.enqueue(encoder.encode(`${JSON.stringify(chunk)}\n`));
              } catch (error: any) {
                closed = true;
                logger.warn(
                  {
                    errorMessage: error?.message || String(error),
                    errorCode: error?.code,
                  },
                  "Judge stream write skipped because stream is closed"
                );
              }
            };

            const close = () => {
              if (closed) return;
              closed = true;
              try {
                controller.close();
              } catch (error: any) {
                logger.warn(
                  {
                    errorMessage: error?.message || String(error),
                    errorCode: error?.code,
                  },
                  "Judge stream close ignored because stream is already closed"
                );
              }
            };

            void (async () => {
              try {
                const result = await JudgeService.runLLMJudge({
                  traceId: data.traceId,
                  userId: auth.userId,
                  dimensions: data.dimensions as JudgeDimension[] | undefined,
                  judgeModel: data.judgeModel,
                  mode: data.mode,
                  onCheckpoint: async (event) => {
                    if (!event.snapshot) return;
                    if (event.snapshot.status === 'failed') sentFailedSnapshot = true;
                    await writeChunk({
                      success: true,
                      analysis: {
                        ...event.snapshot,
                        summary: {
                          ...event.snapshot.summary,
                          checkpoint: {
                            key: event.key,
                            sequence: event.sequence,
                            at: event.at,
                            data: event.data,
                          },
                        },
                      },
                    });
                  },
                });

                await writeChunk({
                  success: true,
                  analysis: result,
                });
              } catch (error: any) {
                if (sentFailedSnapshot) {
                  // A failed analysis snapshot was already streamed.
                } else if (error?.message === 'TRACE_NOT_FOUND') {
                  await writeChunk({ success: false, error: 'Trace not found' });
                } else if (error?.message === 'JUDGE_NOT_CONFIGURED') {
                  await writeChunk({
                    success: false,
                    error: 'LLM Judge not configured. Set JUDGE_LLM_API_KEY environment variable.',
                  });
                } else {
                  logger.error({ error }, 'Failed to run LLM judge (stream)');
                  await writeChunk({ success: false, error: 'Failed to run LLM judge' });
                }
              } finally {
                close();
              }
            })();
          },
        });

        return new Response(stream, {
          status: 200,
          headers: {
            'content-type': 'application/x-ndjson; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
          },
        });
      }

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
