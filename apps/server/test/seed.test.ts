import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedDemoIfEmpty } from '../src/demo/seed.ts';
import { setup, type TestEnv } from './helpers.ts';

let env: TestEnv;
beforeEach(async () => {
  env = await setup({ env: { DEMO_SEED_ON_BOOT: 'true' } });
});
afterEach(async () => env.close());

describe('seed on boot', () => {
  it('seeds an empty demo database once', async () => {
    const first = await seedDemoIfEmpty(env.ctx);
    expect(first?.counts).toMatchObject({ conversations: 9, needs_reply: 6 });
    expect(await seedDemoIfEmpty(env.ctx)).toBeNull();
    const { rows } = await env.db.query('SELECT count(*)::int AS n FROM conversations');
    expect(rows[0].n).toBe(9);
  });

  it('never seeds in live mode or when disabled', async () => {
    expect(await seedDemoIfEmpty({ ...env.ctx, cfg: { ...env.cfg, WA_MODE: 'live' } })).toBeNull();
    expect(await seedDemoIfEmpty({ ...env.ctx, cfg: { ...env.cfg, DEMO_SEED_ON_BOOT: false } })).toBeNull();
    const { rows } = await env.db.query('SELECT count(*)::int AS n FROM conversations');
    expect(rows[0].n).toBe(0);
  });
});
