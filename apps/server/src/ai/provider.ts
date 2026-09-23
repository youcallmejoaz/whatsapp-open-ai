import type { ConversationSummary, ReportStats, Triage } from '@wa/shared';

export interface ChatLine {
  direction: 'in' | 'out';
  text: string;
  at: string; // ISO timestamp
}

export interface TriageInput {
  message: string;
  history: ChatLine[];
  contactName: string | null;
  businessProfile: string;
  reportLanguage: 'en' | 'ar';
}

export interface SummarizeInput {
  messages: ChatLine[];
  contactName: string | null;
  businessProfile: string;
  language: 'en' | 'ar';
}

export interface DraftInput {
  messages: ChatLine[];
  contactName: string | null;
  businessProfile: string;
  /** Extra guidance from staff or the MCP client, e.g. "offer a 10% discount". */
  instructions?: string;
}

export interface DraftOutput {
  body: string;
  language: string;
  rationale: string;
}

export interface ReportInput {
  stats: ReportStats;
  highlights: { contact: string; summary: string; priority: string }[];
  language: 'en' | 'ar';
  periodLabel: string;
}

export const EMBEDDING_DIM = 1536;

/** Everything the app needs from a language model. Implementations never send messages. */
export interface AiProvider {
  readonly name: string;
  triage(input: TriageInput): Promise<Triage>;
  summarize(input: SummarizeInput): Promise<ConversationSummary>;
  draftReply(input: DraftInput): Promise<DraftOutput>;
  reportNarrative(input: ReportInput): Promise<string>;
  embed(texts: string[]): Promise<number[][]>;
  transcribe(audio: Buffer, mimeType: string): Promise<string>;
}
