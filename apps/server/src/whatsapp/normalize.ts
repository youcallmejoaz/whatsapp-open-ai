import { z } from 'zod';

// Lenient schemas for the Cloud API webhook. Meta adds fields regularly, so
// everything is a loose object and we only require what we use.

const Media = z.looseObject({
  id: z.string(),
  mime_type: z.string().optional(),
  caption: z.string().optional(),
  filename: z.string().optional(),
  voice: z.boolean().optional(),
});

const WaMessage = z.looseObject({
  from: z.string(),
  to: z.string().optional(),
  id: z.string(),
  timestamp: z.string(),
  type: z.string(),
  text: z.looseObject({ body: z.string() }).optional(),
  image: Media.optional(),
  audio: Media.optional(),
  video: Media.optional(),
  document: Media.optional(),
  sticker: Media.optional(),
  location: z
    .looseObject({
      latitude: z.number(),
      longitude: z.number(),
      name: z.string().optional(),
      address: z.string().optional(),
    })
    .optional(),
  button: z.looseObject({ text: z.string() }).optional(),
  interactive: z
    .looseObject({
      type: z.string(),
      button_reply: z.looseObject({ id: z.string(), title: z.string() }).optional(),
      list_reply: z.looseObject({ id: z.string(), title: z.string() }).optional(),
    })
    .optional(),
  reaction: z.looseObject({ message_id: z.string(), emoji: z.string().optional() }).optional(),
  context: z.looseObject({ id: z.string().optional() }).optional(),
});
export type WaMessage = z.infer<typeof WaMessage>;

const Status = z.looseObject({
  id: z.string(),
  status: z.string(),
  timestamp: z.string(),
  recipient_id: z.string(),
  errors: z.array(z.looseObject({ code: z.number(), title: z.string().optional() })).optional(),
});

const Metadata = z.looseObject({ phone_number_id: z.string(), display_phone_number: z.string().optional() });

const MessagesValue = z.looseObject({
  metadata: Metadata,
  contacts: z.array(z.looseObject({ wa_id: z.string(), profile: z.looseObject({ name: z.string() }).optional() })).optional(),
  messages: z.array(WaMessage).optional(),
  statuses: z.array(Status).optional(),
});

// Coexistence: messages the business sent from the WhatsApp Business App.
const EchoValue = z.looseObject({
  metadata: Metadata,
  message_echoes: z.array(WaMessage).optional(),
});

// Coexistence: one-off sync of up to ~6 months of chat history at onboarding.
const HistoryValue = z.looseObject({
  metadata: Metadata,
  history: z
    .array(
      z.looseObject({
        threads: z.array(z.looseObject({ id: z.string(), messages: z.array(WaMessage) })).optional(),
      }),
    )
    .optional(),
});

const Payload = z.looseObject({
  object: z.literal('whatsapp_business_account'),
  entry: z.array(
    z.looseObject({
      id: z.string(),
      changes: z.array(z.looseObject({ field: z.string(), value: z.unknown() })),
    }),
  ),
});

export type MediaRef = { id: string; mimeType?: string; filename?: string; voice?: boolean };

export interface MessageEvent {
  kind: 'message';
  source: 'webhook' | 'echo' | 'history';
  direction: 'in' | 'out';
  waId: string; // the customer, regardless of direction
  contactName?: string;
  waMessageId: string;
  timestamp: Date;
  type: string;
  text: string | null;
  media: MediaRef | null;
  contextWaMessageId: string | null;
  raw: unknown;
}

export interface StatusEvent {
  kind: 'status';
  waMessageId: string;
  status: string;
  timestamp: Date;
  recipient: string;
  errors: unknown[] | null;
}

export type WaEvent = MessageEvent | StatusEvent;

const tsToDate = (ts: string) => new Date(Number(ts) * 1000);

