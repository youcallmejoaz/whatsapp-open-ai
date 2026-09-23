import { useState } from 'react';
import { api } from '../api.ts';
import { CopyButton, ErrorNote } from '../components/ui.tsx';
import { useAction, useLoad } from '../hooks.ts';
import { useI18n } from '../i18n.tsx';

export function Settings() {
  const { t, relative } = useI18n();
  const tokens = useLoad(() => api.tokens(), []);
  const [name, setName] = useState('ChatGPT');
  const [scopes, setScopes] = useState<string[]>(['read', 'draft']);
  const [created, setCreated] = useState<{ token: string; mcpUrl: string } | null>(null);
  const action = useAction();
  const mcpUrl = `${window.location.origin}/mcp`;

  const toggle = (s: string) => setScopes(scopes.includes(s) ? scopes.filter((x) => x !== s) : [...scopes, s]);

  return (
    <div className="page narrow">
      <h1>{t.mcpTitle}</h1>
      <p>{t.mcpIntro}</p>

      <div className="card">
        <div className="composer-row wrap">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t.tokenName} />
          {(['read', 'draft'] as const).map((s) => (
            <label key={s} className="check">
              <input type="checkbox" checked={scopes.includes(s)} onChange={() => toggle(s)} />{' '}
              {s === 'read' ? t.scopeRead : t.scopeDraft}
            </label>
          ))}
          <button
            className="btn btn-primary"
            disabled={action.busy || !name.trim() || scopes.length === 0}
            onClick={() =>
              action.run(async () => {
                setCreated(await api.createToken(name, scopes));
                await tokens.reload();
              })
            }
          >
            {t.createToken}
          </button>
        </div>
        <ErrorNote error={action.error} />
        {created && (
          <div className="secret">
            <div className="warn small">{t.tokenOnce}</div>
            <code dir="ltr">{created.token}</code> <CopyButton text={created.token} />
          </div>
        )}
      </div>

      <div className="card">
        <ul className="token-list">
          {tokens.data?.items.map((tk) => (
            <li key={tk.id}>
              <strong>{tk.name}</strong> <span className="chip chip-muted">{tk.scopes.join(', ')}</span>
              <span className="muted small">
                {' '}
                · {t.lastUsed}: {tk.lastUsedAt ? relative(tk.lastUsedAt) : t.never}
              </span>
              <span className="grow" />
              <button className="btn btn-ghost btn-sm" onClick={() => api.revokeToken(tk.id).then(tokens.reload)}>
                {t.revoke}
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="card howto" dir="ltr">
        <h3>ChatGPT (developer mode → Connectors → Create)</h3>
        <ol>
          <li>
            MCP server URL: <code>{mcpUrl}/&lt;token&gt;</code> <CopyButton text={`${mcpUrl}/${created?.token ?? '<token>'}`} />
          </li>
          <li>Authentication: <em>No authentication</em> (the token in the URL is the secret; rotate it by revoking).</li>
          <li>
            Try: <em>“Which customers are waiting for a reply and what do they want?”</em>, <em>“Summarize Khalid’s chat in Arabic”</em>,{' '}
            <em>“Draft an apology to +971501110001 offering free delivery”</em>.
          </li>
        </ol>
        <h3>Claude, OpenAI Responses API, MCP Inspector</h3>
        <pre>{`URL:    ${mcpUrl}
Header: Authorization: Bearer <token>

# OpenAI Responses API
tools=[{"type": "mcp", "server_label": "whatsapp",
        "server_url": "${mcpUrl}",
        "headers": {"Authorization": "Bearer <token>"},
        "require_approval": "never"}]`}</pre>
      </div>
    </div>
  );
}
