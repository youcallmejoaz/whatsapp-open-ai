import { normalizeArabic } from '@wa/shared';
import type { ChatLine } from '../ai/provider.ts';
import type { AppContext } from '../context.ts';
import { toVector, type Queryable } from '../db/db.ts';

interface MessageRow {
  id: string;
  conversation_id: string;
  direction: 'in' | 'out';
  type: string;
  text: string | null;
  transcript: string | null;
  media: { id: string; mimeType?: string } | null;
  created_at: Date;
  contact_name: string | null;
  contact_language: string | null;
  contact_id: string;
}

export const contentOf = (m: { text: string | null; transcript: string | null }) => m.text ?? m.transcript;

/** Recent messages of a conversation as plain chat lines for prompts. */
export async function chatLines(db: Queryable, conversationId: string, opts: { before?: Date; limit: number }): Promise<ChatLine[]> {
  const { rows } = await db.query<{ direction: 'in' | 'out'; text: string | null; transcript: string | null; type: string; created_at: Date }>(
    `SELECT direction, text, transcript, type, created_at FROM (
       SELECT * FROM messages
       WHERE conversation_id = $1 AND ($2::timestamptz IS NULL OR created_at < $2) AND type <> 'reaction'
       ORDER BY created_at DESC LIMIT $3
     ) t ORDER BY created_at`,
    [conversationId, opts.before ?? null, opts.limit],
  );
  return rows.map((r) => ({
    direction: r.direction,
    text: contentOf(r) ?? `[${r.type}]`,
    at: r.created_at.toISOString(),
  }));
}

/**
 * Job: transcribe voice notes, embed for search, and (for live inbound
 * messages) triage and maybe queue an AI draft.
 */
export async function analyzeMessage(ctx: AppContext, messageId: string, withTriage: boolean): Promise<void> {
  const { rows } = await ctx.db.query<MessageRow>(
    `SELECT m.id, m.conversation_id, m.direction, m.type, m.text, m.transcript, m.media, m.created_at,
            c.name AS contact_name, c.language AS contact_language, c.id AS contact_id
     FROM messages m
     JOIN conversations cv ON cv.id = m.conversation_id
     JOIN contacts c ON c.id = cv.contact_id
     WHERE m.id = $1`,
    [messageId],
  );
  const msg = rows[0];
  if (!msg) return;

  if (msg.type === 'audio' && msg.media?.id && !msg.transcript) {
    const audio = await ctx.wa.downloadMedia(msg.media.id);
    msg.transcript = await ctx.ai.transcribe(audio.data, audio.mimeType);
    await ctx.db.query('UPDATE messages SET transcript = $2, text_normalized = $3 WHERE id = $1', [
      msg.id,
      msg.transcript,
      normalizeArabic(msg.transcript),
    ]);
  }

  const content = contentOf(msg);
  if (!content || msg.type === 'reaction') return;

  const [embedding] = await ctx.ai.embed([content]);
  if (embedding) await ctx.db.query('UPDATE messages SET embedding = $2 WHERE id = $1', [msg.id, toVector(embedding)]);

  if (!withTriage || msg.direction !== 'in') return;

  const history = await chatLines(ctx.db, msg.conversation_id, { before: msg.created_at, limit: 10 });
  const triage = await ctx.ai.triage({
    message: content,
    history,
    contactName: msg.contact_name,
    businessProfile: ctx.businessProfile,
    reportLanguage: ctx.cfg.REPORT_LANGUAGE,
  });

  await ctx.db.query(
    `INSERT INTO message_analyses (message_id, priority, needs_reply, intent, sentiment, language, summary, action_items, reason, model)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (message_id) DO UPDATE SET
       priority = EXCLUDED.priority, needs_reply = EXCLUDED.needs_reply, intent = EXCLUDED.intent,
       sentiment = EXCLUDED.sentiment, language = EXCLUDED.language, summary = EXCLUDED.summary,
       action_items = EXCLUDED.action_items, reason = EXCLUDED.reason, model = EXCLUDED.model, created_at = now()`,
    [
      msg.id, triage.priority, triage.needs_reply, triage.intent, triage.sentiment, triage.language,
      triage.summary, JSON.stringify(triage.action_items), triage.reason, ctx.ai.name,
    ],
  );
  if (!msg.contact_language) {
    await ctx.db.query('UPDATE contacts SET language = $2 WHERE id = $1', [msg.contact_id, triage.language]);
  }

  // Only the newest inbound message sets the conversation flags, and only if
  // nobody has replied since. While a conversation is waiting for a reply it
  // keeps its most severe priority (and that message's intent): "ok, see
  // attached photo" after an urgent complaint must not downgrade it.
  const updated = await ctx.db.query<{ needs_reply: boolean }>(
    `WITH cur AS (
       SELECT cv.id,
              cv.needs_reply AND (
                $2 = false OR (cv.priority IS NOT NULL AND
                  array_position(ARRAY['urgent','high','normal','low'], cv.priority)
                    <= array_position(ARRAY['urgent','high','normal','low'], $3::text))
              ) AS keep
       FROM conversations cv WHERE cv.id = $1
     )
     UPDATE conversations cv SET
       needs_reply = cv.needs_reply OR $2,
       priority = CASE WHEN cur.keep THEN cv.priority ELSE $3 END,
       intent = CASE WHEN cur.keep THEN cv.intent ELSE $4 END
     FROM cur
     WHERE cv.id = cur.id
       AND cv.last_inbound_at <= $5
       AND NOT EXISTS (SELECT 1 FROM messages o WHERE o.conversation_id = cv.id AND o.direction = 'out' AND o.created_at > $5)
     RETURNING cv.needs_reply`,
    [msg.conversation_id, triage.needs_reply, triage.priority, triage.intent, msg.created_at],
  );

  if (ctx.cfg.AUTO_DRAFT && updated.rows[0]?.needs_reply && triage.needs_reply) {
    // The customer added something: an untouched AI draft written before this
    // message is stale, so replace it with one that sees the full context.
    await supersedeAiDrafts(ctx.db, msg.conversation_id, 'Superseded by a newer customer message');
    await ctx.queue.send('draft.generate', { conversationId: msg.conversation_id }, { singletonKey: msg.conversation_id });
  }
}

/** Retire pending AI drafts nobody has edited. Drafts written or edited by staff are kept. */
export async function supersedeAiDrafts(db: Queryable, conversationId: string, reason: string): Promise<void> {
  await db.query(
    `UPDATE drafts SET state = 'rejected', error = $2, decided_at = now(), updated_at = now()
     WHERE conversation_id = $1 AND state = 'pending' AND source = 'ai' AND updated_at = created_at`,
    [conversationId, reason],
  );
}
