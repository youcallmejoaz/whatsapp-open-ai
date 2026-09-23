import type {
  ConversationDetail,
  ConversationListItem,
  ConversationSummary,
  Intent,
  MessageDto,
  Priority,
  Triage,
} from '@wa/shared';
import type { AppContext } from '../context.ts';
import { notFound } from '../errors.ts';
import { chatLines } from './analyze.ts';
import { listDrafts, windowOpen } from './drafts.ts';

export type InboxFilter = 'all' | 'needs_reply' | 'urgent';

interface ListRow {
  id: string;
  contact_id: string;
  wa_id: string;
  name: string | null;
  last_message_at: Date | null;
  last_inbound_at: Date | null;
  last_read_at: Date | null;
  priority: Priority | null;
  needs_reply: boolean;
  intent: Intent | null;
  last_text: string | null;
  pending_drafts: number;
  unread: number;
}

const LIST_SQL = `
  SELECT cv.id, c.id AS contact_id, c.wa_id, c.name, cv.last_message_at, cv.last_inbound_at, cv.last_read_at,
         cv.priority, cv.needs_reply, cv.intent,
         (SELECT coalesce(m.text, m.transcript, '[' || m.type || ']') FROM messages m
          WHERE m.conversation_id = cv.id ORDER BY m.created_at DESC LIMIT 1) AS last_text,
         (SELECT count(*) FROM drafts d WHERE d.conversation_id = cv.id AND d.state = 'pending') AS pending_drafts,
         (SELECT count(*) FROM messages m WHERE m.conversation_id = cv.id AND m.direction = 'in'
            AND m.created_at > coalesce(cv.last_read_at, 'epoch')) AS unread
  FROM conversations cv JOIN contacts c ON c.id = cv.contact_id`;

function toItem(r: ListRow): ConversationListItem {
  return {
    id: r.id,
    contact: { id: r.contact_id, waId: r.wa_id, name: r.name },
    lastMessageAt: r.last_message_at?.toISOString() ?? null,
    lastInboundAt: r.last_inbound_at?.toISOString() ?? null,
    windowOpen: windowOpen(r.last_inbound_at),
    lastText: r.last_text,
    priority: r.priority,
    needsReply: r.needs_reply,
    intent: r.intent,
    pendingDrafts: Number(r.pending_drafts),
    unread: Number(r.unread),
  };
}

export async function listConversations(
  ctx: AppContext,
  opts: { filter?: InboxFilter; limit?: number; offset?: number } = {},
): Promise<{ items: ConversationListItem[]; counts: Record<InboxFilter | 'pending_drafts', number> }> {
  const where =
    opts.filter === 'needs_reply' ? 'WHERE cv.needs_reply' : opts.filter === 'urgent' ? `WHERE cv.needs_reply AND cv.priority = 'urgent'` : '';
  const { rows } = await ctx.db.query<ListRow>(
    `${LIST_SQL} ${where}
     ORDER BY cv.needs_reply DESC,
              array_position(ARRAY['urgent','high','normal','low'], cv.priority) NULLS LAST,
              cv.last_message_at DESC NULLS LAST
     LIMIT $1 OFFSET $2`,
    [Math.min(opts.limit ?? 50, 200), opts.offset ?? 0],
  );
  const counts = await ctx.db.query<{ all: number; needs_reply: number; urgent: number; pending_drafts: number }>(
    `SELECT count(*) AS "all",
            count(*) FILTER (WHERE needs_reply) AS needs_reply,
            count(*) FILTER (WHERE needs_reply AND priority = 'urgent') AS urgent,
            (SELECT count(*) FROM drafts WHERE state = 'pending') AS pending_drafts
     FROM conversations`,
  );
  return { items: rows.map(toItem), counts: counts.rows[0]! };
}

/** Find a conversation by id or by the customer's phone number (wa_id, digits only). */
export async function resolveConversationId(ctx: AppContext, ref: { conversationId?: string; phone?: string }): Promise<string> {
  if (ref.conversationId) return ref.conversationId;
  const digits = (ref.phone ?? '').replace(/\D/g, '');
  const { rows } = await ctx.db.query<{ id: string }>(
    'SELECT cv.id FROM conversations cv JOIN contacts c ON c.id = cv.contact_id WHERE c.wa_id = $1',
    [digits],
  );
  if (!rows[0]) throw notFound('Conversation');
  return rows[0].id;
}

