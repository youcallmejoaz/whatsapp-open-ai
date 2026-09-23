import type { FastifyInstance } from 'fastify';
import { MockAiProvider } from '../src/ai/mock.ts';
import { buildApp } from '../src/app.ts';
import { loadConfig, type Config } from '../src/config.ts';
import type { AppContext } from '../src/context.ts';
import { createDb, type Db } from '../src/db/db.ts';
import { migrate } from '../src/db/migrate.ts';
import { jobHandlers } from '../src/jobs.ts';
import { InlineQueue } from '../src/queue.ts';
import type { Actor } from '../src/services/audit.ts';
import { createUser } from '../src/services/auth.ts';
import { syncTemplates } from '../src/services/templates.ts';
import { signPayload } from '../src/whatsapp/signature.ts';
import { MockWhatsAppClient, type WhatsAppClient } from '../src/whatsapp/client.ts';

export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://wa:wa@localhost:5432/wa_test';

export interface TestEnv {
  ctx: AppContext;
  db: Db;
  queue: InlineQueue;
  cfg: Config;
  app: FastifyInstance;
  admin: Actor;
  close: () => Promise<void>;
}

let migrated = false;

export async function setup(overrides: { wa?: (db: Db) => WhatsAppClient; env?: Record<string, string> } = {}): Promise<TestEnv> {
  const cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL: TEST_DB, WA_PHONE_NUMBER_ID: '111', PUBLIC_URL: 'http://test.local', ...overrides.env });
  const db = createDb(TEST_DB);
  if (!migrated) {
    await migrate(db);
    migrated = true;
  }
  await db.query('TRUNCATE users, contacts, webhook_events, reports, audit_log, mock_outbox, templates RESTART IDENTITY CASCADE');
  const queue = new InlineQueue();
  const ctx: AppContext = {
    cfg,
    db,
    ai: new MockAiProvider(),
    wa: overrides.wa ? overrides.wa(db) : new MockWhatsAppClient(db),
    queue,
    log: { info() {}, warn() {}, error() {}, debug() {} } as unknown as AppContext['log'],
    businessProfile: 'Test restaurant. Open 11:00-23:00.',
  };
  await queue.register(jobHandlers(ctx));
  await syncTemplates(ctx);
  const user = await createUser(db, { email: 'admin@test.local', name: 'Admin', role: 'admin', password: 'password123' });
  const app = await buildApp(ctx, { logger: false });
  await app.ready();
  return {
    ctx,
    db,
    queue,
    cfg,
    app,
    admin: { type: 'user', id: user.id, userId: user.id, role: 'admin' },
    close: async () => {
      await app.close();
      await db.end();
    },
  };
}

/** POST a payload to /webhook the way Meta does (signed raw body). */
export function postWebhook(env: TestEnv, payload: unknown, secret = env.cfg.WA_APP_SECRET) {
  const body = JSON.stringify(payload);
  return env.app.inject({
    method: 'POST',
    url: '/webhook',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signPayload(body, secret) },
    payload: body,
  });
}

export async function login(env: TestEnv): Promise<Record<string, string>> {
  const res = await env.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'admin@test.local', password: 'password123' },
  });
  const cookie = res.cookies.find((c) => c.name === 'wa_session');
  if (!cookie) throw new Error(`login failed: ${res.body}`);
  return { cookie: `wa_session=${cookie.value}`, 'x-requested-with': 'wa-dashboard' };
}

export const META = { phoneNumberId: '111' };
