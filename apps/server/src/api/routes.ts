import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { AppError } from '../errors.ts';
import type { Actor } from '../services/audit.ts';
import {
  createApiToken,
  listApiTokens,
  login,
  logout,
  revokeApiToken,
  userForSession,
  type SessionUser,
} from '../services/auth.ts';
import { getConversation, listConversations, summarizeConversation } from '../services/conversations.ts';
import { approveAndSend, createDraft, editDraft, generateDraft, listDrafts, rejectDraft, retryDraft } from '../services/drafts.ts';
import { generateReport, getReport, listReports } from '../services/reports.ts';
import { searchMessages } from '../services/search.ts';
import { listTemplates, syncTemplates } from '../services/templates.ts';

export const SESSION_COOKIE = 'wa_session';

declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionUser;
  }
}

const actorOf = (req: FastifyRequest): Actor => ({
  type: 'user',
  id: req.user!.id,
  userId: req.user!.id,
  role: req.user!.role,
  ip: req.ip,
});

function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) throw new AppError(400, 'VALIDATION', r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return r.data;
}

const Id = z.object({ id: z.uuid() });

export async function apiRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  // ---------------------------------------------------------------- auth
  app.post('/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = parse(z.object({ email: z.string(), password: z.string() }), req.body);
    const { token, user } = await login(ctx, body.email, body.password, req.ip);
    reply.setCookie(SESSION_COOKIE, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: ctx.cfg.PUBLIC_URL.startsWith('https://'),
      maxAge: ctx.cfg.SESSION_TTL_HOURS * 3600,
    });
    return { user };
  });

  // Everything below requires a session.
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.routeOptions.url === '/api/auth/login') return;
    const token = req.cookies[SESSION_COOKIE];
    const user = token ? await userForSession(ctx.db, token) : null;
    if (!user) return reply.code(401).send({ error: 'UNAUTHENTICATED', message: 'Sign in required' });
    // CSRF: state-changing requests must carry a custom header, which a
    // cross-site form cannot set and cross-origin fetch cannot send without CORS.
    if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'wa-dashboard') {
      return reply.code(403).send({ error: 'CSRF', message: 'Missing X-Requested-With header' });
    }
    req.user = user;
  });

  const adminOnly = async (req: FastifyRequest) => {
    if (req.user?.role !== 'admin') throw new AppError(403, 'FORBIDDEN', 'Admin only');
  };

  app.post('/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await logout(ctx.db, token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/auth/me', async (req) => ({ user: req.user, config: { waMode: ctx.cfg.WA_MODE, ai: ctx.ai.name, reportLanguage: ctx.cfg.REPORT_LANGUAGE } }));

  // ---------------------------------------------------------------- conversations
  app.get('/conversations', async (req) => {
    const q = parse(
      z.object({
        filter: z.enum(['all', 'needs_reply', 'urgent']).default('all'),
        limit: z.coerce.number().int().positive().max(200).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      }),
      req.query,
    );
    return listConversations(ctx, q);
  });

  app.get('/conversations/:id', async (req) => {
    const { id } = parse(Id, req.params);
    return getConversation(ctx, id, { markRead: true });
  });

  app.post('/conversations/:id/summary', async (req) => {
    const { id } = parse(Id, req.params);
    const body = parse(z.object({ force: z.boolean().optional(), language: z.enum(['en', 'ar']).optional() }), req.body ?? {});
    return summarizeConversation(ctx, id, body);
  });

  app.post('/conversations/:id/drafts', async (req) => {
    const { id } = parse(Id, req.params);
    const body = parse(
      z.union([
        z.object({ generate: z.literal(true), instructions: z.string().max(1000).optional() }),
        z.object({ body: z.string().min(1) }),
        z.object({
          template: z.object({ name: z.string(), language: z.string(), params: z.array(z.string()).default([]) }),
        }),
      ]),
      req.body,
    );
    const actor = actorOf(req);
    if ('generate' in body) return generateDraft(ctx, actor, id, { instructions: body.instructions, source: 'ai' });
    if ('body' in body) return createDraft(ctx, actor, { conversationId: id, source: 'user', body: body.body });
    return createDraft(ctx, actor, { conversationId: id, source: 'user', template: body.template });
  });

  // ---------------------------------------------------------------- drafts / approvals
  app.get('/drafts', async (req) => {
    const q = parse(z.object({ state: z.enum(['pending', 'approved', 'sent', 'rejected', 'failed']).optional() }), req.query);
    return { items: await listDrafts(ctx, { state: q.state ?? 'pending' }) };
  });

  app.patch('/drafts/:id', async (req) => {
    const { id } = parse(Id, req.params);
    const { body } = parse(z.object({ body: z.string() }), req.body);
    return editDraft(ctx, actorOf(req), id, body);
  });

  app.post('/drafts/:id/approve', async (req) => {
    const { id } = parse(Id, req.params);
    return approveAndSend(ctx, actorOf(req), id);
  });

  app.post('/drafts/:id/reject', async (req) => {
    const { id } = parse(Id, req.params);
    const { reason } = parse(z.object({ reason: z.string().max(500).optional() }), req.body ?? {});
    return rejectDraft(ctx, actorOf(req), id, reason);
  });

  app.post('/drafts/:id/retry', async (req) => {
    const { id } = parse(Id, req.params);
    return retryDraft(ctx, actorOf(req), id);
  });

  // ---------------------------------------------------------------- search
  app.get('/search', async (req) => {
    const q = parse(
      z.object({
        q: z.string().min(1).max(500),
        conversationId: z.uuid().optional(),
        since: z.coerce.date().optional(),
        until: z.coerce.date().optional(),
        direction: z.enum(['in', 'out']).optional(),
        limit: z.coerce.number().int().positive().max(100).default(25),
      }),
      req.query,
    );
    return { items: await searchMessages(ctx, { ...q, query: q.q }) };
  });

  // ---------------------------------------------------------------- templates
  app.get('/templates', async () => ({ items: await listTemplates(ctx) }));
  app.post('/templates/sync', { preHandler: adminOnly }, async () => ({ synced: await syncTemplates(ctx) }));

  // ---------------------------------------------------------------- reports
  app.get('/reports', async () => ({ items: await listReports(ctx) }));
  app.get('/reports/:id', async (req) => getReport(ctx, parse(Id, req.params).id));
  app.post('/reports', async (req) => {
    const body = parse(
      z.object({
        since: z.coerce.date().optional(),
        until: z.coerce.date().optional(),
        language: z.enum(['en', 'ar']).optional(),
      }),
      req.body ?? {},
    );
    return generateReport(ctx, { start: body.since, end: body.until, language: body.language });
  });

  // ---------------------------------------------------------------- API tokens (MCP)
  app.get('/tokens', async (req) => ({ items: await listApiTokens(ctx.db, req.user!.id) }));
  app.post('/tokens', async (req) => {
    if (req.user!.role === 'viewer') throw new AppError(403, 'FORBIDDEN', 'Viewers cannot create tokens');
    const body = parse(
      z.object({ name: z.string().min(1).max(100), scopes: z.array(z.enum(['read', 'draft'])).default(['read', 'draft']) }),
      req.body,
    );
    const created = await createApiToken(ctx.db, actorOf(req), { userId: req.user!.id, ...body });
    return { ...created, mcpUrl: `${ctx.cfg.PUBLIC_URL}/mcp` };
  });
  app.delete('/tokens/:id', async (req) => {
    await revokeApiToken(ctx.db, actorOf(req), parse(Id, req.params).id);
    return { ok: true };
  });

  // ---------------------------------------------------------------- audit
  app.get('/audit', { preHandler: adminOnly }, async () => {
    const { rows } = await ctx.db.query(
      `SELECT a.id, a.at, a.actor_type AS "actorType", coalesce(u.email, a.actor_id) AS actor, a.action,
              a.target_type AS "targetType", a.target_id AS "targetId", a.details
       FROM audit_log a
       LEFT JOIN users u ON a.actor_type = 'user' AND u.id::text = a.actor_id
       ORDER BY a.at DESC LIMIT 200`,
    );
    return { items: rows };
  });
}
