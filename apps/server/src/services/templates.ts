import type { TemplateDto } from '@wa/shared';
import type { AppContext } from '../context.ts';
import { tx } from '../db/db.ts';

interface TemplateRow {
  name: string;
  language: string;
  category: string;
  status: string;
  body: string;
  param_count: number;
}

const toDto = (r: TemplateRow): TemplateDto => ({
  name: r.name,
  language: r.language,
  category: r.category,
  status: r.status,
  body: r.body,
  paramCount: r.param_count,
});

/** Mirror the WABA's message templates locally (they are managed in Meta's UI). */
export async function syncTemplates(ctx: AppContext): Promise<number> {
  const remote = await ctx.wa.listTemplates();
  await tx(ctx.db, async (c) => {
    await c.query('DELETE FROM templates');
    for (const t of remote) {
      await c.query(
        `INSERT INTO templates (name, language, category, status, body, param_count, components)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (name, language) DO NOTHING`,
        [t.name, t.language, t.category, t.status, t.body, t.paramCount, JSON.stringify(t.components ?? [])],
      );
    }
  });
  return remote.length;
}

export async function listTemplates(ctx: AppContext, opts: { approvedOnly?: boolean } = {}): Promise<TemplateDto[]> {
  const { rows } = await ctx.db.query<TemplateRow>(
    `SELECT * FROM templates WHERE ($1::boolean = false OR status = 'APPROVED') ORDER BY name, language`,
    [opts.approvedOnly ?? true],
  );
  return rows.map(toDto);
}

export async function getTemplate(ctx: AppContext, name: string, language: string): Promise<TemplateDto | null> {
  const { rows } = await ctx.db.query<TemplateRow>(
    `SELECT * FROM templates WHERE name = $1 AND language = $2 AND status = 'APPROVED'`,
    [name, language],
  );
  return rows[0] ? toDto(rows[0]) : null;
}
