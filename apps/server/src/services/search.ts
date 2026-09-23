import { normalizeArabic, type SearchHit } from '@wa/shared';
import type { AppContext } from '../context.ts';
import { toVector } from '../db/db.ts';

export interface SearchParams {
  query: string;
  conversationId?: string;
  waId?: string;
  since?: Date;
  until?: Date;
  direction?: 'in' | 'out';
  limit?: number;
}

// Reciprocal rank fusion constant; 60 is the value from the original RRF paper.
const RRF_K = 60;
// Cosine distance cut-off so semantic search does not return unrelated noise.
const MAX_VECTOR_DISTANCE = 0.75;

/**
 * Hybrid search: Postgres full-text (exact words, order numbers, names) fused
 * with pgvector similarity (paraphrases, cross-language matches such as
 * "late delivery" ↔ "الطلب متأخر").
 */
export async function searchMessages(ctx: AppContext, p: SearchParams): Promise<SearchHit[]> {
  const query = p.query.trim();
  if (!query) return [];
  const normalized = normalizeArabic(query);
  const [embedding] = await ctx.ai.embed([query]);
  const limit = Math.min(p.limit ?? 20, 100);

  const { rows } = await ctx.db.query<{
    id: string;
    conversation_id: string;
    contact_name: string | null;
    wa_id: string;
    text: string;
    direction: 'in' | 'out';
    created_at: Date;
    score: number;
  }>(
    `WITH filtered AS (
       SELECT m.id, m.search, m.embedding
       FROM messages m
       JOIN conversations cv ON cv.id = m.conversation_id
       JOIN contacts c ON c.id = cv.contact_id
       WHERE ($3::uuid IS NULL OR m.conversation_id = $3)
         AND ($4::text IS NULL OR c.wa_id = $4)
         AND ($5::timestamptz IS NULL OR m.created_at >= $5)
         AND ($6::timestamptz IS NULL OR m.created_at < $6)
         AND ($7::text IS NULL OR m.direction = $7)
         AND coalesce(m.text, m.transcript) IS NOT NULL
     ),
     q AS (
       SELECT websearch_to_tsquery('simple', $1) || websearch_to_tsquery('arabic', $1)
              || websearch_to_tsquery('english', $1) AS tsq
     ),
     fts AS (
       SELECT f.id, row_number() OVER (ORDER BY ts_rank_cd(f.search, q.tsq) DESC) AS r
       FROM filtered f, q WHERE f.search @@ q.tsq
       ORDER BY r LIMIT 50
     ),
     vec AS (
       SELECT id, row_number() OVER (ORDER BY embedding <=> $2::vector) AS r
       FROM filtered
       WHERE $2::vector IS NOT NULL AND embedding IS NOT NULL AND (embedding <=> $2::vector) < ${MAX_VECTOR_DISTANCE}
       ORDER BY embedding <=> $2::vector LIMIT 50
     )
     SELECT m.id, m.conversation_id, c.name AS contact_name, c.wa_id, coalesce(m.text, m.transcript) AS text,
            m.direction, m.created_at,
            coalesce(1.0 / (${RRF_K} + fts.r), 0) + coalesce(1.0 / (${RRF_K} + vec.r), 0) AS score
     FROM fts FULL OUTER JOIN vec USING (id)
     JOIN messages m ON m.id = coalesce(fts.id, vec.id)
     JOIN conversations cv ON cv.id = m.conversation_id
     JOIN contacts c ON c.id = cv.contact_id
     ORDER BY score DESC, m.created_at DESC
     LIMIT $8`,
    [
      normalized,
      embedding ? toVector(embedding) : null,
      p.conversationId ?? null,
      p.waId ?? null,
      p.since ?? null,
      p.until ?? null,
      p.direction ?? null,
      limit,
    ],
  );

  return rows.map((r) => ({
    messageId: r.id,
    conversationId: r.conversation_id,
    contactName: r.contact_name,
    waId: r.wa_id,
    text: r.text,
    direction: r.direction,
    createdAt: r.created_at.toISOString(),
    score: Number(r.score),
  }));
}