/** Human-readable text for any message type, used for storage, search and AI. */
export function messageText(m: WaMessage): string | null {
  switch (m.type) {
    case 'text':
      return m.text?.body ?? null;
    case 'image':
    case 'video':
    case 'document':
      return m[m.type]?.caption ?? (m.type === 'document' ? (m.document?.filename ?? null) : null);
    case 'location': {
      const l = m.location;
      return l ? [l.name, l.address, `(${l.latitude}, ${l.longitude})`].filter(Boolean).join(' ') : null;
    }
    case 'button':
      return m.button?.text ?? null;
    case 'interactive':
      return m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? null;
    case 'reaction':
      return m.reaction?.emoji ?? null;
    default:
      return null;
  }
}

function mediaOf(m: WaMessage): MediaRef | null {
  const media = m.image ?? m.audio ?? m.video ?? m.document ?? m.sticker;
  if (!media) return null;
  return { id: media.id, mimeType: media.mime_type, filename: media.filename, voice: media.voice };
}

function toMessageEvent(
  m: WaMessage,
  source: MessageEvent['source'],
  direction: 'in' | 'out',
  waId: string,
  contactName?: string,
): MessageEvent {
  return {
    kind: 'message',
    source,
    direction,
    waId,
    contactName,
    waMessageId: m.id,
    timestamp: tsToDate(m.timestamp),
    type: m.type,
    text: messageText(m),
    media: mediaOf(m),
    contextWaMessageId: m.context?.id ?? null,
    raw: m,
  };
}

/** Summary of a payload for logs: which phone number IDs and fields it targets. No PII. */
export function describeWebhook(payload: unknown): { phoneNumberIds: string[]; fields: string[] } {
  const parsed = Payload.safeParse(payload);
  if (!parsed.success) return { phoneNumberIds: [], fields: [] };
  const ids = new Set<string>();
  const fields = new Set<string>();
  for (const entry of parsed.data.entry) {
    for (const change of entry.changes) {
      fields.add(change.field);
      const id = (change.value as { metadata?: { phone_number_id?: unknown } } | null)?.metadata?.phone_number_id;
      if (typeof id === 'string') ids.add(id);
    }
  }
  return { phoneNumberIds: [...ids], fields: [...fields] };
}

/**
 * Flatten a webhook payload into domain events for our phone number.
 * Changes for other phone numbers on the same WABA are ignored.
 */
export function normalizeWebhook(payload: unknown, phoneNumberId: string): WaEvent[] {
  const parsed = Payload.safeParse(payload);
  if (!parsed.success) return [];
  const events: WaEvent[] = [];

  for (const entry of parsed.data.entry) {
    for (const change of entry.changes) {
      if (change.field === 'messages') {
        const v = MessagesValue.safeParse(change.value);
        if (!v.success || v.data.metadata.phone_number_id !== phoneNumberId) continue;
        const names = new Map(v.data.contacts?.map((c) => [c.wa_id, c.profile?.name]) ?? []);
        for (const m of v.data.messages ?? []) {
          events.push(toMessageEvent(m, 'webhook', 'in', m.from, names.get(m.from)));
        }
        for (const s of v.data.statuses ?? []) {
          events.push({
            kind: 'status',
            waMessageId: s.id,
            status: s.status,
            timestamp: tsToDate(s.timestamp),
            recipient: s.recipient_id,
            errors: s.errors ?? null,
          });
        }
      } else if (change.field === 'smb_message_echoes') {
        const v = EchoValue.safeParse(change.value);
        if (!v.success || v.data.metadata.phone_number_id !== phoneNumberId) continue;
        for (const m of v.data.message_echoes ?? []) {
          if (m.to) events.push(toMessageEvent(m, 'echo', 'out', m.to));
        }
      } else if (change.field === 'history') {
        const v = HistoryValue.safeParse(change.value);
        if (!v.success || v.data.metadata.phone_number_id !== phoneNumberId) continue;
        for (const chunk of v.data.history ?? []) {
          for (const thread of chunk.threads ?? []) {
            for (const m of thread.messages) {
              const direction = m.from === thread.id ? 'in' : 'out';
              events.push(toMessageEvent(m, 'history', direction, thread.id));
            }
          }
        }
      }
    }
  }
  return events;
}
