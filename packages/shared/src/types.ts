import { z } from 'zod';

export const PRIORITIES = ['urgent', 'high', 'normal', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const INTENTS = [
  'order', 'complaint', 'question', 'booking', 'payment', 'support',
  'feedback', 'greeting', 'spam', 'other',
] as const;
export type Intent = (typeof INTENTS)[number];

/** Structured output the model must return for every inbound message. */
export const TriageSchema = z.object({
  priority: z.enum(PRIORITIES),
  needs_reply: z.boolean().describe('True if the business owes the customer a response.'),
  intent: z.enum(INTENTS),
  sentiment: z.enum(['positive', 'neutral', 'negative']),
  language: z.string().describe('BCP-47 code of the customer message, e.g. "ar", "ar-EG", "en".'),
  summary: z.string().describe('One short sentence, in the business reporting language.'),
  action_items: z.array(z.string()).describe('Concrete follow-ups for staff. Empty if none.'),
  reason: z.string().describe('Why this priority was chosen, max 20 words.'),
});
export type Triage = z.infer<typeof TriageSchema>;

export const ConversationSummarySchema = z.object({
  summary: z.string(),
  open_questions: z.array(z.string()),
  action_items: z.array(z.string()),
  customer_mood: z.enum(['positive', 'neutral', 'negative', 'mixed']),
});
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;

export type DraftState = 'pending' | 'approved' | 'sent' | 'rejected' | 'failed';
export type DraftSource = 'ai' | 'user' | 'mcp';
export type Role = 'admin' | 'agent' | 'viewer';

export interface ConversationListItem {
  id: string;
  contact: { id: string; waId: string; name: string | null };
  lastMessageAt: string | null;
  lastInboundAt: string | null;
  windowOpen: boolean;
  lastText: string | null;
  priority: Priority | null;
  needsReply: boolean;
  intent: Intent | null;
  pendingDrafts: number;
  unread: number;
}

export interface MessageDto {
  id: string;
  waMessageId: string;
  direction: 'in' | 'out';
  type: string;
  text: string | null;
  transcript: string | null;
  status: string | null;
  source: string;
  createdAt: string;
  triage: Triage | null;
}

export interface DraftDto {
  id: string;
  conversationId: string;
  state: DraftState;
  source: DraftSource;
  body: string | null;
  template: { name: string; language: string; params: string[] } | null;
  rationale: string | null;
  createdBy: string | null;
  decidedBy: string | null;
  error: string | null;
  createdAt: string;
  decidedAt: string | null;
  sentAt: string | null;
}

export interface ConversationDetail {
  conversation: ConversationListItem;
  messages: MessageDto[];
  drafts: DraftDto[];
  summary: (ConversationSummary & { updatedAt: string }) | null;
}

export interface SearchHit {
  messageId: string;
  conversationId: string;
  contactName: string | null;
  waId: string;
  text: string;
  direction: 'in' | 'out';
  createdAt: string;
  score: number;
}

export interface TemplateDto {
  name: string;
  language: string;
  category: string;
  status: string;
  body: string;
  paramCount: number;
}

export interface ReportDto {
  id: string;
  periodStart: string;
  periodEnd: string;
  language: string;
  createdAt: string;
  stats: ReportStats;
  narrative: string;
}

export interface ReportStats {
  inbound: number;
  outbound: number;
  conversations: number;
  newContacts: number;
  needsReplyOpen: number;
  urgentOpen: number;
  medianFirstResponseMinutes: number | null;
  byIntent: Record<string, number>;
  byPriority: Record<string, number>;
  bySentiment: Record<string, number>;
  actionItems: { conversationId: string; contact: string; item: string }[];
}
