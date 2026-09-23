CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- auth
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  name          text NOT NULL,
  role          text NOT NULL CHECK (role IN ('admin', 'agent', 'viewer')),
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Bearer tokens for MCP clients (ChatGPT connector, Claude, scripts).
CREATE TABLE api_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         text NOT NULL,
  token_hash   text NOT NULL UNIQUE,
  scopes       text[] NOT NULL DEFAULT ARRAY['read', 'draft'],
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

-- ---------------------------------------------------------------- whatsapp data
CREATE TABLE webhook_events (
  id          bigserial PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now(),
  payload     jsonb NOT NULL,
  processed_at timestamptz,
  error       text
);

CREATE TABLE contacts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wa_id      text NOT NULL UNIQUE,
  name       text,
  language   text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE conversations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id      uuid NOT NULL UNIQUE REFERENCES contacts(id) ON DELETE CASCADE,
  last_message_at timestamptz,
  last_inbound_at timestamptz,          -- drives the 24h customer-service window
  last_read_at    timestamptz,
  priority        text CHECK (priority IN ('urgent', 'high', 'normal', 'low')),
  needs_reply     boolean NOT NULL DEFAULT false,
  intent          text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversations_inbox_idx ON conversations (needs_reply DESC, last_message_at DESC);

CREATE TABLE messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  wa_message_id   text NOT NULL UNIQUE,  -- idempotency: Meta retries webhooks
  direction       text NOT NULL CHECK (direction IN ('in', 'out')),
  type            text NOT NULL,
  text            text,
  transcript      text,
  text_normalized text,
  media           jsonb,
  context_wa_id   text,
  status          text,
  status_at       timestamptz,
  error           jsonb,
  source          text NOT NULL CHECK (source IN ('webhook', 'echo', 'history', 'import', 'api')),
  sent_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  raw             jsonb,
  created_at      timestamptz NOT NULL,
  inserted_at     timestamptz NOT NULL DEFAULT now(),
  embedding       vector(1536),
  -- 'simple' keeps exact tokens in any language; 'arabic' and 'english' add stemming.
  search tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple'::regconfig, coalesce(text_normalized, '')), 'A') ||
    to_tsvector('arabic'::regconfig, coalesce(text_normalized, '')) ||
    to_tsvector('english'::regconfig, coalesce(text_normalized, ''))
  ) STORED
);
CREATE INDEX messages_conversation_idx ON messages (conversation_id, created_at);
CREATE INDEX messages_created_idx ON messages (created_at);
CREATE INDEX messages_search_idx ON messages USING gin (search);
CREATE INDEX messages_embedding_idx ON messages USING hnsw (embedding vector_cosine_ops);

CREATE TABLE message_analyses (
  message_id   uuid PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  priority     text NOT NULL,
  needs_reply  boolean NOT NULL,
  intent       text NOT NULL,
  sentiment    text NOT NULL,
  language     text NOT NULL,
  summary      text NOT NULL,
  action_items jsonb NOT NULL DEFAULT '[]',
  reason       text NOT NULL,
  model        text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE conversation_summaries (
  conversation_id uuid PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  summary         jsonb NOT NULL,
  message_count   int NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- drafts & approvals
CREATE TABLE drafts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id   uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  state             text NOT NULL CHECK (state IN ('pending', 'approved', 'sent', 'rejected', 'failed')),
  source            text NOT NULL CHECK (source IN ('ai', 'user', 'mcp')),
  body              text,
  template_name     text,
  template_language text,
  template_params   jsonb,
  rationale         text,
  reply_to_wa_id    text,
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at        timestamptz,
  sent_message_id   uuid REFERENCES messages(id) ON DELETE SET NULL,
  sent_at           timestamptz,
  error             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK ((body IS NOT NULL) <> (template_name IS NOT NULL))
);
CREATE INDEX drafts_pending_idx ON drafts (conversation_id) WHERE state = 'pending';

CREATE TABLE templates (
  name        text NOT NULL,
  language    text NOT NULL,
  category    text NOT NULL,
  status      text NOT NULL,
  body        text NOT NULL,
  param_count int NOT NULL,
  components  jsonb NOT NULL,
  synced_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (name, language)
);

-- Messages "sent" in WA_MODE=mock land here instead of Meta.
CREATE TABLE mock_outbox (
  id         bigserial PRIMARY KEY,
  wa_message_id text NOT NULL,
  to_wa_id   text NOT NULL,
  payload    jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- reports & audit
CREATE TABLE reports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_start timestamptz NOT NULL,
  period_end   timestamptz NOT NULL,
  language     text NOT NULL,
  stats        jsonb NOT NULL,
  narrative    text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  actor_type  text NOT NULL CHECK (actor_type IN ('user', 'token', 'system')),
  actor_id    text,
  action      text NOT NULL,
  target_type text,
  target_id   text,
  details     jsonb,
  ip          text
);
CREATE INDEX audit_log_at_idx ON audit_log (at DESC);