export async function getConversation(
  ctx: AppContext,
  id: string,
  opts: { markRead?: boolean; messageLimit?: number } = {},
): Promise<ConversationDetail> {
  const { rows } = await ctx.db.query<ListRow>(`${LIST_SQL} WHERE cv.id = $1`, [id]);
  if (!rows[0]) throw notFound('Conversation');

  const msgs = await ctx.db.query<{
    id: string;
    wa_message_id: string;
    direction: 'in' | 'out';
    type: string;
    text: string | null;
    transcript: string | null;
    status: string | null;
    source: string;
    created_at: Date;
    priority: Priority | null;
    needs_reply: boolean | null;
    intent: Intent | null;
    sentiment: Triage['sentiment'] | null;
    language: string | null;
    summary: string | null;
    action_items: string[] | null;
    reason: string | null;
  }>(
    `SELECT * FROM (
       SELECT m.id, m.wa_message_id, m.direction, m.type, m.text, m.transcript, m.status, m.source, m.created_at,
              a.priority, a.needs_reply, a.intent, a.sentiment, a.language, a.summary, a.action_items, a.reason
       FROM messages m LEFT JOIN message_analyses a ON a.message_id = m.id
       WHERE m.conversation_id = $1 ORDER BY m.created_at DESC LIMIT $2
     ) t ORDER BY created_at`,
    [id, opts.messageLimit ?? 200],
  );
  const messages: MessageDto[] = msgs.rows.map((m) => ({
    id: m.id,
    waMessageId: m.wa_message_id,
    direction: m.direction,
    type: m.type,
    text: m.text,
    transcript: m.transcript,
    status: m.status,
    source: m.source,
    createdAt: m.created_at.toISOString(),
    triage: m.priority
      ? {
          priority: m.priority,
          needs_reply: !!m.needs_reply,
          intent: m.intent!,
          sentiment: m.sentiment!,
          language: m.language!,
          summary: m.summary!,
          action_items: m.action_items ?? [],
          reason: m.reason!,
        }
      : null,
  }));

  const summary = await ctx.db.query<{ summary: ConversationSummary; updated_at: Date }>(
    'SELECT summary, updated_at FROM conversation_summaries WHERE conversation_id = $1',
    [id],
  );
  const drafts = await listDrafts(ctx, { conversationId: id, limit: 20 });

  if (opts.markRead) {
    await ctx.db.query('UPDATE conversations SET last_read_at = now() WHERE id = $1', [id]);
    const lastIn = [...messages].reverse().find((m) => m.direction === 'in');
    if (lastIn) {
      // Blue ticks for the customer. Best effort: a failure must not break the UI.
      ctx.wa.markRead(lastIn.waMessageId).catch((err: unknown) => ctx.log.debug({ err }, 'markRead failed'));
    }
  }

  return {
    conversation: toItem(rows[0]),
    messages,
    drafts,
    summary: summary.rows[0] ? { ...summary.rows[0].summary, updatedAt: summary.rows[0].updated_at.toISOString() } : null,
  };
}

/** Summarize a conversation; cached until new messages arrive. */
export async function summarizeConversation(
  ctx: AppContext,
  id: string,
  opts: { force?: boolean; language?: 'en' | 'ar' } = {},
): Promise<ConversationSummary & { updatedAt: string; cached: boolean }> {
  const { rows } = await ctx.db.query<{ name: string | null; n: number }>(
    `SELECT c.name, (SELECT count(*) FROM messages m WHERE m.conversation_id = cv.id) AS n
     FROM conversations cv JOIN contacts c ON c.id = cv.contact_id WHERE cv.id = $1`,
    [id],
  );
  if (!rows[0]) throw notFound('Conversation');
  const count = Number(rows[0].n);
  const language = opts.language ?? ctx.cfg.REPORT_LANGUAGE;

  if (!opts.force) {
    const cached = await ctx.db.query<{ summary: ConversationSummary & { language?: string }; message_count: number; updated_at: Date }>(
      'SELECT summary, message_count, updated_at FROM conversation_summaries WHERE conversation_id = $1',
      [id],
    );
    const c = cached.rows[0];
    if (c && c.message_count === count && (c.summary.language ?? ctx.cfg.REPORT_LANGUAGE) === language) {
      return { ...c.summary, updatedAt: c.updated_at.toISOString(), cached: true };
    }
  }

  const messages = await chatLines(ctx.db, id, { limit: 150 });
  const summary = await ctx.ai.summarize({
    messages,
    contactName: rows[0].name,
    businessProfile: ctx.businessProfile,
    language,
  });
  const saved = await ctx.db.query<{ updated_at: Date }>(
    `INSERT INTO conversation_summaries (conversation_id, summary, message_count) VALUES ($1, $2, $3)
     ON CONFLICT (conversation_id) DO UPDATE SET summary = EXCLUDED.summary, message_count = EXCLUDED.message_count, updated_at = now()
     RETURNING updated_at`,
    [id, JSON.stringify({ ...summary, language }), count],
  );
  return { ...summary, updatedAt: saved.rows[0]!.updated_at.toISOString(), cached: false };
}
