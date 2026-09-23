# Deploying

The app is **one long-running container**. It serves the API, the WhatsApp webhook, the MCP endpoint and the dashboard, and it runs the background worker. It also needs **Postgres 16 with pgvector**.

Hosts that run containers work well: Render, Railway, Fly.io, or any VPS. Serverless platforms like Vercel don't: the worker and scheduled jobs need a process that stays running.

> The Docker image has not been built in CI yet. The runtime layout and a production start (migrations, first-boot seeding, login, dashboard) were checked without Docker. If the first build fails, the error message usually points straight at the fix.

---

## Option A: Render (Blueprint, a few clicks)

1. Push this repo to GitHub.
2. In Render: **New → Blueprint** → select the repo. Render reads [`render.yaml`](../render.yaml) and creates:
   - **`whatsapp-ai`:** a Docker web service with health check `/healthz`;
   - **`whatsapp-ai-db`:** Postgres 16. The migration enables `vector` and `pgcrypto` on first start.
3. When prompted, fill in:
   - `ADMIN_EMAIL` and `ADMIN_PASSWORD`: your dashboard login. The app refuses to start in production with the default password.
   - The `WA_*` and `OPENAI_API_KEY` values can stay **empty for now**. The first deploy runs in demo mode.
4. Click **Apply**. The first build takes a few minutes. Then open `https://whatsapp-ai.onrender.com` (or whatever name Render assigned) and log in.
   - `DEMO_SEED_ON_BOOT=true` loads the demo conversations the first time, only while the database is empty and `WA_MODE=mock`. That makes a ready-made portfolio link.
   - `PUBLIC_URL` is picked up from Render automatically (`RENDER_EXTERNAL_URL`). Set it yourself only if you add a custom domain.

**Plans:**
- `render.yaml` uses **free** plans. Fine for a demo, with two catches:
  - A free web service **sleeps after ~15 minutes idle**, so the first request after that takes ~1 minute. Meta retries webhooks, so messages arrive late but aren't lost.
  - Free Postgres databases **expire** after a limited period (check Render's current policy).
- For real use, switch the service to **Starter** and the database to a paid plan. You can do this in the Render dashboard, or by editing `plan:` in `render.yaml`.

## Option B: Railway

1. **New Project → Deploy from GitHub repo.** Railway detects the `Dockerfile`.
2. **Add a database.** Use a Postgres service with **pgvector**; Railway's pgvector template works. Alternatively, use Supabase or Neon (see below).
3. On the app service, set variables:
   - `NODE_ENV=production`
   - `DATABASE_URL` (reference the database's URL)
   - `COOKIE_SECRET`, `WA_APP_SECRET`, `WA_VERIFY_TOKEN`: long random strings
   - `ADMIN_EMAIL`, `ADMIN_PASSWORD`
   - `DEMO_SEED_ON_BOOT=true`
4. **Settings → Networking → Generate Domain.** `PUBLIC_URL` is picked up from `RAILWAY_PUBLIC_DOMAIN` automatically.

## Using Supabase or Neon for the database

Both include pgvector. Create a project and copy the **Postgres connection string** (on Supabase use the *session pooler* or direct connection, not the transaction pooler; the job queue needs session features). Set it as `DATABASE_URL`, and delete the Render database from `render.yaml` if you go this way.

---

## Going live with WhatsApp and OpenAI

Once the demo deploy works, change these variables in your host's dashboard and redeploy:

| Variable | Value |
|---|---|
| `WA_MODE` | `live` |
| `WA_PHONE_NUMBER_ID`, `WA_BUSINESS_ACCOUNT_ID` | Meta app → WhatsApp → API Setup |
| `WA_ACCESS_TOKEN` | System-user token (does not expire) |
| `WA_APP_SECRET` | Meta app → App settings → Basic → App secret. **Replace** the generated value |
| `AI_PROVIDER`, `OPENAI_API_KEY` | `openai` and your key |
| `DEMO_SEED_ON_BOOT` | optional to remove; it never runs in live mode |

Then in **Meta → your app → WhatsApp → Configuration → Webhook**:
- **Callback URL:** `https://<your-app-domain>/webhook`
- **Verify token:** the value of `WA_VERIFY_TOKEN` in your host's dashboard
- **Verify and save**, then subscribe to **`messages`** (plus `smb_message_echoes` and `history` if you use coexistence).

Test it: message your number from WhatsApp. The message should show up in the dashboard within seconds; approve the draft and the reply lands on your phone.

**About the demo data:** it stays in the database after you switch to live. For a clean start, create a fresh database, or run `TRUNCATE contacts, webhook_events, reports, audit_log, mock_outbox CASCADE;` in your database console.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Service crashes at boot with `Invalid configuration … must be set to a real secret in production` | A secret is still a default. Set `ADMIN_PASSWORD`, `COOKIE_SECRET`, `WA_APP_SECRET` and `WA_VERIFY_TOKEN` |
| `extension "vector" is not available` | The database doesn't include pgvector. Use Render Postgres, Railway's pgvector template, Supabase or Neon |
| Health check fails right after deploy | The first boot runs migrations and seeding, which can take ~30 s on a free plan. Check the logs for `ready` |
| Meta "Verify and save" fails | The service is asleep (free plan) or the verify token doesn't match. Open the URL once to wake it, then retry |
| Logs show `webhook signature mismatch` | `WA_APP_SECRET` isn't the App secret of the Meta app the webhook belongs to |
