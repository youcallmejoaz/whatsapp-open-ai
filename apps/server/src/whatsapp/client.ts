import { randomUUID } from 'node:crypto';
import type { Config } from '../config.ts';
import type { Db } from '../db/db.ts';

export interface SendResult {
  waMessageId: string;
}

export interface RemoteTemplate {
  name: string;
  language: string;
  category: string;
  status: string;
  body: string;
  paramCount: number;
  components: unknown;
}

export interface WhatsAppClient {
  sendText(to: string, body: string, replyToWaMessageId?: string | null): Promise<SendResult>;
  sendTemplate(to: string, name: string, language: string, params: string[]): Promise<SendResult>;
  markRead(waMessageId: string): Promise<void>;
  downloadMedia(mediaId: string): Promise<{ data: Buffer; mimeType: string }>;
  listTemplates(): Promise<RemoteTemplate[]>;
}

export class WhatsAppApiError extends Error {
  readonly status: number;
  readonly code: number | undefined;
  constructor(message: string, status: number, code?: number) {
    super(message);
    this.name = 'WhatsAppApiError';
    this.status = status;
    this.code = code;
  }

  /** 131047: more than 24h since the customer last wrote; only templates are allowed. */
  get isWindowClosed(): boolean {
    return this.code === 131047;
  }
}

/** WhatsApp caps free-form text bodies at 4096 characters. */
export const MAX_TEXT_LENGTH = 4096;

function templateBody(components: unknown): { body: string; paramCount: number } {
  const list = Array.isArray(components) ? (components as { type?: string; text?: string }[]) : [];
  const body = list.find((c) => c.type?.toUpperCase() === 'BODY')?.text ?? '';
  const params = new Set(body.match(/\{\{\s*\w+\s*\}\}/g) ?? []);
  return { body, paramCount: params.size };
}

type FetchLike = typeof fetch;

/** Official Meta Graph API (WhatsApp Cloud API) client. */
export class GraphWhatsAppClient implements WhatsAppClient {
  private readonly base: string;
  private readonly cfg: Config;
  private readonly fetchImpl: FetchLike;

  constructor(cfg: Config, fetchImpl: FetchLike = fetch) {
    this.cfg = cfg;
    this.fetchImpl = fetchImpl;
    this.base = `https://graph.facebook.com/${cfg.WA_GRAPH_VERSION}`;
  }

  private async request<T>(url: string, init: RequestInit = {}, attempt = 0): Promise<T> {
    const res = await this.fetchImpl(url.startsWith('http') ? url : `${this.base}/${url}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.cfg.WA_ACCESS_TOKEN}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      const retryAfter = Number(res.headers.get('retry-after')) || 2 ** attempt;
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      return this.request<T>(url, init, attempt + 1);
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: number } };
      throw new WhatsAppApiError(body.error?.message ?? `Graph API ${res.status}`, res.status, body.error?.code);
    }
    return (await res.json()) as T;
  }

  private async send(payload: Record<string, unknown>): Promise<SendResult> {
    const res = await this.request<{ messages: { id: string }[] }>(`${this.cfg.WA_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', ...payload }),
    });
    const id = res.messages[0]?.id;
    if (!id) throw new WhatsAppApiError('Graph API returned no message id', 502);
    return { waMessageId: id };
  }

  sendText(to: string, body: string, replyTo?: string | null): Promise<SendResult> {
    return this.send({
      to,
      type: 'text',
      text: { body, preview_url: false },
      ...(replyTo ? { context: { message_id: replyTo } } : {}),
    });
  }

