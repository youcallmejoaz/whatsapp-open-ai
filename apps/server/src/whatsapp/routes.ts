import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';
import { verifySignature } from './signature.ts';

/** Meta webhook: GET for the subscription handshake, POST for events. */
export async function webhookRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  // Keep the raw bytes: the HMAC must be computed over exactly what Meta sent.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.get('/webhook', { config: { rateLimit: false } }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === ctx.cfg.WA_VERIFY_TOKEN) {
      return reply.type('text/plain').send(q['hub.challenge'] ?? '');
    }
    return reply.code(403).send({ error: 'verification failed' });
  });

  app.post('/webhook', { config: { rateLimit: false }, bodyLimit: 5 * 1024 * 1024 }, async (req, reply) => {
    const raw = req.body as Buffer;
    if (!Buffer.isBuffer(raw) || !verifySignature(raw, req.headers['x-hub-signature-256'] as string | undefined, ctx.cfg.WA_APP_SECRET)) {
      req.log.warn('webhook signature mismatch');
      return reply.code(401).send({ error: 'invalid signature' });
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      return reply.code(400).send({ error: 'invalid json' });
    }
    // Persist first, process async: Meta expects a fast 200 and retries otherwise.
    const { rows } = await ctx.db.query<{ id: number }>('INSERT INTO webhook_events (payload) VALUES ($1) RETURNING id', [
      JSON.stringify(payload),
    ]);
    req.log.info({ eventId: rows[0]!.id }, 'webhook received');
    await ctx.queue.send('webhook.process', { eventId: rows[0]!.id });
    return reply.code(200).send({ ok: true });
  });
}
