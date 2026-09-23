import type { AppContext } from './context.ts';
import type { JobHandlers } from './queue.ts';
import { analyzeMessage } from './services/analyze.ts';
import { autoDraft } from './services/drafts.ts';
import { processWebhookEvent } from './services/ingest.ts';
import { generateReport } from './services/reports.ts';
import { runRetention } from './services/retention.ts';
import { syncTemplates } from './services/templates.ts';

export function jobHandlers(ctx: AppContext): JobHandlers {
  return {
    'webhook.process': ({ eventId }) => processWebhookEvent(ctx, eventId),
    'message.analyze': ({ messageId, triage }) => analyzeMessage(ctx, messageId, triage),
    'draft.generate': ({ conversationId }) => autoDraft(ctx, conversationId),
    'report.generate': async ({ periodHours }) => {
      const end = new Date();
      await generateReport(ctx, { start: new Date(end.getTime() - (periodHours ?? 24) * 3600_000), end });
    },
    'templates.sync': async () => {
      await syncTemplates(ctx);
    },
    'retention.cleanup': async () => {
      await runRetention(ctx);
    },
  };
}
