// Load the demo dataset through the real ingestion pipeline (in-process queue).
//   pnpm seed            add demo data
//   pnpm seed --reset    wipe conversations/drafts/reports first (users are kept)
import { loadConfig } from '../src/config.ts';
import { createAi, createWhatsApp, loadBusinessProfile, type AppContext } from '../src/context.ts';
import { createDb } from '../src/db/db.ts';
import { migrate } from '../src/db/migrate.ts';
import { demoPayloads } from '../src/demo/dataset.ts';
import { jobHandlers } from '../src/jobs.ts';
import { InlineQueue } from '../src/queue.ts';
import { SYSTEM } from '../src/services/audit.ts';
import { createApiToken, ensureAdmin } from '../src/services/auth.ts';
import { generateReport } from '../src/services/reports.ts';
import { syncTemplates } from '../src/services/templates.ts';

const cfg = loadConfig();
const db = createDb(cfg.DATABASE_URL);
await migrate(db, console.log);

if (process.argv.includes('--reset')) {
  await db.query(`TRUNCATE contacts, webhook_events, reports, audit_log, mock_outbox RESTART IDENTITY CASCADE`);
  console.log('reset demo data');
}

const queue = new InlineQueue();
const ctx: AppContext = {
  cfg,
  db,
  ai: createAi(cfg),
  wa: createWhatsApp(cfg, db),
  queue,
  log: { info: () => {}, debug: () => {}, warn: console.warn, error: console.error } as unknown as AppContext['log'],
  businessProfile: loadBusinessProfile(cfg),
};
await queue.register(jobHandlers(ctx));
await ensureAdmin(ctx);
console.log(`templates synced: ${await syncTemplates(ctx)}`);

const payloads = demoPayloads({ phoneNumberId: cfg.WA_PHONE_NUMBER_ID });
for (const payload of payloads) {
  const { rows } = await db.query<{ id: number }>('INSERT INTO webhook_events (payload) VALUES ($1) RETURNING id', [JSON.stringify(payload)]);
  await queue.send('webhook.process', { eventId: rows[0]!.id });
}
console.log(`ingested ${payloads.length} webhook payloads with AI provider "${ctx.ai.name}"`);

const report = await generateReport(ctx, { start: new Date(Date.now() - 4 * 24 * 3600_000) });
console.log(`report ${report.id} generated`);

const { rows: admin } = await db.query<{ id: string }>('SELECT id FROM users WHERE role = $1 ORDER BY created_at LIMIT 1', ['admin']);
// Re-running the seed rotates the demo token instead of piling them up.
await db.query(`UPDATE api_tokens SET revoked_at = now() WHERE name = 'demo seed' AND revoked_at IS NULL`);
const token = await createApiToken(db, SYSTEM, { userId: admin[0]!.id, name: 'demo seed', scopes: ['read', 'draft'] });

const counts = await db.query(
  `SELECT (SELECT count(*) FROM conversations) AS conversations, (SELECT count(*) FROM messages) AS messages,
          (SELECT count(*) FROM conversations WHERE needs_reply) AS needs_reply,
          (SELECT count(*) FROM drafts WHERE state = 'pending') AS pending_drafts`,
);
console.log(counts.rows[0]);
console.log(`\nDashboard: ${cfg.PUBLIC_URL}  (login ${cfg.ADMIN_EMAIL})`);
console.log(`MCP URL:   ${cfg.PUBLIC_URL}/mcp   Authorization: Bearer ${token.token}`);
await db.end();
