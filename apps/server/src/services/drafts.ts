import type { DraftDto, DraftSource } from '@wa/shared';
import type { AppContext } from '../context.ts';
import { tx } from '../db/db.ts';
import { AppError, notFound } from '../errors.ts';
import { MAX_TEXT_LENGTH, WhatsAppApiError } from '../whatsapp/client.ts';
import { chatLines } from './analyze.ts';
import { audit, SYSTEM, type Actor } from './audit.ts';
import { ingestMessage } from './ingest.ts';
import { getTemplate } from './templates.ts';

// Draft lifecycle:  pending ──approve──▶ approved ──send ok──▶ sent
//                      │                     └──send error──▶ failed ──retry──▶ pending
//                      └──reject──▶ rejected
// approveAndSend() is the ONLY code path that calls WhatsAppClient.send*.

export const WINDOW_MS = 24 * 60 * 60 * 1000;

interface DraftRow {
  id: string;
  conversation_id: string;
  state: DraftDto['state'];
  source: DraftSource;
  body: string | null;
  template_name: string | null;
  template_language: string | null;
  template_params: string[] | null;
  rationale: string | null;
  reply_to_wa_id: string | null;
  sent_message_id: string | null;
  created_by: string | null;
  decided_by: string | null;
  error: string | null;
  created_at: Date;
  decided_at: Date | null;
  sent_at: Date | null;
}

export function toDraftDto(r: DraftRow): DraftDto {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    state: r.state,
    source: r.source,
    body: r.body,
    template: r.template_name
      ? { name: r.template_name, language: r.template_language ?? 'en', params: r.template_params ?? [] }
      : null,
    rationale: r.rationale,
    createdBy: r.created_by,
    decidedBy: r.decided_by,
    error: r.error,
    createdAt: r.created_at.toISOString(),
    decidedAt: r.decided_at?.toISOString() ?? null,
    sentAt: r.sent_at?.toISOString() ?? null,
  };
}

export const windowOpen = (lastInboundAt: Date | null, now = Date.now()) =>
  !!lastInboundAt && now - lastInboundAt.getTime() < WINDOW_MS;

function requireWriter(actor: Actor) {
  if (actor.type === 'system') return;
  if (actor.role === 'viewer') throw new AppError(403, 'FORBIDDEN', 'Viewers cannot create or change drafts');
  if (actor.type === 'token' && !actor.scopes?.includes('draft')) {
    throw new AppError(403, 'FORBIDDEN', 'Token lacks the "draft" scope');
  }
}

export interface NewDraft {
  conversationId: string;
  source: DraftSource;
  body?: string;
  template?: { name: string; language: string; params: string[] };
  rationale?: string | null;
}

export async function createDraft(ctx: AppContext, actor: Actor, d: NewDraft): Promise<DraftDto> {
  requireWriter(actor);
  if (!!d.body === !!d.template) throw new AppError(400, 'BAD_DRAFT', 'Provide either body or template');
  if (d.body !== undefined) {
    if (!d.body.trim()) throw new AppError(400, 'BAD_DRAFT', 'Body is empty');
    if (d.body.length > MAX_TEXT_LENGTH) throw new AppError(400, 'BAD_DRAFT', `Body exceeds ${MAX_TEXT_LENGTH} characters`);
  }
  if (d.template) {
    const t = await getTemplate(ctx, d.template.name, d.template.language);
    if (!t) throw new AppError(400, 'UNKNOWN_TEMPLATE', `No approved template ${d.template.name} (${d.template.language})`);
    if (t.paramCount !== d.template.params.length) {
      throw new AppError(400, 'TEMPLATE_PARAMS', `Template ${t.name} expects ${t.paramCount} parameter(s)`);
    }
  }
  const conv = await ctx.db.query('SELECT 1 FROM conversations WHERE id = $1', [d.conversationId]);
  if (!conv.rowCount) throw notFound('Conversation');

  const { rows } = await ctx.db.query<DraftRow>(
    `INSERT INTO drafts (conversation_id, state, source, body, template_name, template_language, template_params,
                         rationale, reply_to_wa_id, created_by)
     VALUES ($1, 'pending', $2, $3, $4, $5, $6, $7,
             (SELECT wa_message_id FROM messages WHERE conversation_id = $1 AND direction = 'in'
              ORDER BY created_at DESC LIMIT 1),
             $8)
     RETURNING *`,
    [
      d.conversationId,
      d.source,
      d.body ?? null,
      d.template?.name ?? null,
      d.template?.language ?? null,
      d.template ? JSON.stringify(d.template.params) : null,
      d.rationale ?? null,
      actor.userId,
    ],
  );
  const draft = rows[0]!;
  await audit(ctx.db, actor, 'draft.create', { type: 'draft', id: draft.id }, { source: d.source, template: d.template?.name });
  return toDraftDto(draft);
}

