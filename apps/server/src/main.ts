import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createAi, createWhatsApp, loadBusinessProfile, type AppContext } from './context.ts';
import { createDb } from './db/db.ts';
import { migrate } from './db/migrate.ts';
import { jobHandlers } from './jobs.ts';
import { PgBossQueue } from './queue.ts';
import { ensureAdmin } from './services/auth.ts';

const cfg = loadConfig();
const db = createDb(cfg.DATABASE_URL);
await migrate(db, (m) => console.log(`[migrate] ${m}`));

let app: Awaited<ReturnType<typeof buildApp>> | undefined;
const queue = new PgBossQueue(cfg.DATABASE_URL, (err) => app?.log.error({ err }, 'job failed'));
const ctx: AppContext = {
  cfg,
  db,
  ai: createAi(cfg),
  wa: createWhatsApp(cfg, db),
  queue,
  log: console as unknown as AppContext['log'],
  businessProfile: loadBusinessProfile(cfg),
};

app = await buildApp(ctx);
ctx.log = app.log;
await ensureAdmin(ctx);
await queue.register(jobHandlers(ctx));
await queue.schedule('report.generate', cfg.REPORT_CRON, cfg.REPORT_TZ);
await queue.schedule('templates.sync', '0 */6 * * *', 'UTC');
await queue.schedule('retention.cleanup', '30 3 * * *', 'UTC');
await queue.send('templates.sync', {});

await app.listen({ port: cfg.PORT, host: cfg.HOST });
app.log.info({ waMode: cfg.WA_MODE, ai: ctx.ai.name, url: cfg.PUBLIC_URL }, 'ready');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    app?.log.info(`${signal} received, shutting down`);
    await app?.close();
    await queue.stop();
    await db.end();
    process.exit(0);
  });
}
