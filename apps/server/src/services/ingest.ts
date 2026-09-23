import { normalizeArabic } from '@wa/shared';
import type { AppContext } from '../context.ts';
import { tx, type Queryable } from '../db/db.ts';
import { supersedeAiDrafts } from './analyze.ts';
import { describeWebhook, normalizeWebhook, type MessageEvent, type StatusEvent } from '../whatsapp/normalize.ts';

export interface IngestInput {
  source: 'webhook' | 'echo' | 'history' | 'import' | 'api';
  direction: 'in' | 'out';
  waId: string;
  contactName?: string | null;
  waMessageId: string;
  timestamp: Date;
  type: string;
  text: string | null;
  media?: unknown;
  contextWaMessageId?: string | null;
  raw?: unknown;
  sentBy?: string | null;
}

export async function upsertConversation(
  db: Queryable,
  waId: string,
  name?: string | null,
): Promise<{ contactId: string; conversationId: string }> {
  const contact = await db.query<{ id: string }>(
    `INSERT INTO contacts (wa_id, name) VALUES ($1, $2)
     ON CONFLICT (wa_id) DO UPDATE SET name = COALESCE(EXCLUDED.name, contacts.name)
     RETURNING id`,
    [waId, name ?? null],
  );
  const contactId = contact.rows[0]!.id;
  const conv = await db.query<{ id: string }>(
    `INSERT INTO conversations (contact_id) VALUES ($1)
     ON CONFLICT (contact_id) DO UPDATE SET contact_id = EXCLUDED.contact_id
     RETURNING id`,
    [contactId],
  );
  return { contactId, conversationId: conv.rows[0]!.id };
}

/**
 * Store one message idempotently. Returns null when the wa_message_id was
 * already stored (Meta retries webhooks, history sync can overlap).
 */
export async function ingestMessage(db: Queryable, m: IngestInput): Promise<{ id: string; conversationId: string } | null> {
  const { conversationId } = await upsertConversation(db, m.waId, m.direction === 'in' ? m.contactName : null);
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO messages (conversation_id, wa_message_id, direction, type, text, text_normalized, media,
                           context_wa_id, source, sent_by, raw, created_at, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (wa_message_id) DO NOTHING
     RETURNING id`,
    [
      conversationId,
      m.waMessageId,
      m.direction,
      m.type,
      m.text,
      m.text ? normalizeArabic(m.text) : null,
      m.media ? JSON.stringify(m.media) : null,
      m.contextWaMessageId ?? null,
      m.source,
      m.sentBy ?? null,
      m.raw === undefined ? null : JSON.stringify(m.raw),
      m.timestamp,
      m.direction === 'out' ? 'sent' : null,
    ],
  );
  const id = inserted.rows[0]?.id;
  if (!id) return null;

  if (m.direction === 'in') {
    await db.query(
      `UPDATE conversations SET
         last_message_at = GREATEST(last_message_at, $2),
         last_inbound_at = GREATEST(last_inbound_at, $2)
       WHERE id = $1`,
      [conversationId, m.timestamp],
    );
  } else {
    if (m.source === 'echo') {
      // Someone answered from the WhatsApp Business App (coexistence), so AI drafts are moot.
      await supersedeAiDrafts(db, conversationId, 'Superseded: a reply was sent from the WhatsApp Business App');
    }
    // A reply newer than the last inbound message (from the dashboard, the
    // phone app via coexistence echoes, or history) settles the thread.
    await db.query(
      `UPDATE conversations SET
         last_message_at = GREATEST(last_message_at, $2),
         needs_reply = CASE WHEN last_inbound_at IS NULL OR $2 >= last_inbound_at THEN false ELSE needs_reply END
       WHERE id = $1`,
      [conversationId, m.timestamp],
    );
  }
  return { id, conversationId };
}

// Status webhooks can arrive out of order (read before delivered); never regress.
export async function applyStatus(db: Queryable, s: StatusEvent): Promise<void> {
  await db.query(
    `UPDATE messages SET status = $2, status_at = $3, error = $4
     WHERE wa_message_id = $1
       AND (CASE COALESCE(status, '') WHEN 'failed' THEN 4 WHEN 'read' THEN 3 WHEN 'delivered' THEN 2 WHEN 'sent' THEN 1 ELSE 0 END)
         < (CASE $2::text WHEN 'failed' THEN 4 WHEN 'read' THEN 3 WHEN 'delivered' THEN 2 WHEN 'sent' THEN 1 ELSE 0 END)`,
    [s.waMessageId, s.status, s.timestamp, s.errors ? JSON.stringify(s.errors) : null],
  );
}

function fromEvent(e: MessageEvent): IngestInput {
  return {
    source: e.source,
    direction: e.direction,
    waId: e.waId,
    contactName: e.contactName,
    waMessageId: e.waMessageId,
    timestamp: e.timestamp,
    type: e.type,
    text: e.text,
    media: e.media,
    contextWaMessageId: e.contextWaMessageId,
    raw: e.raw,
  };
}

/** Job: turn a stored webhook payload into messages/statuses and fan out analysis. */
export async function processWebhookEvent(ctx: AppContext, eventId: number): Promise<void> {
  const { rows } = await ctx.db.query<{ payload: unknown; processed_at: Date | null }>(
    'SELECT payload, processed_at FROM webhook_events WHERE id = $1',
    [eventId],
  );
  const row = rows[0];
  if (!row || row.processed_at) return;

  const events = normalizeWebhook(row.payload, ctx.cfg.WA_PHONE_NUMBER_ID);
  const toAnalyze: { messageId: string; triage: boolean }[] = [];
  const { phoneNumberIds, fields } = describeWebhook(row.payload);
  // The most common live misconfiguration: WA_PHONE_NUMBER_ID is the phone number
  // or the WABA ID instead of the Phone number ID. Say so loudly instead of dropping silently.
  if (fields.length === 0) {
    ctx.log.warn({ eventId }, 'webhook ignored: payload is not a WhatsApp Business Account event');
  } else if (phoneNumberIds.length > 0 && !phoneNumberIds.includes(ctx.cfg.WA_PHONE_NUMBER_ID)) {
    ctx.log.warn(
      { eventId, expected: ctx.cfg.WA_PHONE_NUMBER_ID, received: phoneNumberIds, fields },
      'webhook ignored: phone_number_id does not match WA_PHONE_NUMBER_ID',
    );
  }
  let stored = 0;
  let duplicates = 0;
  let statuses = 0;

  await tx(ctx.db, async (c) => {
    for (const e of events) {
      if (e.kind === 'status') {
        await applyStatus(c, e);
        statuses++;
        continue;
      }
      const msg = await ingestMessage(c, fromEvent(e));
      if (!msg) {
        duplicates++;
        continue;
      }
      stored++;
      // Triage only live inbound traffic; history/echo messages are indexed for search.
      toAnalyze.push({ messageId: msg.id, triage: e.source === 'webhook' && e.direction === 'in' });
    }
    await c.query('UPDATE webhook_events SET processed_at = now(), error = NULL WHERE id = $1', [eventId]);
  });

  if (events.length > 0) {
    // Counts only: no message text or phone numbers in logs.
    ctx.log.info({ eventId, messages: stored, duplicates, statuses, fields }, 'webhook processed');
  }
  for (const job of toAnalyze) await ctx.queue.send('message.analyze', job);
}
