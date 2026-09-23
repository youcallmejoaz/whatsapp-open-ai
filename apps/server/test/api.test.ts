import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { demoPayloads } from '../src/demo/dataset.ts';
import { inboundPayload } from '../src/demo/payloads.ts';
import { importChat } from '../src/services/chat-import.ts';
import { generateReport } from '../src/services/reports.ts';
import { searchMessages } from '../src/services/search.ts';
import { login, META, postWebhook, setup, type TestEnv } from './helpers.ts';

let env: TestEnv;
beforeEach(async () => {
  env = await setup();
});
afterEach(async () => env.close());

async function seedDemo() {
  for (const p of demoPayloads(META)) await postWebhook(env, p);
}

describe('dashboard API', () => {
  it('requires a session and the CSRF header', async () => {
    expect((await env.app.inject({ url: '/api/conversations' })).statusCode).toBe(401);
    const bad = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@test.local', password: 'nope' } });
    expect(bad.statusCode).toBe(401);
    const headers = await login(env);
    expect((await env.app.inject({ url: '/api/auth/me', headers })).json().user.role).toBe('admin');
    const noCsrf = await env.app.inject({ method: 'POST', url: '/api/reports', headers: { cookie: headers.cookie! }, payload: {} });
    expect(noCsrf.statusCode).toBe(403);
  });

  it('lists the inbox by urgency and exposes the approval queue', async () => {
    await seedDemo();
    const headers = await login(env);
    const res = await env.app.inject({ url: '/api/conversations?filter=needs_reply', headers });
    const body = res.json();
    expect(body.counts.needs_reply).toBe(6);
    expect(body.items[0].priority).toBe('urgent');
    expect(body.items.every((i: { needsReply: boolean }) => i.needsReply)).toBe(true);

    const drafts = (await env.app.inject({ url: '/api/drafts', headers })).json().items;
    expect(drafts).toHaveLength(6);

    const detail = (await env.app.inject({ url: `/api/conversations/${body.items[0].id}`, headers })).json();
    expect(detail.messages.at(-1).triage).toBeTruthy();
    expect(detail.conversation.windowOpen).toBe(true);

    const approved = await env.app.inject({ method: 'POST', url: `/api/drafts/${drafts[0].id}/approve`, headers });
    expect(approved.json().state).toBe('sent');
  });

  it('summarizes conversations and caches until new messages arrive', async () => {
    await seedDemo();
    const headers = await login(env);
    const { items } = (await env.app.inject({ url: '/api/conversations?filter=urgent', headers })).json();
    const url = `/api/conversations/${items[0].id}/summary`;
    const first = (await env.app.inject({ method: 'POST', url, headers, payload: {} })).json();
    expect(first.cached).toBe(false);
    expect(first.summary).toBeTruthy();
    expect((await env.app.inject({ method: 'POST', url, headers, payload: {} })).json().cached).toBe(true);
    expect((await env.app.inject({ method: 'POST', url, headers, payload: { language: 'ar' } })).json().cached).toBe(false);
  });
});

describe('search', () => {
  it('finds order numbers, Arabic spelling variants and Arabic-Indic digits', async () => {
    await seedDemo();
    const byNumber = await searchMessages(env.ctx, { query: '4821' });
    expect(byNumber[0]?.contactName).toBe('Khalid Al Mansoori');
    // "سيئه" (taa marbuta written as haa) should still match "سيئة".
    const variant = await searchMessages(env.ctx, { query: 'خدمه سيئه' });
    expect(variant[0]?.contactName).toBe('Khalid Al Mansoori');
    const digits = await searchMessages(env.ctx, { query: '٤٨٢١' });
    expect(digits[0]?.contactName).toBe('Khalid Al Mansoori');
  });

  it('searches voice-note transcripts and filters by phone and direction', async () => {
    await seedDemo();
    const hits = await searchMessages(env.ctx, { query: 'البطاقة' });
    expect(hits[0]?.contactName).toBe('Layla Haddad');
    const out = await searchMessages(env.ctx, { query: 'order', direction: 'out', waId: '971503334444' });
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((h) => h.direction === 'out' && h.waId === '971503334444')).toBe(true);
  });

  it('indexes imported chat exports', async () => {
    const r = await importChat(env.ctx, {
      raw: '01/03/2025, 10:00 - Rami: Do you do birthday cakes?\n01/03/2025, 10:05 - Zaatar: Yes, 48h notice please',
      customerPhone: '+961 3 123 456',
      businessAuthor: 'Zaatar',
    });
    expect(r).toEqual({ imported: 2, skipped: 0 });
    expect((await importChat(env.ctx, {
      raw: '01/03/2025, 10:00 - Rami: Do you do birthday cakes?\n01/03/2025, 10:05 - Zaatar: Yes, 48h notice please',
      customerPhone: '+961 3 123 456',
      businessAuthor: 'Zaatar',
    })).skipped).toBe(2);
    const hits = await searchMessages(env.ctx, { query: 'birthday cake' });
    expect(hits[0]?.waId).toBe('9613123456');
  });
});

describe('reports', () => {
  it('computes stats and a narrative', async () => {
    await seedDemo();
    await postWebhook(env, inboundPayload(META, { waId: '1', name: 'X' }, { kind: 'text', text: 'hello' }, new Date()));
    const r = await generateReport(env.ctx, { start: new Date(Date.now() - 5 * 24 * 3600_000) });
    expect(r.stats.inbound).toBeGreaterThanOrEqual(15);
    expect(r.stats.outbound).toBe(5); // 2 from history sync + 3 phone-app echoes
    expect(r.stats.urgentOpen).toBe(2);
    expect(r.stats.byIntent.complaint).toBeGreaterThan(0);
    expect(r.stats.medianFirstResponseMinutes).not.toBeNull();
    expect(r.stats.actionItems.some((a) => a.item.includes('4821'))).toBe(true);
    expect(r.narrative).toContain('Overview');
    const ar = await generateReport(env.ctx, { language: 'ar' });
    expect(ar.narrative).toContain('نظرة عامة');
  });
});