/** Ask the model for a reply in the customer's language and store it as a pending draft. */
export async function generateDraft(
  ctx: AppContext,
  actor: Actor,
  conversationId: string,
  opts: { instructions?: string; source?: DraftSource } = {},
): Promise<DraftDto> {
  requireWriter(actor);
  const { rows } = await ctx.db.query<{ name: string | null }>(
    `SELECT c.name FROM conversations cv JOIN contacts c ON c.id = cv.contact_id WHERE cv.id = $1`,
    [conversationId],
  );
  if (!rows[0]) throw notFound('Conversation');
  const messages = await chatLines(ctx.db, conversationId, { limit: 20 });
  const out = await ctx.ai.draftReply({
    messages,
    contactName: rows[0].name,
    businessProfile: ctx.businessProfile,
    instructions: opts.instructions,
  });
  return createDraft(ctx, actor, {
    conversationId,
    source: opts.source ?? 'ai',
    body: out.body.slice(0, MAX_TEXT_LENGTH),
    rationale: out.rationale,
  });
}

/** Job handler: auto-draft for a conversation that needs a reply. */
export async function autoDraft(ctx: AppContext, conversationId: string): Promise<void> {
  const pending = await ctx.db.query(`SELECT 1 FROM drafts WHERE conversation_id = $1 AND state = 'pending'`, [conversationId]);
  if (pending.rowCount) return;
  await generateDraft(ctx, SYSTEM, conversationId, { source: 'ai' });
}

async function loadDraft(ctx: AppContext, id: string): Promise<DraftRow> {
  const { rows } = await ctx.db.query<DraftRow>('SELECT * FROM drafts WHERE id = $1', [id]);
  if (!rows[0]) throw notFound('Draft');
  return rows[0];
}

export async function editDraft(ctx: AppContext, actor: Actor, id: string, body: string): Promise<DraftDto> {
  requireWriter(actor);
  if (!body.trim() || body.length > MAX_TEXT_LENGTH) throw new AppError(400, 'BAD_DRAFT', 'Invalid body');
  const { rows } = await ctx.db.query<DraftRow>(
    `UPDATE drafts SET body = $2, updated_at = now() WHERE id = $1 AND state = 'pending' AND template_name IS NULL RETURNING *`,
    [id, body],
  );
  if (!rows[0]) {
    await loadDraft(ctx, id);
    throw new AppError(409, 'NOT_EDITABLE', 'Only pending text drafts can be edited');
  }
  await audit(ctx.db, actor, 'draft.edit', { type: 'draft', id });
  return toDraftDto(rows[0]);
}

export async function rejectDraft(ctx: AppContext, actor: Actor, id: string, reason?: string): Promise<DraftDto> {
  requireApprover(actor);
  const { rows } = await ctx.db.query<DraftRow>(
    `UPDATE drafts SET state = 'rejected', decided_by = $2, decided_at = now(), error = $3, updated_at = now()
     WHERE id = $1 AND state = 'pending' RETURNING *`,
    [id, actor.userId, reason ?? null],
  );
  if (!rows[0]) {
    await loadDraft(ctx, id);
    throw new AppError(409, 'NOT_PENDING', 'Draft is not pending');
  }
  await audit(ctx.db, actor, 'draft.reject', { type: 'draft', id }, reason ? { reason } : undefined);
  return toDraftDto(rows[0]);
}

export async function retryDraft(ctx: AppContext, actor: Actor, id: string): Promise<DraftDto> {
  requireApprover(actor);
  const { rows } = await ctx.db.query<DraftRow>(
    `UPDATE drafts SET state = 'pending', error = NULL, decided_by = NULL, decided_at = NULL, updated_at = now()
     WHERE id = $1 AND state = 'failed' RETURNING *`,
    [id],
  );
  if (!rows[0]) throw new AppError(409, 'NOT_FAILED', 'Only failed drafts can be retried');
  await audit(ctx.db, actor, 'draft.retry', { type: 'draft', id });
  return toDraftDto(rows[0]);
}

function requireApprover(actor: Actor) {
  // Approval is a human decision made in the dashboard. API tokens (MCP /
  // ChatGPT) can never approve, whatever their scopes.
  if (actor.type !== 'user') throw new AppError(403, 'FORBIDDEN', 'Only signed-in users can approve or reject drafts');
  if (actor.role !== 'admin' && actor.role !== 'agent') throw new AppError(403, 'FORBIDDEN', 'Your role cannot approve drafts');
}

