import { api } from '../api.ts';
import { DraftCard } from '../components/DraftPanel.tsx';
import { Avatar, Empty, ErrorNote, phone } from '../components/ui.tsx';
import { useLoad } from '../hooks.ts';
import { useI18n } from '../i18n.tsx';
import { go } from '../router.ts';

export function Approvals() {
  const { t } = useI18n();
  const drafts = useLoad(() => api.pendingDrafts(), [], 5000);
  const templates = useLoad(() => api.templates(), []);

  return (
    <div className="page">
      <h1>{t.approvals}</h1>
      <ErrorNote error={drafts.error} />
      {drafts.data?.items.length === 0 && <Empty>{t.noPending}</Empty>}
      <div className="approval-grid">
        {drafts.data?.items.map((d) => (
          <div key={d.id} className="card">
            <div className="approval-head">
              <Avatar name={d.contactName} id={d.waId} />
              <strong dir="auto">{d.contactName ?? phone(d.waId)}</strong>
              <span className="grow" />
              <button className="btn btn-ghost btn-sm" onClick={() => go(`c/${d.conversationId}`)}>
                {t.open} →
              </button>
            </div>
            <DraftCard draft={d} onChanged={drafts.reload} templates={templates.data?.items} />
          </div>
        ))}
      </div>
    </div>
  );
}
