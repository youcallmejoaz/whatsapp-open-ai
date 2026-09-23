import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { echoPayload, inboundPayload, statusPayload } from '../src/demo/payloads.ts';
import { approveAndSend, editDraft } from '../src/services/drafts.ts';
import { META, postWebhook, setup, type TestEnv } from './helpers.ts';

let env: TestEnv;
beforeEach(async () => {
  env = await setup();
});
afterEach(async () => env.close());

const khalid = { waId: '971501110001', name: 'Khalid' };
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

async function conv(waId: string) {
  const { rows } = await env.db.query(
    `SELECT cv.* FROM conversations cv JOIN contacts c ON c.id = cv.contact_id WHERE c.wa_id = $1`,
    [waId],
  );
  return rows[0];
}
const drafts = async (state = 'pending') =>
  (await env.db.query('SELECT * FROM drafts WHERE state = $1 ORDER BY created_at', [state])).rows;

describe('webhook endpoint', () => {
  it('answers the subscription handshake only with the right verify token', async () => {
    const ok = await env.app.inject({
      url: `/webhook?hub.mode=subscribe&hub.verify_token=${env.cfg.WA_VERIFY_TOKEN}&hub.challenge=12345`,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('12345');
    const bad = await env.app.inject({ url: '/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1' });
    expect(bad.statusCode).toBe(403);
  });

  it('rejects unsigned or wrongly signed payloads and stores nothing', async () => {
    const payload = inboundPayload(META, khalid, { kind: 'text', text: 'hi' }, new Date());
    expect((await postWebhook(env, payload, 'wrong-secret')).statusCode).toBe(401);
    const unsigned = await env.app.inject({ method: 'POST', url: '/webhook', payload: JSON.stringify(payload), headers: { 'content-type': 'application/json' } });
    expect(unsigned.statusCode).toBe(401);
    expect((await env.db.query('SELECT count(*)::int AS n FROM webhook_events')).rows[0].n).toBe(0);
  });
});

describe('webhook diagnostics in logs', () => {
  it('warns with the received phone_number_id when it does not match', async () => {
    const res = await postWebhook(env, inboundPayload({ phoneNumberId: '999' }, khalid, { kind: 'text', text: 'hello?' }, new Date()));
    expect(res.statusCode).toBe(200);
    expect((await env.db.query('SELECT count(*)::int AS n FROM messages')).rows[0].n).toBe(0);
    const warn = env.logs.find((l) => l.level === 'warn' && l.msg?.includes('phone_number_id'));
    expect(warn?.obj).toMatchObject({ expected: '111', received: ['999'], fields: ['messages'] });
  });

  it('warns about payloads that are not WhatsApp events', async () => {
    await postWebhook(env, { object: 'page', entry: [] });
    expect(env.logs.some((l) => l.level === 'warn' && l.msg?.includes('not a WhatsApp Business Account event'))).toBe(true);
  });

  it('logs counts (not content) for processed webhooks', async () => {
    const payload = inboundPayload(META, khalid, { kind: 'text', text: 'Where is my order?' }, minutesAgo(1));
    await postWebhook(env, payload);
    await postWebhook(env, payload);
    const processed = env.logs.filter((l) => l.msg === 'webhook processed').map((l) => l.obj);
    expect(processed).toEqual([
      expect.objectContaining({ messages: 1, duplicates: 0, statuses: 0, fields: ['messages'] }),
      expect.objectContaining({ messages: 0, duplicates: 1 }),
    ]);
    expect(JSON.stringify(processed)).not.toContain('order');
  });
});

describe('inbound pipeline', () => {
  it('stores, triages and auto-drafts an Arabic complaint', async () => {
    const payload = inboundPayload(META, khalid, { kind: 'text', text: 'طلبي رقم 4821 وصل بارد 😡 خدمة سيئة' }, minutesAgo(5));
    expect((await postWebhook(env, payload)).statusCode).toBe(200);

    const c = await conv(khalid.waId);
    expect(c).toMatchObject({ needs_reply: true, priority: 'urgent', intent: 'complaint' });
    const { rows: msgs } = await env.db.query('SELECT m.*, a.priority FROM messages m JOIN message_analyses a ON a.message_id = m.id');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text_normalized).toContain('4821');
    expect(msgs[0].embedding).toBeTruthy();
    const [draft] = await drafts();
    expect(draft).toMatchObject({ source: 'ai', conversation_id: c.id });
    expect(draft.body).toMatch(/نعتذر/);
  });

  it('is idempotent when Meta retries the same webhook', async () => {
    const payload = inboundPayload(META, khalid, { kind: 'text', text: 'hello?' }, minutesAgo(1), 'wamid.SAME');
    await postWebhook(env, payload);
    await postWebhook(env, payload);
    expect((await env.db.query('SELECT count(*)::int AS n FROM messages')).rows[0].n).toBe(1);
    expect(await drafts()).toHaveLength(1);
  });

  it('transcribes voice notes before triage', async () => {
    await postWebhook(env, inboundPayload(META, khalid, { kind: 'voice', transcript: 'انخصم مني المبلغ مرتين' }, minutesAgo(1)));
    const { rows } = await env.db.query('SELECT transcript FROM messages');
    expect(rows[0].transcript).toBe('انخصم مني المبلغ مرتين');
    expect(await conv(khalid.waId)).toMatchObject({ priority: 'urgent', intent: 'payment' });
  });

  it('keeps the most severe priority while waiting, and replaces stale AI drafts', async () => {
    await postWebhook(env, inboundPayload(META, khalid, { kind: 'text', text: 'my order is late and cold, worst service' }, minutesAgo(3)));
    await postWebhook(env, inboundPayload(META, khalid, { kind: 'image', caption: 'see photo' }, minutesAgo(2)));
    expect(await conv(khalid.waId)).toMatchObject({ priority: 'urgent', intent: 'complaint', needs_reply: true });
    expect(await drafts()).toHaveLength(1);
    expect((await drafts('rejected'))[0].error).toMatch(/newer customer message/);
  });

  it('keeps drafts that staff edited when new messages arrive', async () => {
    await postWebhook(env, inboundPayload(META, khalid, { kind: 'text', text: 'Do you deliver to JLT?' }, minutesAgo(3)));
    const [d] = await drafts();
    await new Promise((r) => setTimeout(r, 5));
    await editDraft(env.ctx, env.admin, d.id, 'Yes we do! 🚚');
    await postWebhook(env, inboundPayload(META, khalid, { kind: 'text', text: 'And to the Palm?' }, minutesAgo(2)));
    const pending = await drafts();
    expect(pending.map((p) => p.body)).toContain('Yes we do! 🚚');
  });

  it('clears needs_reply and retires AI drafts when someone replies from the phone app', async () => {
    await postWebhook(env, inboundPayload(META, khalid, { kind: 'text', text: 'Is the kitchen open?' }, minutesAgo(3)));
    expect(await drafts()).toHaveLength(1);
    await postWebhook(env, echoPayload(META, khalid.waId, 'Yes until 11pm', minutesAgo(1)));
    expect((await conv(khalid.waId)).needs_reply).toBe(false);
    expect(await drafts()).toHaveLength(0);
  });

  it('applies delivery statuses without regressing', async () => {
    await postWebhook(env, inboundPayload(META, khalid, { kind: 'text', text: 'where is my order?' }, minutesAgo(2)));
    const [d] = await drafts();
    const sent = await approveAndSend(env.ctx, env.admin, d.id);
    const { rows } = await env.db.query('SELECT wa_message_id FROM messages WHERE id = (SELECT sent_message_id FROM drafts WHERE id = $1)', [sent.id]);
    const wamid = rows[0].wa_message_id;
    await postWebhook(env, statusPayload(META, wamid, khalid.waId, 'read', new Date()));
    await postWebhook(env, statusPayload(META, wamid, khalid.waId, 'delivered', new Date()));
    const { rows: after } = await env.db.query('SELECT status FROM messages WHERE wa_message_id = $1', [wamid]);
    expect(after[0].status).toBe('read');
  });
});
