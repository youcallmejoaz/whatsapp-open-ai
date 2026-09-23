import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().int().default(3000),
    HOST: z.string().default('0.0.0.0'),
    PUBLIC_URL: z.string().url().default('http://localhost:3000'),
    LOG_LEVEL: z.string().default('info'),
    DATABASE_URL: z.string().default('postgres://wa:wa@localhost:5432/wa'),

    // WhatsApp Cloud API
    WA_MODE: z.enum(['live', 'mock']).default('mock'),
    WA_GRAPH_VERSION: z.string().default('v23.0'),
    WA_PHONE_NUMBER_ID: z.string().default('000000000000000'),
    WA_BUSINESS_ACCOUNT_ID: z.string().default('000000000000000'),
    WA_ACCESS_TOKEN: z.string().default(''),
    WA_APP_SECRET: z.string().default('dev-app-secret'),
    WA_VERIFY_TOKEN: z.string().default('dev-verify-token'),

    // AI
    AI_PROVIDER: z.enum(['openai', 'mock']).default('mock'),
    OPENAI_API_KEY: z.string().default(''),
    OPENAI_MODEL: z.string().default('gpt-5-mini'),
    OPENAI_MODEL_SMALL: z.string().default('gpt-5-nano'),
    OPENAI_EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
    OPENAI_TRANSCRIBE_MODEL: z.string().default('gpt-4o-mini-transcribe'),
    BUSINESS_PROFILE_FILE: z.string().default(''),
    REPORT_LANGUAGE: z.enum(['en', 'ar']).default('en'),
    AUTO_DRAFT: bool.default(true),
    // Load the demo dataset on boot if the database is empty (WA_MODE=mock only).
    DEMO_SEED_ON_BOOT: bool.default(false),

    // Scheduling / retention
    REPORT_CRON: z.string().default('0 18 * * *'),
    REPORT_TZ: z.string().default('Asia/Dubai'),
    RETENTION_DAYS: z.coerce.number().int().min(0).default(0),

    // Auth
    ADMIN_EMAIL: z.string().email().default('admin@example.com'),
    ADMIN_PASSWORD: z.string().min(8).default('change-me-now'),
    SESSION_TTL_HOURS: z.coerce.number().int().default(12),
    COOKIE_SECRET: z.string().min(16).default('dev-cookie-secret-change-me'),
    WEB_DIST: z.string().default(''),
  })
  .superRefine((env, ctx) => {
    if (env.WA_MODE === 'live' && !env.WA_ACCESS_TOKEN) {
      ctx.addIssue({ code: 'custom', path: ['WA_ACCESS_TOKEN'], message: 'required when WA_MODE=live' });
    }
    if (env.AI_PROVIDER === 'openai' && !env.OPENAI_API_KEY) {
      ctx.addIssue({ code: 'custom', path: ['OPENAI_API_KEY'], message: 'required when AI_PROVIDER=openai' });
    }
    if (env.NODE_ENV === 'production') {
      for (const key of ['WA_APP_SECRET', 'WA_VERIFY_TOKEN', 'COOKIE_SECRET', 'ADMIN_PASSWORD'] as const) {
        if (env[key].startsWith('dev-') || env[key] === 'change-me-now') {
          ctx.addIssue({ code: 'custom', path: [key], message: 'must be set to a real secret in production' });
        }
      }
    }
  });

export type Config = z.infer<typeof EnvSchema>;

/**
 * Empty values count as unset (hosting dashboards often create blank variables),
 * and PUBLIC_URL falls back to the URL the platform assigns (Render, Railway).
 */
function withPlatformDefaults(input: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== '')) as NodeJS.ProcessEnv;
  if (env.PUBLIC_URL) return env;
  const url =
    env.RENDER_EXTERNAL_URL ?? (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : undefined);
  return url ? { ...env, PUBLIC_URL: url } : env;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(withPlatformDefaults(env));
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  return parsed.data;
}
