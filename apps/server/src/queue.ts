import { PgBoss } from 'pg-boss';

export interface JobPayloads {
  'webhook.process': { eventId: number };
  'message.analyze': { messageId: string; triage: boolean };
  'draft.generate': { conversationId: string };
  'report.generate': { periodHours?: number };
  'templates.sync': Record<string, never>;
  'retention.cleanup': Record<string, never>;
}
export type JobName = keyof JobPayloads;
export type JobHandlers = { [K in JobName]: (data: JobPayloads[K]) => Promise<void> };

export const JOB_NAMES: JobName[] = [
  'webhook.process',
  'message.analyze',
  'draft.generate',
  'report.generate',
  'templates.sync',
  'retention.cleanup',
];

export interface JobQueue {
  send<K extends JobName>(name: K, data: JobPayloads[K], opts?: { singletonKey?: string }): Promise<void>;
  register(handlers: JobHandlers): Promise<void>;
  schedule(name: JobName, cron: string, tz: string): Promise<void>;
  stop(): Promise<void>;
}

/** Durable queue on Postgres (pg-boss): retries with backoff, no Redis needed. */
export class PgBossQueue implements JobQueue {
  private readonly boss: PgBoss;
  private readonly onError: (err: unknown) => void;
  private started = false;

  constructor(connectionString: string, onError: (err: unknown) => void) {
    this.boss = new PgBoss(connectionString);
    this.onError = onError;
    this.boss.on('error', onError);
  }

  private async ensureStarted() {
    if (this.started) return;
    await this.boss.start();
    for (const name of JOB_NAMES) {
      await this.boss.createQueue(name, { retryLimit: 5, retryDelay: 5, retryBackoff: true });
    }
    this.started = true;
  }

  async send<K extends JobName>(name: K, data: JobPayloads[K], opts?: { singletonKey?: string }) {
    await this.ensureStarted();
    await this.boss.send(name, data as object, opts?.singletonKey ? { singletonKey: opts.singletonKey } : {});
  }

  async register(handlers: JobHandlers) {
    await this.ensureStarted();
    for (const name of JOB_NAMES) {
      const handler = handlers[name] as (d: unknown) => Promise<void>;
      await this.boss.work(name, { localConcurrency: name === 'message.analyze' ? 4 : 1 }, async (jobs) => {
        for (const job of jobs) {
          try {
            await handler(job.data);
          } catch (err) {
            this.onError(err);
            throw err; // let pg-boss retry
          }
        }
      });
    }
  }

  async schedule(name: JobName, cron: string, tz: string) {
    await this.ensureStarted();
    await this.boss.schedule(name, cron, {}, { tz });
  }

  async stop() {
    if (this.started) await this.boss.stop({ graceful: true });
  }
}

/**
 * Runs jobs in-process and synchronously. Used by tests and the seed script
 * so a single call exercises the whole pipeline deterministically.
 */
export class InlineQueue implements JobQueue {
  private handlers: JobHandlers | null = null;
  readonly sent: { name: JobName; data: unknown }[] = [];

  async send<K extends JobName>(name: K, data: JobPayloads[K]) {
    this.sent.push({ name, data });
    if (!this.handlers) throw new Error('InlineQueue: no handlers registered');
    await this.handlers[name](data);
  }

  async register(handlers: JobHandlers) {
    this.handlers = handlers;
  }

  async schedule() {}
  async stop() {}
}
