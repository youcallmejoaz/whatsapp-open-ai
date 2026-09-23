import { describe, expect, it } from 'vitest';
import { hashEmbedding, MockAiProvider } from '../src/ai/mock.ts';
import { echoPayload, historyPayload, inboundPayload, statusPayload } from '../src/demo/payloads.ts';
import { parseWhatsAppExport } from '../src/services/chat-import.ts';
import { windowOpen } from '../src/services/drafts.ts';
import { normalizeWebhook } from '../src/whatsapp/normalize.ts';
import { signPayload, verifySignature } from '../src/whatsapp/signature.ts';

const META = { phoneNumberId: '111' };
const at = new Date('2026-09-01T10:00:00Z');
const customer = { waId: '971500000001', name: 'Ali' };

describe('webhook signature', () => {
  const body = Buffer.from(JSON.stringify({ text: 'مرحبا — "quoted" é' }));

  it('accepts a valid signature', () => {
    expect(verifySignature(body, signPayload(body, 's3cret'), 's3cret')).toBe(true);
  });

  it('rejects tampered bodies, wrong secrets and malformed headers', () => {
    const sig = signPayload(body, 's3cret');
    expect(verifySignature(Buffer.from(body.toString() + ' '), sig, 's3cret')).toBe(false);
    expect(verifySignature(body, sig, 'other')).toBe(false);
    expect(verifySignature(body, undefined, 's3cret')).toBe(false);
    expect(verifySignature(body, 'sha1=abc', 's3cret')).toBe(false);
    expect(verifySignature(body, 'sha256=short', 's3cret')).toBe(false);
  });

  it('is computed over raw bytes, not re-serialised JSON', () => {
    // JSON.stringify would emit the Arabic as-is, Meta may escape it as \\uXXXX.
    const raw = Buffer.from('{"text":"\\u0645\\u0631\\u062d\\u0628\\u0627"}');
    const sig = signPayload(raw, 'k');
    expect(verifySignature(raw, sig, 'k')).toBe(true);
    expect(verifySignature(Buffer.from(JSON.stringify(JSON.parse(raw.toString()))), sig, 'k')).toBe(false);
  });
});

describe('normalizeWebhook', () => {
  it('parses inbound text with the contact name', () => {
    const [e] = normalizeWebhook(inboundPayload(META, customer, { kind: 'text', text: 'وين طلبي؟' }, at, 'wamid.1'), '111');
    expect(e).toMatchObject({
      kind: 'message', source: 'webhook', direction: 'in', waId: customer.waId, contactName: 'Ali',
      waMessageId: 'wamid.1', type: 'text', text: 'وين طلبي؟', timestamp: at,
    });
  });

  it('parses voice notes as audio with a media reference', () => {
    const [e] = normalizeWebhook(inboundPayload(META, customer, { kind: 'voice', transcript: 'hi' }, at), '111');
    expect(e).toMatchObject({ type: 'audio', text: null, media: { voice: true } });
  });

  it('uses captions and location names as text', () => {
    const [img] = normalizeWebhook(inboundPayload(META, customer, { kind: 'image', caption: 'broken box' }, at), '111');
    expect(img).toMatchObject({ type: 'image', text: 'broken box' });
    const [loc] = normalizeWebhook(inboundPayload(META, customer, { kind: 'location', latitude: 25.08, longitude: 55.14, name: 'Marina' }, at), '111');
    expect(loc && loc.kind === 'message' && loc.text).toContain('Marina');
  });

  it('parses statuses, coexistence echoes and history', () => {
    expect(normalizeWebhook(statusPayload(META, 'wamid.9', customer.waId, 'read', at), '111')).toEqual([
      { kind: 'status', waMessageId: 'wamid.9', status: 'read', timestamp: at, recipient: customer.waId, errors: null },
    ]);
    const [echo] = normalizeWebhook(echoPayload(META, customer.waId, 'On its way', at), '111');
    expect(echo).toMatchObject({ source: 'echo', direction: 'out', waId: customer.waId, text: 'On its way' });
    const hist = normalizeWebhook(
      historyPayload(META, customer.waId, [
        { from: 'customer', text: 'q', at },
        { from: 'business', text: 'a', at },
      ]),
      '111',
    );
    expect(hist.map((h) => h.kind === 'message' && [h.source, h.direction, h.waId])).toEqual([
      ['history', 'in', customer.waId],
      ['history', 'out', customer.waId],
    ]);
  });

  it('ignores other phone numbers and junk', () => {
    expect(normalizeWebhook(inboundPayload({ phoneNumberId: '222' }, customer, { kind: 'text', text: 'x' }, at), '111')).toEqual([]);
    expect(normalizeWebhook({ object: 'page', entry: [] }, '111')).toEqual([]);
    expect(normalizeWebhook(null, '111')).toEqual([]);
  });
});

