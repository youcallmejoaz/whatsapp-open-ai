import type { ReportDto, ReportStats } from '@wa/shared';
import type { AppContext } from '../context.ts';
import { notFound } from '../errors.ts';

export async function computeStats(ctx: AppContext, start: Date, end: Date): Promise<ReportStats> {
  const db = ctx.db;
  const base = await db.query<{ inbound: number; outbound: number; conversations: number; new_contacts: number }>(
    `SELECT count(*) FILTER (WHERE direction = 'in') AS inbound,
            count(*) FILTER (WHERE direction = 'out') AS outbound,
            count(DISTINCT conversation_id) AS conversations,
            (SELECT count(*) FROM contacts WHERE created_at >= $1 AND created_at < $2) AS new_contacts
     FROM messages WHERE created_at >= $1 AND created_at < $2`,
    [start, end],
  );
  const open = await db.query<{ needs_reply: number; urgent: number }>(
    `SELECT count(*) FILTER (WHERE needs_reply) AS needs_reply,
            count(*) FILTER (WHERE needs_reply AND priority = 'urgent') AS urgent
     FROM conversations`,
  );
  // First response time: for each customer "turn" (first inbound after an
  // outbound or at the start), minutes until the next outbound message.
  const frt = await db.query<{ median: number | null }>(
    `WITH ordered AS (
       SELECT conversation_id, direction, created_at,
              lag(direction) OVER (PARTITION BY conversation_id ORDER BY created_at) AS prev_dir
       FROM messages
     ),
     turns AS (
       SELECT o.conversation_id, o.created_at,
              (SELECT min(m.created_at) FROM messages m
               WHERE m.conversation_id = o.conversation_id AND m.direction = 'out' AND m.created_at > o.created_at) AS replied_at
       FROM ordered o
       WHERE o.direction = 'in' AND (o.prev_dir IS NULL OR o.prev_dir = 'out')
         AND o.created_at >= $1 AND o.created_at < $2
     )
     SELECT round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM replied_at - created_at) / 60))::numeric, 1)::float AS median
     FROM turns WHERE replied_at IS NOT NULL`,
    [start, end],
  );
  const dist = await db.query<{ kind: string; key: string; n: number }>(
    `SELECT 'intent' AS kind, a.intent AS key, count(*) AS n FROM message_analyses a JOIN messages m ON m.id = a.message_id
       WHERE m.created_at >= $1 AND m.created_at < $2 GROUP BY a.intent
     UNION ALL
     SELECT 'priority', a.priority, count(*) FROM message_analyses a JOIN messages m ON m.id = a.message_id
       WHERE m.created_at >= $1 AND m.created_at < $2 GROUP BY a.priority
     UNION ALL
     SELECT 'sentiment', a.sentiment, count(*) FROM message_analyses a JOIN messages m ON m.id = a.message_id
       WHERE m.created_at >= $1 AND m.created_at < $2 GROUP BY a.sentiment`,
    [start, end],
  );
  // Open action items: from every analysed customer message since our last
  // reply, in conversations still waiting, most urgent conversations first.
  const items = await db.query<{ conversation_id: string; contact: string; item: string }>(
    `SELECT conversation_id, contact, item FROM (
       SELECT DISTINCT ON (cv.id, item) cv.id AS conversation_id, coalesce(c.name, c.wa_id) AS contact, item,
              array_position(ARRAY['urgent','high','normal','low'], cv.priority) AS rank, m.created_at
       FROM conversations cv
       JOIN contacts c ON c.id = cv.contact_id
       JOIN messages m ON m.conversation_id = cv.id AND m.direction = 'in'
       JOIN message_analyses a ON a.message_id = m.id
       CROSS JOIN LATERAL jsonb_array_elements_text(a.action_items) AS item
       WHERE cv.needs_reply
         AND m.created_at > coalesce(
           (SELECT max(o.created_at) FROM messages o WHERE o.conversation_id = cv.id AND o.direction = 'out'), 'epoch')
       ORDER BY cv.id, item, m.created_at
     ) t
     ORDER BY rank NULLS LAST, created_at
     LIMIT 25`,
  );

  const by = (kind: string) =>
    Object.fromEntries(dist.rows.filter((r) => r.kind === kind).map((r) => [r.key, Number(r.n)])) as Record<string, number>;
  const b = base.rows[0]!;
  return {
    inbound: Number(b.inbound),
    outbound: Number(b.outbound),
    conversations: Number(b.conversations),
    newContacts: Number(b.new_contacts),
    needsReplyOpen: Number(open.rows[0]!.needs_reply),
    urgentOpen: Number(open.rows[0]!.urgent),
    medianFirstResponseMinutes: frt.rows[0]?.median ?? null,
    byIntent: by('intent'),
    byPriority: by('priority'),
    bySentiment: by('sentiment'),
    actionItems: items.rows.map((r) => ({ conversationId: r.conversation_id, contact: r.contact, item: r.item })),
  };
}

interface ReportRow {
  id: string;
  period_start: Date;
  period_end: Date;
  language: string;
  stats: ReportStats;
  narrative: string;
  created_at: Date;
}

const toDto = (r: ReportRow): ReportDto => ({
  id: r.id,
  periodStart: r.period_start.toISOString(),
  periodEnd: r.period_end.toISOString(),
  language: r.language,
  createdAt: r.created_at.toISOString(),
  stats: r.stats,
  narrative: r.narrative,
});

export async function generateReport(
  ctx: AppContext,
  opts: { start?: Date; end?: Date; language?: 'en' | 'ar' } = {},
): Promise<ReportDto> {
  const end = opts.end ?? new Date();
  const start = opts.start ?? new Date(end.getTime() - 24 * 60 * 60 * 1000);
  const language = opts.language ?? ctx.cfg.REPORT_LANGUAGE;
  const stats = await computeStats(ctx, start, end);
  const highlights = await ctx.db.query<{ contact: string; summary: string; priority: string }>(
    `SELECT coalesce(c.name, c.wa_id) AS contact, a.summary, a.priority
     FROM message_analyses a JOIN messages m ON m.id = a.message_id
     JOIN conversations cv ON cv.id = m.conversation_id JOIN contacts c ON c.id = cv.contact_id
     WHERE m.created_at >= $1 AND m.created_at < $2 AND a.priority IN ('urgent', 'high')
     ORDER BY array_position(ARRAY['urgent','high'], a.priority), m.created_at DESC LIMIT 15`,
    [start, end],
  );
  const fmt = (d: Date) => d.toISOString().slice(0, 16).replace('T', ' ');
  const narrative = await ctx.ai.reportNarrative({
    stats,
    highlights: highlights.rows,
    language,
    periodLabel: `${fmt(start)} – ${fmt(end)} UTC`,
  });
  const { rows } = await ctx.db.query<ReportRow>(
    `INSERT INTO reports (period_start, period_end, language, stats, narrative) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [start, end, language, JSON.stringify(stats), narrative],
  );
  return toDto(rows[0]!);
}

export async function listReports(ctx: AppContext, limit = 30): Promise<ReportDto[]> {
  const { rows } = await ctx.db.query<ReportRow>('SELECT * FROM reports ORDER BY created_at DESC LIMIT $1', [limit]);
  return rows.map(toDto);
}

export async function getReport(ctx: AppContext, id: string): Promise<ReportDto> {
  const { rows } = await ctx.db.query<ReportRow>('SELECT * FROM reports WHERE id = $1', [id]);
  if (!rows[0]) throw notFound('Report');
  return toDto(rows[0]);
}
