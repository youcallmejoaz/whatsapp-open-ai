import type { AppContext } from '../context.ts';
import { jobHandlers } from '../jobs.ts';
import { InlineQueue } from '../queue.ts';
import { SYSTEM } from '../services/audit.ts';
import { createApiToken, ensureAdmin } from '../services/auth.ts';
import { generateReport } from '../services/reports.ts';
import { syncTemplates } from '../services/templates.ts';
import { demoPayloads } from './dataset.ts';

export interface SeedResult {
  payloads: number;
  token: string;
  counts: { conversations: number; messages: number; needs_reply: number; pending_drafts: number };
}

/**
 * Load the demo dataset through the real ingestion pipeline. Runs jobs on an
 * in-process queue so everything (triage, drafts, report) is done on return.
 */
export async function seedDemo(base: AppContext, opts: { reset?: boolean } = {}): Promise<SeedResult> {
  const { db } = base;
  if (opts.reset) {
    await db.query(`TRUNCATE contacts, webhook_events, reports, audit_log, mock_outbox RESTART IDENTITY CASCADE`);
  }
  const queue = new InlineQueue();
  const ctx: AppContext = { ...base, queue };
  await queue.register(jobHandlers(ctx));
  await ensureAdmin(ctx);
  await syncTemplates(ctx);

  const payloads = demoPayloads({ phoneNumberId: ctx.cfg.WA_PHONE_NUMBER_ID });
  for (const payload of payloads) {
    const { rows } = await db.query<{ id: number }>('INSERT INTO webhook_events (payload) VALUES ($1) RETURNING id', [
      JSON.stringify(payload),
    ]);
    await queue.send('webhook.process', { eventId: rows[0]!.id });
  }
  await generateReport(ctx, { start: new Date(Date.now() - 4 * 24 * 3600_000) });

  const { rows: admin } = await db.query<{ id: string }>('SELECT id FROM users WHERE role = $1 ORDER BY created_at LIMIT 1', ['admin']);
  // Re-seeding rotates the demo token instead of piling them up.
  await db.query(`UPDATE api_tokens SET revoked_at = now() WHERE name = 'demo seed' AND revoked_at IS NULL`);
  const token = await createApiToken(db, SYSTEM, { userId: admin[0]!.id, name: 'demo seed', scopes: ['read', 'draft'] });

  const counts = await db.query<SeedResult['counts']>(
    `SELECT (SELECT count(*) FROM conversations) AS conversations, (SELECT count(*) FROM messages) AS messages,
            (SELECT count(*) FROM conversations WHERE needs_reply) AS needs_reply,
            (SELECT count(*) FROM drafts WHERE state = 'pending') AS pending_drafts`,
  );
  return { payloads: payloads.length, token: token.token, counts: counts.rows[0]! };
}

/** Seed on boot only for demo deployments with an empty database. */
export async function seedDemoIfEmpty(ctx: AppContext): Promise<SeedResult | null> {
  if (!ctx.cfg.DEMO_SEED_ON_BOOT || ctx.cfg.WA_MODE !== 'mock') return null;
  const { rowCount } = await ctx.db.query('SELECT 1 FROM conversations LIMIT 1');
  if (rowCount) return null;
  return seedDemo(ctx);
}
