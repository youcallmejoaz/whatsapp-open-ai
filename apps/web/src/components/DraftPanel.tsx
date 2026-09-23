import type { ConversationListItem, DraftDto, TemplateDto } from '@wa/shared';
import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { useAction } from '../hooks.ts';
import { useI18n } from '../i18n.tsx';
import { ErrorNote } from './ui.tsx';

export function renderTemplate(body: string, params: string[]) {
  return body.replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n: string) => params[Number(n) - 1] || `{{${n}}}`);
}

export function DraftCard({ draft, onChanged, templates }: { draft: DraftDto; onChanged: () => void; templates?: TemplateDto[] }) {
  const { t, relative } = useI18n();
  const [body, setBody] = useState(draft.body ?? '');
  const action = useAction();
  const dirty = draft.body !== null && body !== draft.body;

  useEffect(() => setBody(draft.body ?? ''), [draft.body]);

  const label = draft.source === 'ai' ? t.aiDraft : draft.source === 'mcp' ? t.viaMcp : t.staffDraft;
  const tpl = draft.template && templates?.find((x) => x.name === draft.template!.name && x.language === draft.template!.language);

  const act = (fn: () => Promise<unknown>) =>
    action.run(async () => {
      await fn();
      onChanged();
    });

  return (
    <div className={`draft-card state-${draft.state}`}>
      <div className="draft-head">
        <span className="chip chip-accent">{label}</span>
        <span className="muted small">{relative(draft.createdAt)}</span>
        {draft.state === 'failed' && <span className="chip prio-urgent">{t.failed}</span>}
      </div>
      {draft.rationale && <div className="muted small draft-rationale">{draft.rationale}</div>}
      {draft.template ? (
        <div className="template-preview" dir="auto">
          <span className="chip chip-muted">
            {t.template}: {draft.template.name} ({draft.template.language})
          </span>
          <p>{tpl ? renderTemplate(tpl.body, draft.template.params) : draft.template.params.join(' · ')}</p>
        </div>
      ) : (
        <textarea
          dir="auto"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={Math.min(8, Math.max(2, body.split('\n').length + 1))}
          disabled={draft.state !== 'pending' || action.busy}
          maxLength={4096}
        />
      )}
      {draft.error && <div className="error-note small">{draft.error}</div>}
      <ErrorNote error={action.error} />
      <div className="draft-actions">
        {draft.state === 'pending' && (
          <>
            {dirty && (
              <button className="btn" disabled={action.busy} onClick={() => act(() => api.editDraft(draft.id, body))}>
                {t.save}
              </button>
            )}
            <button
              className="btn btn-primary"
              disabled={action.busy || dirty}
              onClick={() => act(() => api.approve(draft.id))}
              title={dirty ? t.save : undefined}
            >
              {t.approveSend}
            </button>
            <button className="btn btn-ghost" disabled={action.busy} onClick={() => act(() => api.reject(draft.id))}>
              {t.reject}
            </button>
          </>
        )}
        {draft.state === 'failed' && (
          <button className="btn" disabled={action.busy} onClick={() => act(() => api.retry(draft.id))}>
            {t.retry}
          </button>
        )}
      </div>
    </div>
  );
}

export function DraftPanel({
  conversation,
  drafts,
  onChanged,
}: {
  conversation: ConversationListItem;
  drafts: DraftDto[];
  onChanged: () => void;
}) {
  const { t, fmt } = useI18n();
  const [text, setText] = useState('');
  const [instructions, setInstructions] = useState('');
  const [templates, setTemplates] = useState<TemplateDto[]>([]);
  const [tplKey, setTplKey] = useState('');
  const [params, setParams] = useState<string[]>([]);
  const action = useAction();
  const active = drafts.filter((d) => d.state === 'pending' || d.state === 'failed');

  useEffect(() => {
    api.templates().then((r) => setTemplates(r.items), () => setTemplates([]));
  }, []);

  const tpl = templates.find((x) => `${x.name}:${x.language}` === tplKey);

  const done = () => {
    setText('');
    setInstructions('');
    setTplKey('');
    setParams([]);
    onChanged();
  };

  return (
    <div className="draft-panel">
      {active.length > 0 && (
        <div className="draft-list">
          <div className="section-label">{t.pendingApproval}</div>
          {active.map((d) => (
            <DraftCard key={d.id} draft={d} onChanged={onChanged} templates={templates} />
          ))}
        </div>
      )}

      <div className="composer">
        {conversation.windowOpen ? (
          <>
            <textarea dir="auto" value={text} onChange={(e) => setText(e.target.value)} placeholder={t.writeReply} rows={2} maxLength={4096} />
            <div className="composer-row">
              <input
                dir="auto"
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                placeholder={t.instructionsPh}
                className="grow"
              />
              <button
                className="btn"
                disabled={action.busy}
                onClick={() => action.run(async () => (await api.generateDraft(conversation.id, instructions), done()))}
              >
                ✦ {action.busy ? '…' : t.generate}
              </button>
              <button
                className="btn btn-primary"
                disabled={action.busy || !text.trim()}
                onClick={() => action.run(async () => (await api.createTextDraft(conversation.id, text), done()))}
              >
                {t.addDraft}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="warn small">{t.windowClosed}</div>
            <div className="composer-row">
              <select
                value={tplKey}
                onChange={(e) => {
                  setTplKey(e.target.value);
                  const next = templates.find((x) => `${x.name}:${x.language}` === e.target.value);
                  setParams(Array(next?.paramCount ?? 0).fill(''));
                }}
                className="grow"
              >
                <option value="">{t.chooseTemplate}</option>
                {templates.map((x) => (
                  <option key={`${x.name}:${x.language}`} value={`${x.name}:${x.language}`}>
                    {x.name} ({x.language}) · {x.category}
                  </option>
                ))}
              </select>
            </div>
            {tpl && (
              <>
                <div className="composer-row wrap">
                  {params.map((p, i) => (
                    <input
                      key={i}
                      dir="auto"
                      value={p}
                      placeholder={fmt(t.param, { n: i + 1 })}
                      onChange={(e) => setParams(params.map((v, j) => (j === i ? e.target.value : v)))}
                    />
                  ))}
                </div>
                <p className="template-preview" dir="auto">
                  {renderTemplate(tpl.body, params)}
                </p>
                <div className="composer-row">
                  <span className="grow" />
                  <button
                    className="btn btn-primary"
                    disabled={action.busy || params.some((p) => !p.trim())}
                    onClick={() =>
                      action.run(async () => (await api.createTemplateDraft(conversation.id, { name: tpl.name, language: tpl.language, params }), done()))
                    }
                  >
                    {t.addDraft}
                  </button>
                </div>
              </>
            )}
          </>
        )}
        <ErrorNote error={action.error} />
      </div>
    </div>
  );
}