/** Approve a pending draft and send it through WhatsApp. */
export async function approveAndSend(ctx: AppContext, actor: Actor, id: string): Promise<DraftDto> {
  requireApprover(actor);

  const claimed = await tx(ctx.db, async (c) => {
    const { rows } = await c.query<DraftRow & { wa_id: string; last_inbound_at: Date | null }>(
      `SELECT d.*, ct.wa_id, cv.last_inbound_at
       FROM drafts d JOIN conversations cv ON cv.id = d.conversation_id JOIN contacts ct ON ct.id = cv.contact_id
       WHERE d.id = $1 FOR UPDATE OF d`,
      [id],
    );
    const d = rows[0];
    if (!d) throw notFound('Draft');
    if (d.state !== 'pending') throw new AppError(409, 'NOT_PENDING', `Draft is ${d.state}`);
    if (d.body && !windowOpen(d.last_inbound_at)) {
      throw new AppError(
        409,
        'WINDOW_CLOSED',
        'The 24-hour customer service window is closed. Send an approved template instead.',
      );
    }
    await c.query(`UPDATE drafts SET state = 'approved', decided_by = $2, decided_at = now(), updated_at = now() WHERE id = $1`, [
      id,
      actor.userId,
    ]);
    await audit(c, actor, 'draft.approve', { type: 'draft', id });
    return d;
  });

  try {
    const sent = claimed.body
      ? await ctx.wa.sendText(claimed.wa_id, claimed.body, claimed.reply_to_wa_id)
      : await ctx.wa.sendTemplate(
          claimed.wa_id,
          claimed.template_name!,
          claimed.template_language ?? 'en',
          claimed.template_params ?? [],
        );
    const text = claimed.body ?? (await renderTemplateText(ctx, claimed));
    const row = await tx(ctx.db, async (c) => {
      const msg = await ingestMessage(c, {
        source: 'api',
        direction: 'out',
        waId: claimed.wa_id,
        waMessageId: sent.waMessageId,
        timestamp: new Date(),
        type: claimed.body ? 'text' : 'template',
        text,
        sentBy: actor.userId,
      });
      const { rows } = await c.query<DraftRow>(
        `UPDATE drafts SET state = 'sent', sent_at = now(), sent_message_id = $2, updated_at = now() WHERE id = $1 RETURNING *`,
        [id, msg?.id ?? null],
      );
      await audit(c, actor, 'message.send', { type: 'draft', id }, { waMessageId: sent.waMessageId, template: claimed.template_name });
      return rows[0]!;
    });
    // Index the outbound message for search; failure here must not undo a successful send.
    if (row.sent_message_id) {
      await ctx.queue
        .send('message.analyze', { messageId: row.sent_message_id, triage: false })
        .catch((e: unknown) => ctx.log.warn({ err: e }, 'could not queue analysis for sent message'));
    }
    return toDraftDto(row);
  } catch (err) {
    const message =
      err instanceof WhatsAppApiError && err.isWindowClosed
        ? '24-hour window closed (WhatsApp error 131047). Use a template.'
        : err instanceof Error
          ? err.message
          : String(err);
    const { rows } = await ctx.db.query<DraftRow>(
      `UPDATE drafts SET state = 'failed', error = $2, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, message],
    );
    await audit(ctx.db, actor, 'message.send_failed', { type: 'draft', id }, { error: message });
    ctx.log.warn({ draftId: id, err: message }, 'send failed');
    return toDraftDto(rows[0]!);
  }
}

async function renderTemplateText(ctx: AppContext, d: DraftRow): Promise<string> {
  const t = await getTemplate(ctx, d.template_name!, d.template_language ?? 'en');
  const params = d.template_params ?? [];
  if (!t) return `[template ${d.template_name}] ${params.join(' | ')}`;
  return t.body.replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n: string) => params[Number(n) - 1] ?? '');
}

export async function listDrafts(
  ctx: AppContext,
  filter: { state?: DraftDto['state']; conversationId?: string; limit?: number },
): Promise<(DraftDto & { contactName: string | null; waId: string })[]> {
  const { rows } = await ctx.db.query<DraftRow & { contact_name: string | null; wa_id: string }>(
    `SELECT d.*, c.name AS contact_name, c.wa_id
     FROM drafts d JOIN conversations cv ON cv.id = d.conversation_id JOIN contacts c ON c.id = cv.contact_id
     WHERE ($1::text IS NULL OR d.state = $1) AND ($2::uuid IS NULL OR d.conversation_id = $2)
     ORDER BY d.created_at DESC LIMIT $3`,
    [filter.state ?? null, filter.conversationId ?? null, filter.limit ?? 100],
  );
  return rows.map((r) => ({ ...toDraftDto(r), contactName: r.contact_name, waId: r.wa_id }));
}
