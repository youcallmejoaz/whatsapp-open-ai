import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { demoPayloads } from '../src/demo/dataset.ts';
import { createApiToken } from '../src/services/auth.ts';
import { META, postWebhook, setup, type TestEnv } from './helpers.ts';

let env: TestEnv;
let base: string;

beforeEach(async () => {
  env = await setup({ env: { AUTO_DRAFT: 'false' } });
  await env.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(env.app.server.address() as AddressInfo).port}`;
  for (const p of demoPayloads(META)) await postWebhook(env, p);
});
afterEach(async () => env.close());

async function connect(token: string, viaPath = false) {
  const client = new Client({ name: 'test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(
    new URL(viaPath ? `${base}/mcp/${token}` : `${base}/mcp`),
    viaPath ? {} : { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
  );
  await client.connect(transport);
  return client;
}

const json = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0]!.text);

describe('MCP server', () => {
  it('rejects missing or revoked tokens', async () => {
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
    await expect(connect('wat_invalid')).rejects.toThrow();
  });

  it('exposes read and draft tools with annotations', async () => {
    const { token } = await createApiToken(env.db, env.admin, { userId: env.admin.userId!, name: 't', scopes: ['read', 'draft'] });
    const client = await connect(token);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'draft_reply', 'generate_report', 'get_conversation', 'list_conversations', 'list_templates', 'request_send',
      'search_messages', 'summarize_conversation',
    ]);
    expect(tools.find((t) => t.name === 'search_messages')?.annotations?.readOnlyHint).toBe(true);
    await client.close();
  });

  it('searches, summarizes and lists the reply queue', async () => {
    const { token } = await createApiToken(env.db, env.admin, { userId: env.admin.userId!, name: 't', scopes: ['read'] });
    const client = await connect(token, true);
    const hits = json(await client.callTool({ name: 'search_messages', arguments: { query: 'طلب 4821' } }));
    expect(hits[0].contactName).toBe('Khalid Al Mansoori');
    const queue = json(await client.callTool({ name: 'list_conversations', arguments: { filter: 'urgent' } }));
    expect(queue.items).toHaveLength(2);
    const summary = json(await client.callTool({ name: 'summarize_conversation', arguments: { phone: '+971 50 111 0001' } }));
    expect(summary.summary).toContain('Khalid');
    await client.close();
  });

  it('request_send creates a pending draft and never sends', async () => {
    const { token } = await createApiToken(env.db, env.admin, { userId: env.admin.userId!, name: 't', scopes: ['read', 'draft'] });
    const client = await connect(token);
    const res = json(await client.callTool({
      name: 'request_send',
      arguments: { phone: '971501110001', text: 'نعتذر يا خالد، سنعوضك بطلب مجاني' },
    }));
    expect(res.status).toBe('pending_approval');
    expect(res.approval_url).toMatch(/^http:\/\/test\.local\/#\/c\//);
    expect(res.draft).toMatchObject({ state: 'pending', source: 'mcp' });
    expect((await env.db.query('SELECT count(*)::int AS n FROM mock_outbox')).rows[0].n).toBe(0);
    await client.close();
  });

  it('enforces the 24h window and allows templates to new numbers', async () => {
    const { token } = await createApiToken(env.db, env.admin, { userId: env.admin.userId!, name: 't', scopes: ['read', 'draft'] });
    const client = await connect(token);
    // Fatima last wrote 3 days ago (history sync).
    const closed = await client.callTool({ name: 'request_send', arguments: { phone: '971504445555', text: 'Any update?' } });
    expect(closed.isError).toBe(true);
    expect((closed.content as { text: string }[])[0]!.text).toMatch(/WINDOW_CLOSED/);
    const tpl = json(await client.callTool({
      name: 'request_send',
      arguments: { phone: '+971 55 000 1234', template: { name: 'follow_up', language: 'ar', params: ['سالم'] } },
    }));
    expect(tpl.draft.template).toEqual({ name: 'follow_up', language: 'ar', params: ['سالم'] });
    await client.close();
  });

  it('read-only tokens cannot create drafts', async () => {
    const { token } = await createApiToken(env.db, env.admin, { userId: env.admin.userId!, name: 't', scopes: ['read'] });
    const client = await connect(token);
    const res = await client.callTool({ name: 'draft_reply', arguments: { phone: '971501110001' } });
    expect(res.isError).toBe(true);
    expect((await env.db.query(`SELECT count(*)::int AS n FROM drafts`)).rows[0].n).toBe(0);
    await client.close();
  });
});
