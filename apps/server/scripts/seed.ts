// Load the demo dataset through the real ingestion pipeline (in-process queue).
//   pnpm seed            add demo data
//   pnpm seed --reset    wipe conversations/drafts/reports first (users are kept)
import { loadConfig } from '../src/config.ts';
import { createAi, createWhatsApp, loadBusinessProfile, type AppContext } from '../src/context.ts';
import { createDb } from '../src/db/db.ts';
import { migrate } from '../src/db/migrate.ts';
import { seedDemo } from '../src/demo/seed.ts';
import { InlineQueue } from '../src/queue.ts';

const cfg = loadConfig();
const db = createDb(cfg.DATABASE_URL);
await migrate(db, console.log);

const ctx: AppContext = {
  cfg,
  db,
  ai: createAi(cfg),
  wa: createWhatsApp(cfg, db),
  queue: new InlineQueue(),
  log: { info: () => {}, debug: () => {}, warn: console.warn, error: console.error } as unknown as AppContext['log'],
  businessProfile: loadBusinessProfile(cfg),
};

const reset = process.argv.includes('--reset');
const result = await seedDemo(ctx, { reset });
if (reset) console.log('reset demo data');
console.log(`ingested ${result.payloads} webhook payloads with AI provider "${ctx.ai.name}"`);
console.log(result.counts);
console.log(`\nDashboard: ${cfg.PUBLIC_URL}  (login ${cfg.ADMIN_EMAIL})`);
console.log(`MCP URL:   ${cfg.PUBLIC_URL}/mcp   Authorization: Bearer ${result.token}`);
await db.end();
