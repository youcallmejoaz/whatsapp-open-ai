import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Role } from '@wa/shared';
import type { AppContext } from '../context.ts';
import type { Db } from '../db/db.ts';
import { AppError } from '../errors.ts';
import { audit, SYSTEM, type Actor } from './audit.ts';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, keylen: number) => Promise<Buffer>;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, saltB64, hashB64] = stored.split('$');
  if (algo !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length);
  return timingSafeEqual(expected, actual);
}

// Session and API tokens are random; only their SHA-256 is stored, so a
// database leak does not leak usable credentials.
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const randomToken = (prefix: string) => prefix + randomBytes(32).toString('base64url');

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export async function ensureAdmin(ctx: AppContext): Promise<void> {
  const { rowCount } = await ctx.db.query('SELECT 1 FROM users LIMIT 1');
  if (rowCount) return;
  await createUser(ctx.db, { email: ctx.cfg.ADMIN_EMAIL, name: 'Admin', role: 'admin', password: ctx.cfg.ADMIN_PASSWORD });
  await audit(ctx.db, SYSTEM, 'user.bootstrap_admin', undefined, { email: ctx.cfg.ADMIN_EMAIL });
  ctx.log.info({ email: ctx.cfg.ADMIN_EMAIL }, 'created initial admin user');
}

export async function createUser(
  db: Db,
  u: { email: string; name: string; role: Role; password: string },
): Promise<SessionUser> {
  const { rows } = await db.query<SessionUser>(
    `INSERT INTO users (email, name, role, password_hash) VALUES (lower($1), $2, $3, $4)
     ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
     RETURNING id, email, name, role`,
    [u.email, u.name, u.role, await hashPassword(u.password)],
  );
  return rows[0]!;
}

export async function login(ctx: AppContext, email: string, password: string, ip?: string): Promise<{ token: string; user: SessionUser }> {
  const { rows } = await ctx.db.query<SessionUser & { password_hash: string }>(
    'SELECT id, email, name, role, password_hash FROM users WHERE email = lower($1)',
    [email],
  );
  const row = rows[0];
  // Always run scrypt so response time does not reveal whether the email exists.
  const ok = await verifyPassword(password, row?.password_hash ?? 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(86) + '==');
  if (!row || !ok) {
    await audit(ctx.db, { ...SYSTEM, ip }, 'auth.login_failed', undefined, { email });
    throw new AppError(401, 'BAD_CREDENTIALS', 'Invalid email or password');
  }
  const token = randomToken('wss_');
  await ctx.db.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(hours => $3))`,
    [sha256(token), row.id, ctx.cfg.SESSION_TTL_HOURS],
  );
  const user = { id: row.id, email: row.email, name: row.name, role: row.role };
  await audit(ctx.db, { type: 'user', id: user.id, userId: user.id, role: user.role, ip }, 'auth.login');
  return { token, user };
}

export async function logout(db: Db, token: string): Promise<void> {
  await db.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
}

export async function userForSession(db: Db, token: string): Promise<SessionUser | null> {
  const { rows } = await db.query<SessionUser>(
    `SELECT u.id, u.email, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [sha256(token)],
  );
  return rows[0] ?? null;
}

export const TOKEN_SCOPES = ['read', 'draft'] as const;

export async function createApiToken(
  db: Db,
  actor: Actor,
  opts: { userId: string; name: string; scopes: string[] },
): Promise<{ id: string; token: string }> {
  const scopes = opts.scopes.filter((s) => (TOKEN_SCOPES as readonly string[]).includes(s));
  const token = randomToken('wat_');
  const { rows } = await db.query<{ id: string }>(
    'INSERT INTO api_tokens (user_id, name, token_hash, scopes) VALUES ($1, $2, $3, $4) RETURNING id',
    [opts.userId, opts.name, sha256(token), scopes],
  );
  await audit(db, actor, 'token.create', { type: 'api_token', id: rows[0]!.id }, { name: opts.name, scopes });
  return { id: rows[0]!.id, token };
}

export async function listApiTokens(db: Db, userId: string) {
  const { rows } = await db.query(
    `SELECT id, name, scopes, created_at AS "createdAt", last_used_at AS "lastUsedAt"
     FROM api_tokens WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC`,
    [userId],
  );
  return rows;
}

export async function revokeApiToken(db: Db, actor: Actor, id: string): Promise<void> {
  const res = await db.query(
    `UPDATE api_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL AND (user_id = $2 OR $3)`,
    [id, actor.userId, actor.role === 'admin'],
  );
  if (!res.rowCount) throw new AppError(404, 'NOT_FOUND', 'Token not found');
  await audit(db, actor, 'token.revoke', { type: 'api_token', id });
}

/** Resolve a bearer token to an actor (MCP / API clients). */
export async function actorForApiToken(db: Db, token: string, ip?: string): Promise<Actor | null> {
  const { rows } = await db.query<{ id: string; user_id: string; role: Role; scopes: string[] }>(
    `UPDATE api_tokens t SET last_used_at = now()
     FROM users u
     WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND u.id = t.user_id
     RETURNING t.id, t.user_id, u.role, t.scopes`,
    [sha256(token)],
  );
  const r = rows[0];
  if (!r) return null;
  return { type: 'token', id: r.id, userId: r.user_id, role: r.role, scopes: r.scopes, ip };
}
