import { createHash } from 'node:crypto';
import type { AppContext } from '../context.ts';
import { tx } from '../db/db.ts';
import { ingestMessage } from './ingest.ts';

// Import WhatsApp "Export chat" .txt files. The Cloud API cannot read chats
// that happened before onboarding (outside coexistence history sync), but the
// phone app can export any 1:1 or group chat, which we index for search and
// summaries. Group exports keep the author per line.

export interface ExportLine {
  at: Date;
  author: string;
  text: string;
}

const INVISIBLE = /[\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;
// Android: "31/12/2023, 21:15 - Name: text"   iOS: "[31/12/2023, 21:15:03] Name: text"
const DATE_PREFIX = /^\[?\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4},?\s+\d{1,2}:\d{2}/;
const LINE = /^\[?(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp]\.?[Mm]\.?|ص|م)?\]?\s*(?:-\s*)?([^:]+?):\s([\s\S]*)$/;

function toAscii(s: string): string {
  return s
    .replace(INVISIBLE, '')
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/،/g, ',')
    .replace(/\u202F|\u00A0/g, ' ');
}

/**
 * Parse an export. Day/month order differs by phone locale; we infer it from
 * the data (a first field > 12 means day-first) and fall back to `dayFirst`.
 */
export function parseWhatsAppExport(raw: string, opts: { dayFirst?: boolean } = {}): ExportLine[] {
  const rows: { parts: string[]; text: string }[] = [];
  for (const original of raw.split(/\r?\n/)) {
    const line = toAscii(original);
    const m = LINE.exec(line);
    if (m) {
      rows.push({ parts: m.slice(1, 9) as string[], text: m[9] ?? '' });
    } else if (DATE_PREFIX.test(line)) {
      // System line ("Messages are end-to-end encrypted", "X joined"): no author, skip.
      continue;
    } else if (rows.length && original.trim()) {
      rows.at(-1)!.text += '\n' + original.replace(INVISIBLE, '');
    }
  }

  const firsts = rows.map((r) => Number(r.parts[0]));
  const seconds = rows.map((r) => Number(r.parts[1]));
  const yearFirst = firsts.some((n) => n > 31);
  const dayFirst = yearFirst ? false : firsts.some((n) => n > 12) ? true : seconds.some((n) => n > 12) ? false : (opts.dayFirst ?? true);

  const out: ExportLine[] = [];
  for (const { parts, text } of rows) {
    const [a, b, c, hh, mm, ss, ampm, author] = parts;
    let year: number, month: number, day: number;
    if (yearFirst) [year, month, day] = [Number(a), Number(b), Number(c)];
    else if (dayFirst) [day, month, year] = [Number(a), Number(b), Number(c)];
    else [month, day, year] = [Number(a), Number(b), Number(c)];
    if (year < 100) year += 2000;
    let hour = Number(hh);
    const marker = ampm?.toLowerCase().replace(/\./g, '');
    if ((marker === 'pm' || marker === 'م') && hour < 12) hour += 12;
    if ((marker === 'am' || marker === 'ص') && hour === 12) hour = 0;
    const at = new Date(year, month - 1, day, hour, Number(mm), Number(ss ?? 0));
    if (Number.isNaN(at.getTime())) continue;
    out.push({ at, author: author!.trim(), text: text.trim() });
  }
  return out;
}

const MEDIA_OMITTED = /^(<Media omitted>|<الوسائط محذوفة>|.*\(file attached\)|image omitted|audio omitted|video omitted|sticker omitted)$/i;

/** Store an exported 1:1 chat as messages (source "import"), idempotently. */
export async function importChat(
  ctx: AppContext,
  opts: { raw: string; customerPhone: string; businessAuthor: string; customerName?: string; dayFirst?: boolean },
): Promise<{ imported: number; skipped: number }> {
  const lines = parseWhatsAppExport(opts.raw, { dayFirst: opts.dayFirst });
  const waId = opts.customerPhone.replace(/\D/g, '');
  const ids: string[] = [];
  let skipped = 0;
  await tx(ctx.db, async (c) => {
    for (const [i, l] of lines.entries()) {
      const out = l.author === opts.businessAuthor;
      const media = MEDIA_OMITTED.test(l.text);
      const key = createHash('sha1').update(`${waId}|${l.at.toISOString()}|${l.author}|${i}|${l.text}`).digest('hex');
      const stored = await ingestMessage(c, {
        source: 'import',
        direction: out ? 'out' : 'in',
        waId,
        contactName: out ? null : (opts.customerName ?? l.author),
        waMessageId: `import:${key}`,
        timestamp: l.at,
        type: media ? 'media' : 'text',
        text: media ? null : l.text,
      });
      if (stored) ids.push(stored.id);
      else skipped++;
    }
  });
  // Embed for search; no triage for historical messages.
  for (const id of ids) await ctx.queue.send('message.analyze', { messageId: id, triage: false });
  return { imported: ids.length, skipped };
}
