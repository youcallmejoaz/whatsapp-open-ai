// Import a WhatsApp "Export chat" (.txt, without media) for one customer.
//   pnpm import-chat --file ~/Downloads/chat.txt --phone +971501234567 --me "Zaatar & Co." [--name "Ali"] [--month-first]
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.ts';
import { createAi, createWhatsApp, loadBusinessProfile, type AppContext } from '../src/context.ts';
import { createDb } from '../src/db/db.ts';
import { jobHandlers } from '../src/jobs.ts';
import { InlineQueue } from '../src/queue.ts';
import { importChat } from '../src/services/chat-import.ts';

const { values } = parseArgs({
  options: {
    file: { type: 'string' },
    phone: { type: 'string' },
    me: { type: 'string' },
    name: { type: 'string' },
    'month-first': { type: 'boolean', default: false },
  },
});
if (!values.file || !values.phone || !values.me) {
  console.error('usage: import-chat --file chat.txt --phone +9715... --me "<your name as it appears in the export>"');
  process.exit(1);
}

const cfg = loadConfig();
const db = createDb(cfg.DATABASE_URL);
const queue = new InlineQueue();
const ctx: AppContext = {
  cfg,
  db,
  ai: createAi(cfg),
  wa: createWhatsApp(cfg, db),
  queue,
  log: console as unknown as AppContext['log'],
  businessProfile: loadBusinessProfile(cfg),
};
await queue.register(jobHandlers(ctx));
const result = await importChat(ctx, {
  raw: await readFile(values.file, 'utf8'),
  customerPhone: values.phone,
  businessAuthor: values.me,
  customerName: values.name,
  dayFirst: !values['month-first'],
});
console.log(result);
await db.end();
