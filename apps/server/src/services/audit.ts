import type { Queryable } from '../db/db.ts';

export interface Actor {
  type: 'user' | 'token' | 'system';
  id: string | null;
  /** The user behind the action (token owner for MCP calls). */
  userId: string | null;
  role: 'admin' | 'agent' | 'viewer' | null;
  scopes?: string[];
  ip?: string;
}

export const SYSTEM: Actor = { type: 'system', id: null, userId: null, role: null };

export async function audit(
  db: Queryable,
  actor: Actor,
  action: string,
  target?: { type: string; id: string },
  details?: Record<string, unknown>,
): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, details, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [actor.type, actor.id, action, target?.type ?? null, target?.id ?? null, details ? JSON.stringify(details) : null, actor.ip ?? null],
  );
}
