import type { AppContext } from '../context.ts';
import { audit, SYSTEM } from './audit.ts';

/** Delete message content older than RETENTION_DAYS (0 = keep forever) and old raw webhooks. */
export async function runRetention(ctx: AppContext): Promise<{ messages: number; webhooks: number }> {
  const webhooks = await ctx.db.query(
    `DELETE FROM webhook_events WHERE processed_at IS NOT NULL AND received_at < now() - interval '30 days'`,
  );
  let messages = 0;
  if (ctx.cfg.RETENTION_DAYS > 0) {
    const res = await ctx.db.query(`DELETE FROM messages WHERE created_at < now() - make_interval(days => $1)`, [
      ctx.cfg.RETENTION_DAYS,
    ]);
    messages = res.rowCount ?? 0;
  }
  const result = { messages, webhooks: webhooks.rowCount ?? 0 };
  if (result.messages || result.webhooks) await audit(ctx.db, SYSTEM, 'retention.cleanup', undefined, result);
  return result;
}
