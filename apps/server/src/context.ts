import { readFileSync } from 'node:fs';
import type { FastifyBaseLogger } from 'fastify';
import type { AiProvider } from './ai/provider.ts';
import { MockAiProvider } from './ai/mock.ts';
import { OpenAiProvider } from './ai/openai.ts';
import type { Config } from './config.ts';
import type { Db } from './db/db.ts';
import type { JobQueue } from './queue.ts';
import { GraphWhatsAppClient, MockWhatsAppClient, type WhatsAppClient } from './whatsapp/client.ts';

export interface AppContext {
  cfg: Config;
  db: Db;
  ai: AiProvider;
  wa: WhatsAppClient;
  queue: JobQueue;
  log: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error' | 'debug'>;
  businessProfile: string;
}

const DEFAULT_PROFILE_URL = new URL('../business-profile.example.md', import.meta.url);

export function loadBusinessProfile(cfg: Config): string {
  return readFileSync(cfg.BUSINESS_PROFILE_FILE || DEFAULT_PROFILE_URL, 'utf8');
}

export function createAi(cfg: Config): AiProvider {
  return cfg.AI_PROVIDER === 'openai' ? new OpenAiProvider(cfg) : new MockAiProvider();
}

export function createWhatsApp(cfg: Config, db: Db): WhatsAppClient {
  return cfg.WA_MODE === 'live' ? new GraphWhatsAppClient(cfg) : new MockWhatsAppClient(db);
}