describe('24h customer service window', () => {
  it('is open for 24 hours after the last inbound message', () => {
    const now = Date.now();
    expect(windowOpen(new Date(now - 23 * 3600_000), now)).toBe(true);
    expect(windowOpen(new Date(now - 25 * 3600_000), now)).toBe(false);
    expect(windowOpen(null, now)).toBe(false);
  });
});

describe('WhatsApp export parser', () => {
  it('parses Android exports, multi-line messages and skips system lines', () => {
    const raw = [
      '31/12/2025, 21:15 - Messages and calls are end-to-end encrypted. No one outside of this chat can read them.',
      '31/12/2025, 21:15 - Ali: Hi, is the kitchen open?',
      'I want to order',
      '31/12/2025, 21:17 - Zaatar & Co.: Yes until 23:00',
    ].join('\n');
    const lines = parseWhatsAppExport(raw);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ author: 'Ali', text: 'Hi, is the kitchen open?\nI want to order' });
    expect(lines[0]!.at).toEqual(new Date(2025, 11, 31, 21, 15));
    expect(lines[1]!.author).toBe('Zaatar & Co.');
  });

  it('parses iOS exports with seconds and AM/PM, and US month-first dates', () => {
    const lines = parseWhatsAppExport('[1/13/26, 9:05:10 PM] Sara: hello\n[1/13/26, 12:01:00 AM] Sara: late');
    expect(lines[0]!.at).toEqual(new Date(2026, 0, 13, 21, 5, 10));
    expect(lines[1]!.at).toEqual(new Date(2026, 0, 13, 0, 1, 0));
  });

  it('parses Arabic-locale exports with Arabic digits and ص/م markers', () => {
    const raw = '‏٣١‏/١٢‏/٢٠٢٥، ٩:١٥ م - خالد: السلام عليكم\n‏٣١‏/١٢‏/٢٠٢٥، ٩:٢٠ م - Zaatar: وعليكم السلام';
    const lines = parseWhatsAppExport(raw);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ author: 'خالد', text: 'السلام عليكم' });
    expect(lines[0]!.at).toEqual(new Date(2025, 11, 31, 21, 15));
  });
});

describe('mock AI provider', () => {
  const ai = new MockAiProvider();
  const base = { history: [], contactName: 'Khalid', businessProfile: '', reportLanguage: 'en' as const };

  it('flags angry Arabic complaints as urgent and needing a reply', async () => {
    const t = await ai.triage({ ...base, message: 'طلبي رقم 4821 وصل بارد 😡 خدمة سيئة وهذي آخر مرة' });
    expect(t).toMatchObject({ priority: 'urgent', needs_reply: true, intent: 'complaint', sentiment: 'negative', language: 'ar' });
    expect(t.action_items[0]).toContain('4821');
  });

  it('does not ask for replies to thanks or spam', async () => {
    expect((await ai.triage({ ...base, message: 'شكراً 🌸' })).needs_reply).toBe(false);
    expect((await ai.triage({ ...base, message: 'crypto investment opportunity click here' })).intent).toBe('spam');
  });

  it('drafts in the language of the unanswered customer messages', async () => {
    const d = await ai.draftReply({
      contactName: 'Mona Adel',
      businessProfile: '',
      messages: [
        { direction: 'in', text: 'Hello', at: '' },
        { direction: 'out', text: 'Hi!', at: '' },
        { direction: 'in', text: 'عايزة أحجز طاولة لـ ٤', at: '' },
      ],
    });
    expect(d.language).toBe('ar');
    expect(d.body).toContain('حجز');
  });

  it('embeds Arabic spelling variants close together', () => {
    const cos = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);
    const a = hashEmbedding('إستلام الطلب');
    const b = hashEmbedding('استلام الطَّلب');
    const c = hashEmbedding('table booking tomorrow');
    expect(cos(a, b)).toBeGreaterThan(0.99);
    expect(cos(a, c)).toBeLessThan(0.2);
  });
});
