import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inboundPayload } from '../src/demo/payloads.ts';
import type { Actor } from '../src/services/audit.ts';
import { approveAndSend, createDraft, rejectDraft, retryDraft } from '../src/services/drafts.ts';
import { upsertConversation } from '../src/services/ingest.ts';
import { MockWhatsAppClient, WhatsAppApiError } from '../src/whatsapp/client.ts';
import { META, postWebhook, setup, type TestEnv } from './helpers.ts';

let env: TestEnv;
let failNext: WhatsAppApiError | null = null;

beforeEach(async () => {
  failNext = null;
  env = await setup({
    wa: (db) => {
      const client = new MockWhatsAppClient(db);
      const sendText = client.sendText.bind(client);
      client.sendText = async (...args) => {
        if (failNext) {
          const e = failNext;
          failNext = null;
          throw e;
        }
        return sendText(...args);
      };
      return client;
    },
    env: { AUTO_DRAFT: 'false' },
  });
});
afterEach(async () => env.close());

const sara = { waId: '447700900123', name: 'Sara' };

async function openConversation(minutesAgo = 10) {
  await postWebhook(env, inboundPayload(META, sara, { kind: 'text', text: 'Can I book for 4 tonight?' }, new Date(Date.now() - minutesAgo * 60_000)));
  const { rows } = await env.db.query('SELECT id FROM conversations');
  return rows[0].id as string;
}
const outbox = async () => (await env.db.query('SELECT * FROM mock_outbox ORDER BY id')).rows;

describe('approval workflow', () => {
  it('sends only after approval and records the outbound message', async () => {
    const conversationId = await openConversation();
    const d = await createDraft(env.ctx, env.admin, { conversationId, source: 'user', body: 'Yes, 8pm works!' });
    expect(await outbox()).toHaveLength(0);

    const sent = await approveAndSend(env.ctx, env.admin, d.id);
    expect(sent.state).toBe('sent');
    const [o] = await outbox();
    expect(o).toMatchObject({ to_wa_id: sara.waId });
    expect(o.payload).toMatchObject({ type: 'text', body: 'Yes, 8pm works!' });
    // Replies quote the customer's message.
    expect(o.payload.replyTo).toMatch(/^wamid\./);
    const { rows } = await env.db.query(`SELECT needs_reply FROM conversations WHERE id = $1`, [conversationId]);
    expect(rows[0].needs_reply).toBe(false);
    const { rows: out } = await env.db.query(`SELECT * FROM messages WHERE direction = 'out'`);
    expect(out[0]).toMatchObject({ source: 'api', sent_by: env.admin.userId, text: 'Yes, 8pm works!' });
    const { rows: audit } = await env.db.query(`SELECT action FROM audit_log ORDER BY id`);
    expect(audit.map((a) => a.action)).toEqual(['draft.create', 'draft.approve', 'message.send']);
  });

  it('cannot approve twice', async () => {
    const conversationId = await openConversation();
    const d = await createDraft(env.ctx, env.admin, { conversationId, source: 'user', body: 'hi' });
    await approveAndSend(env.ctx, env.admin, d.id);
    await expect(approveAndSend(env.ctx, env.admin, d.id)).rejects.toMatchObject({ code: 'NOT_PENDING' });
    expect(await outbox()).toHaveLength(1);
  });

  it('blocks free-form text outside the 24h window but allows templates', async () => {
    const conversationId = await openConversation(25 * 60);
    const text = await createDraft(env.ctx, env.admin, { conversationId, source: 'user', body: 'Following up!' });
    await expect(approveAndSend(env.ctx, env.admin, text.id)).rejects.toMatchObject({ code: 'WINDOW_CLOSED' });
    const tpl = await createDraft(env.ctx, env.admin, {
      conversationId,
      source: 'user',
      template: { name: 'follow_up', language: 'en', params: ['Sara'] },
    });
    expect((await approveAndSend(env.ctx, env.admin, tpl.id)).state).toBe('sent');
    const { rows } = await env.db.query(`SELECT text, type FROM messages WHERE direction = 'out'`);
    expect(rows[0]).toMatchObject({ type: 'template' });
    expect(rows[0].text).toContain('Hi Sara, we are following up');
  });

  it('validates templates and their parameters', async () => {
    const { conversationId } = await upsertConversation(env.db, '971500000009');
    await expect(
      createDraft(env.ctx, env.admin, { conversationId, source: 'user', template: { name: 'nope', language: 'en', params: [] } }),
    ).rejects.toMatchObject({ code: 'UNKNOWN_TEMPLATE' });
    await expect(
      createDraft(env.ctx, env.admin, { conversationId, source: 'user', template: { name: 'order_update', language: 'ar', params: ['x'] } }),
    ).rejects.toMatchObject({ code: 'TEMPLATE_PARAMS' });
  });

  it('only signed-in agents/admins can approve; tokens and viewers cannot', async () => {
    const conversationId = await openConversation();
    const d = await createDraft(env.ctx, env.admin, { conversationId, source: 'user', body: 'hi' });
    const viewer: Actor = { ...env.admin, role: 'viewer' };
    const token: Actor = { type: 'token', id: 't', userId: env.admin.userId, role: 'admin', scopes: ['read', 'draft'] };
    await expect(approveAndSend(env.ctx, viewer, d.id)).rejects.toMatchObject({ status: 403 });
    await expect(approveAndSend(env.ctx, token, d.id)).rejects.toMatchObject({ status: 403 });
    await expect(rejectDraft(env.ctx, token, d.id)).rejects.toMatchObject({ status: 403 });
    expect(await outbox()).toHaveLength(0);
  });

  it('marks drafts failed on WhatsApp errors and allows retry', async () => {
    const conversationId = await openConversation();
    const d = await createDraft(env.ctx, env.admin, { conversationId, source: 'user', body: 'hi' });
    failNext = new WhatsAppApiError('Re-engagement message', 400, 131047);
    const failed = await approveAndSend(env.ctx, env.admin, d.id);
    expect(failed).toMatchObject({ state: 'failed' });
    expect(failed.error).toMatch(/24-hour window/);
    const retried = await retryDraft(env.ctx, env.admin, d.id);
    expect(retried.state).toBe('pending');
    expect((await approveAndSend(env.ctx, env.admin, d.id)).state).toBe('sent');
  });

  it('rejects drafts with a reason', async () => {
    const conversationId = await openConversation();
    const d = await createDraft(env.ctx, env.admin, { conversationId, source: 'user', body: 'hi' });
    const r = await rejectDraft(env.ctx, env.admin, d.id, 'tone');
    expect(r).toMatchObject({ state: 'rejected', error: 'tone' });
    await expect(approveAndSend(env.ctx, env.admin, d.id)).rejects.toMatchObject({ code: 'NOT_PENDING' });
  });
});
