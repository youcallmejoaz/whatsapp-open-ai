import { existsSync } from 'node:fs';
import path from 'node:path';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { apiRoutes } from './api/routes.ts';
import type { AppContext } from './context.ts';
import { AppError } from './errors.ts';
import { mcpRoutes } from './mcp/server.ts';
import { webhookRoutes } from './whatsapp/routes.ts';

export async function buildApp(ctx: AppContext, opts: { logger?: boolean | object } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? {
      level: ctx.cfg.LOG_LEVEL,
      // Keep phone numbers, message bodies and credentials out of logs.
      redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-hub-signature-256"]'],
    },
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });

  await app.register(cookie, { secret: ctx.cfg.COOKIE_SECRET });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: err.code, message: err.message });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: 'BAD_REQUEST', message: (err as Error).message });
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'INTERNAL', message: 'Internal server error' });
  });

  app.get('/healthz', async () => {
    await ctx.db.query('SELECT 1');
    return { ok: true, waMode: ctx.cfg.WA_MODE, ai: ctx.ai.name };
  });

  await app.register(async (scope) => webhookRoutes(scope, ctx));
  await app.register(async (scope) => mcpRoutes(scope, ctx));
  await app.register(async (scope) => apiRoutes(scope, ctx), { prefix: '/api' });

  // Serve the built dashboard from the same origin (keeps cookies first-party).
  const webDist = ctx.cfg.WEB_DIST || path.resolve(import.meta.dirname, '../../web/dist');
  if (existsSync(path.join(webDist, 'index.html'))) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api') ? reply.code(404).send({ error: 'NOT_FOUND' }) : reply.sendFile('index.html'),
    );
  }
  return app;
}