  sendTemplate(to: string, name: string, language: string, params: string[]): Promise<SendResult> {
    return this.send({
      to,
      type: 'template',
      template: {
        name,
        language: { code: language },
        components: params.length
          ? [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }]
          : [],
      },
    });
  }

  async markRead(waMessageId: string): Promise<void> {
    await this.request(`${this.cfg.WA_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: waMessageId }),
    });
  }

  async downloadMedia(mediaId: string): Promise<{ data: Buffer; mimeType: string }> {
    const meta = await this.request<{ url: string; mime_type: string }>(encodeURIComponent(mediaId));
    const res = await this.fetchImpl(meta.url, { headers: { Authorization: `Bearer ${this.cfg.WA_ACCESS_TOKEN}` } });
    if (!res.ok) throw new WhatsAppApiError(`media download failed (${res.status})`, res.status);
    return { data: Buffer.from(await res.arrayBuffer()), mimeType: meta.mime_type };
  }

  async listTemplates(): Promise<RemoteTemplate[]> {
    type Page = {
      data: { name: string; language: string; category: string; status: string; components: unknown }[];
      paging?: { next?: string };
    };
    const out: RemoteTemplate[] = [];
    let url: string | undefined =
      `${this.cfg.WA_BUSINESS_ACCOUNT_ID}/message_templates?fields=name,language,category,status,components&limit=100`;
    while (url) {
      const page: Page = await this.request<Page>(url);
      for (const t of page.data) out.push({ ...t, ...templateBody(t.components) });
      url = page.paging?.next;
    }
    return out;
  }
}

const MOCK_TEMPLATES: RemoteTemplate[] = [
  {
    name: 'order_update',
    language: 'en',
    category: 'UTILITY',
    status: 'APPROVED',
    body: 'Hi {{1}}, your order {{2}} is now {{3}}. Reply to this message if you have any questions.',
    paramCount: 3,
    components: [],
  },
  {
    name: 'order_update',
    language: 'ar',
    category: 'UTILITY',
    status: 'APPROVED',
    body: 'مرحباً {{1}}، طلبك رقم {{2}} الآن {{3}}. يمكنك الرد على هذه الرسالة لأي استفسار.',
    paramCount: 3,
    components: [],
  },
  {
    name: 'follow_up',
    language: 'en',
    category: 'UTILITY',
    status: 'APPROVED',
    body: 'Hi {{1}}, we are following up on your recent message. Are you still interested? Reply to continue.',
    paramCount: 1,
    components: [],
  },
  {
    name: 'follow_up',
    language: 'ar',
    category: 'UTILITY',
    status: 'APPROVED',
    body: 'مرحباً {{1}}، نتابع معك بخصوص رسالتك الأخيرة. هل ما زلت مهتماً؟ رد على هذه الرسالة للمتابعة.',
    paramCount: 1,
    components: [],
  },
];

/**
 * Demo client: nothing leaves the machine. Sends are written to mock_outbox,
 * media ids of the form `mock-audio:<base64url text>` "download" as that text,
 * which the mock AI provider then "transcribes".
 */
export class MockWhatsAppClient implements WhatsAppClient {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  private async record(to: string, payload: unknown): Promise<SendResult> {
    const waMessageId = `wamid.MOCK-${randomUUID()}`;
    await this.db.query('INSERT INTO mock_outbox (wa_message_id, to_wa_id, payload) VALUES ($1, $2, $3)', [
      waMessageId,
      to,
      JSON.stringify(payload),
    ]);
    return { waMessageId };
  }

  sendText(to: string, body: string, replyTo?: string | null) {
    return this.record(to, { type: 'text', body, replyTo: replyTo ?? null });
  }

  sendTemplate(to: string, name: string, language: string, params: string[]) {
    return this.record(to, { type: 'template', name, language, params });
  }

  async markRead(): Promise<void> {}

  async downloadMedia(mediaId: string) {
    if (mediaId.startsWith('mock-audio:')) {
      return { data: Buffer.from(mediaId.slice('mock-audio:'.length), 'base64url'), mimeType: 'audio/ogg' };
    }
    return { data: Buffer.alloc(0), mimeType: 'application/octet-stream' };
  }

  async listTemplates() {
    return MOCK_TEMPLATES;
  }
}
