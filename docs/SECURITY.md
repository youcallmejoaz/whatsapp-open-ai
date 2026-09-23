# Security & privacy notes

## Implemented

| Area | Measure | Where |
|---|---|---|
| Webhook authenticity | HMAC-SHA256 (`X-Hub-Signature-256`) over raw body, timing-safe compare; unsigned → 401 | `whatsapp/signature.ts`, `whatsapp/routes.ts` |
| Replay / retries | Idempotent on `wa_message_id`; raw events stored once and processed once | `services/ingest.ts` |
| Human in the loop | Only `approveAndSend` sends; requires a signed-in `admin`/`agent`; API tokens (MCP) can never approve | `services/drafts.ts` |
| Prompt injection | Customer text passed as JSON data with explicit "untrusted" instructions; models have no tools; worst case is a bad draft that still needs approval | `ai/prompts.ts`, `mcp/server.ts` |
| WhatsApp policy | 24h window enforced for free-form text; templates validated (name, language, parameter count) | `services/drafts.ts`, `mcp/server.ts` |
| Auth | scrypt password hashes; random session tokens stored as SHA-256; httpOnly SameSite=Lax cookie (Secure on https) | `services/auth.ts`, `api/routes.ts` |
| CSRF | State-changing API calls require `X-Requested-With: wa-dashboard` (not settable cross-site without CORS, which is not enabled) | `api/routes.ts` |
| MCP tokens | Random, hashed at rest, scoped (`read`, `draft`), revocable, `last_used_at` tracked | `services/auth.ts` |
| Roles | `admin`, `agent`, `viewer` | `services/drafts.ts`, `api/routes.ts` |
| Audit | Logins, failed logins, draft create/edit/approve/reject, sends, send failures, token changes, every MCP tool call | `audit_log` table, `/api/audit` |
| Rate limiting | 300 req/min/IP globally, 10/min on login; webhook exempt (Meta bursts) | `app.ts` |
| Logs | Authorization, cookies and signatures redacted; message bodies are not logged | `app.ts` |
| Retention | `RETENTION_DAYS` deletes old messages; processed raw webhooks deleted after 30 days | `services/retention.ts` |
| Config safety | Refuses to boot in production with default secrets | `config.ts` |
| OpenAI data | Calls use `store: false`; API data is not used for training by default; Zero Data Retention can be requested from OpenAI for eligible orgs | `ai/openai.ts` |

## Deployment checklist

- Terminate TLS in front of the app (Caddy, a cloud load balancer, etc.). Meta requires HTTPS for webhooks.
- Store `WA_ACCESS_TOKEN`, `WA_APP_SECRET`, `OPENAI_API_KEY` and `COOKIE_SECRET` in a secret manager, not in the image.
- Use a **system-user** access token scoped to the one WABA.
- Enable encrypted backups for Postgres; the database holds personal data (phone numbers, messages).
- Set `RETENTION_DAYS` to your data-retention policy, and document it in your privacy notice.
- Rotate the bootstrap admin password on first login and create named users per staff member.

## Known gaps / next steps

- MCP auth uses bearer tokens (or a secret URL for ChatGPT connectors). For multi-tenant or enterprise use, add OAuth 2.1 with dynamic client registration.
- Media files are referenced, not stored. If you add storage, put it in a private bucket with signed URLs.
- There is no second-approver rule for high-risk sends. It would be easy to add on `approveAndSend` (e.g. require a different user than `created_by`).
