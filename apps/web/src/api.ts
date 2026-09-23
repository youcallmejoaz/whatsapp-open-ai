import type {
  ConversationDetail,
  ConversationListItem,
  ConversationSummary,
  DraftDto,
  ReportDto,
  Role,
  SearchHit,
  TemplateDto,
} from '@wa/shared';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
      // Required by the server's CSRF check on state-changing requests.
      'X-Requested-With': 'wa-dashboard',
    },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'ERROR', data.message ?? res.statusText);
  return data as T;
}

export interface Me {
  user: { id: string; email: string; name: string; role: Role };
  config: { waMode: 'live' | 'mock'; ai: string; reportLanguage: 'en' | 'ar' };
}

export type InboxFilter = 'needs_reply' | 'urgent' | 'all';
export type Counts = Record<InboxFilter | 'pending_drafts', number>;
export type QueueDraft = DraftDto & { contactName: string | null; waId: string };
export interface ApiToken {
  id: string;
  name: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
}
export interface AuditEntry {
  id: number;
  at: string;
  actorType: string;
  actor: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  details: Record<string, unknown> | null;
}

const q = (params: Record<string, string | number | undefined>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') s.set(k, String(v));
  return s.toString();
};

export const api = {
  me: () => request<Me>('GET', '/auth/me'),
  login: (email: string, password: string) => request<{ user: Me['user'] }>('POST', '/auth/login', { email, password }),
  logout: () => request('POST', '/auth/logout'),

  conversations: (filter: InboxFilter) =>
    request<{ items: ConversationListItem[]; counts: Counts }>('GET', `/conversations?${q({ filter, limit: 100 })}`),
  conversation: (id: string) => request<ConversationDetail>('GET', `/conversations/${id}`),
  summarize: (id: string, opts: { force?: boolean; language?: 'en' | 'ar' }) =>
    request<ConversationSummary & { updatedAt: string; cached: boolean }>('POST', `/conversations/${id}/summary`, opts),

  generateDraft: (conversationId: string, instructions?: string) =>
    request<DraftDto>('POST', `/conversations/${conversationId}/drafts`, { generate: true, instructions: instructions || undefined }),
  createTextDraft: (conversationId: string, body: string) =>
    request<DraftDto>('POST', `/conversations/${conversationId}/drafts`, { body }),
  createTemplateDraft: (conversationId: string, template: { name: string; language: string; params: string[] }) =>
    request<DraftDto>('POST', `/conversations/${conversationId}/drafts`, { template }),
  editDraft: (id: string, body: string) => request<DraftDto>('PATCH', `/drafts/${id}`, { body }),
  approve: (id: string) => request<DraftDto>('POST', `/drafts/${id}/approve`),
  reject: (id: string, reason?: string) => request<DraftDto>('POST', `/drafts/${id}/reject`, { reason }),
  retry: (id: string) => request<DraftDto>('POST', `/drafts/${id}/retry`),
  pendingDrafts: () => request<{ items: QueueDraft[] }>('GET', '/drafts?state=pending'),

  search: (params: { q: string; since?: string; until?: string; direction?: string }) =>
    request<{ items: SearchHit[] }>('GET', `/search?${q(params)}`),

  templates: () => request<{ items: TemplateDto[] }>('GET', '/templates'),
  syncTemplates: () => request<{ synced: number }>('POST', '/templates/sync'),

  reports: () => request<{ items: ReportDto[] }>('GET', '/reports'),
  generateReport: (opts: { since?: string; until?: string; language?: 'en' | 'ar' }) => request<ReportDto>('POST', '/reports', opts),

  tokens: () => request<{ items: ApiToken[] }>('GET', '/tokens'),
  createToken: (name: string, scopes: string[]) =>
    request<{ id: string; token: string; mcpUrl: string }>('POST', '/tokens', { name, scopes }),
  revokeToken: (id: string) => request('DELETE', `/tokens/${id}`),

  audit: () => request<{ items: AuditEntry[] }>('GET', '/audit'),
};
