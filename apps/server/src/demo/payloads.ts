import { randomUUID } from 'node:crypto';

// Builders for Cloud API webhook payloads, used by the seed script, the
// simulator and the tests. Shapes follow Meta's documented webhook format.

const ts = (d: Date) => String(Math.floor(d.getTime() / 1000));
export const wamid = () => `wamid.DEMO${randomUUID().replace(/-/g, '').toUpperCase()}`;

export interface PhoneMeta {
  phoneNumberId: string;
  displayPhone?: string;
}

const envelope = (field: string, value: Record<string, unknown>, meta: PhoneMeta) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'WABA_ID',
      changes: [
        {
          field,
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: meta.displayPhone ?? '15550000000', phone_number_id: meta.phoneNumberId },
            ...value,
          },
        },
      ],
    },
  ],
});

export type InboundSpec =
  | { kind: 'text'; text: string }
  | { kind: 'voice'; transcript: string }
  | { kind: 'image'; caption?: string }
  | { kind: 'location'; latitude: number; longitude: number; name?: string }
  | { kind: 'reaction'; emoji: string; to: string };

export function inboundPayload(
  meta: PhoneMeta,
  from: { waId: string; name: string },
  spec: InboundSpec,
  at: Date,
  id = wamid(),
) {
  const base = { from: from.waId, id, timestamp: ts(at) };
  let message: Record<string, unknown>;
  switch (spec.kind) {
    case 'text':
      message = { ...base, type: 'text', text: { body: spec.text } };
      break;
    case 'voice':
      // In mock mode the media id carries the "audio"; see MockWhatsAppClient.downloadMedia.
      message = {
        ...base,
        type: 'audio',
        audio: { id: `mock-audio:${Buffer.from(spec.transcript).toString('base64url')}`, mime_type: 'audio/ogg; codecs=opus', voice: true },
      };
      break;
    case 'image':
      message = { ...base, type: 'image', image: { id: `mock-image:${randomUUID()}`, mime_type: 'image/jpeg', caption: spec.caption } };
      break;
    case 'location':
      message = { ...base, type: 'location', location: { latitude: spec.latitude, longitude: spec.longitude, name: spec.name } };
      break;
    case 'reaction':
      message = { ...base, type: 'reaction', reaction: { message_id: spec.to, emoji: spec.emoji } };
      break;
  }
  return envelope('messages', { contacts: [{ profile: { name: from.name }, wa_id: from.waId }], messages: [message] }, meta);
}

export function statusPayload(meta: PhoneMeta, messageId: string, recipient: string, status: 'sent' | 'delivered' | 'read' | 'failed', at: Date) {
  return envelope(
    'messages',
    { statuses: [{ id: messageId, status, timestamp: ts(at), recipient_id: recipient }] },
    meta,
  );
}

/** Coexistence: a reply typed on the phone in the WhatsApp Business App. */
export function echoPayload(meta: PhoneMeta, to: string, text: string, at: Date, id = wamid()) {
  return envelope(
    'smb_message_echoes',
    {
      message_echoes: [
        { from: meta.displayPhone ?? '15550000000', to, id, timestamp: ts(at), type: 'text', text: { body: text } },
      ],
    },
    meta,
  );
}

/** Coexistence: chat history synced from the WhatsApp Business App at onboarding. */
export function historyPayload(
  meta: PhoneMeta,
  waId: string,
  lines: { from: 'customer' | 'business'; text: string; at: Date }[],
) {
  return envelope(
    'history',
    {
      history: [
        {
          metadata: { phase: 0, chunk_order: 1, progress: 100 },
          threads: [
            {
              id: waId,
              messages: lines.map((l) => ({
                from: l.from === 'customer' ? waId : (meta.displayPhone ?? '15550000000'),
                ...(l.from === 'business' ? { to: waId } : {}),
                id: wamid(),
                timestamp: ts(l.at),
                type: 'text',
                text: { body: l.text },
                history_context: { status: l.from === 'business' ? 'READ' : 'DELIVERED' },
              })),
            },
          ],
        },
      ],
    },
    meta,
  );
}
