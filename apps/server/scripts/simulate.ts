// Send signed webhook events to a running server, as Meta would.
//   pnpm simulate                          play the live demo script (one message every 4s)
//   pnpm simulate --from 9715012345 --name "Ali" --text "وين طلبي؟"
//   pnpm simulate --voice "transcript of a voice note" --from ...
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.ts';
import { LIVE_MESSAGES } from '../src/demo/dataset.ts';
import { inboundPayload, type InboundSpec } from '../src/demo/payloads.ts';
import { signPayload } from '../src/whatsapp/signature.ts';

const cfg = loadConfig();
const { values } = parseArgs({
  options: {
    url: { type: 'string', default: `http://localhost:${cfg.PORT}/webhook` },
    from: { type: 'string' },
    name: { type: 'string', default: 'Test Customer' },
    text: { type: 'string' },
    voice: { type: 'string' },
    delay: { type: 'string', default: '4' },
  },
});

async function post(payload: unknown) {
  const body = JSON.stringify(payload);
  const res = await fetch(values.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signPayload(body, cfg.WA_APP_SECRET) },
    body,
  });
  if (!res.ok) throw new Error(`webhook returned ${res.status}: ${await res.text()}`);
}

const meta = { phoneNumberId: cfg.WA_PHONE_NUMBER_ID };
if (values.text || values.voice) {
  if (!values.from) throw new Error('--from is required');
  const spec: InboundSpec = values.voice ? { kind: 'voice', transcript: values.voice } : { kind: 'text', text: values.text! };
  await post(inboundPayload(meta, { waId: values.from.replace(/\D/g, ''), name: values.name }, spec, new Date()));
  console.log('sent');
} else {
  for (const m of LIVE_MESSAGES) {
    await post(inboundPayload(meta, m.contact, m.msg, new Date()));
    console.log(`→ ${m.contact.name}: ${m.msg.kind === 'voice' ? `🎤 ${m.msg.transcript}` : m.msg.kind === 'text' ? m.msg.text : m.msg.kind}`);
    await new Promise((r) => setTimeout(r, Number(values.delay) * 1000));
  }
}
