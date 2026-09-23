import type { ConversationDetail, ConversationListItem, MessageDto } from '@wa/shared';
import { useEffect, useRef, useState } from 'react';
import { api, type InboxFilter } from '../api.ts';
import { DraftPanel } from '../components/DraftPanel.tsx';
import { Avatar, Empty, ErrorNote, IntentChip, phone, PriorityChip } from '../components/ui.tsx';
import { useAction, useLoad } from '../hooks.ts';
import { useI18n } from '../i18n.tsx';
import { go } from '../router.ts';

export function Inbox({ selectedId }: { selectedId: string | null }) {
  const { t } = useI18n();
  const [filter, setFilter] = useState<InboxFilter>('needs_reply');
  const list = useLoad(() => api.conversations(filter), [filter], 4000);

  return (
    <div className={`inbox ${selectedId ? 'has-selection' : ''}`}>
      <section className="conv-list" aria-label={t.inbox}>
        <div className="tabs" role="tablist">
          {(['needs_reply', 'urgent', 'all'] as const).map((f) => (
            <button key={f} role="tab" aria-selected={filter === f} className={`tab ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>
              {f === 'needs_reply' ? t.needsReply : f === 'urgent' ? t.urgent : t.all}
              {list.data && <span className="count">{list.data.counts[f]}</span>}
            </button>
          ))}
        </div>
        <ErrorNote error={list.error} />
        <ul>
          {list.data?.items.map((c) => (
            <ConversationRow key={c.id} c={c} selected={c.id === selectedId} />
          ))}
        </ul>
        {list.data && list.data.items.length === 0 && <Empty>{t.noConversations}</Empty>}
      </section>
      <section className="conv-pane">
        {selectedId ? (
          <ConversationView key={selectedId} id={selectedId} onChanged={list.reload} />
        ) : (
          <Empty>{t.selectConversation}</Empty>
        )}
      </section>
    </div>
  );
}

function ConversationRow({ c, selected }: { c: ConversationListItem; selected: boolean }) {
  const { t, relative } = useI18n();
  return (
    <li>
      <button className={`conv-row ${selected ? 'selected' : ''} ${c.priority === 'urgent' && c.needsReply ? 'is-urgent' : ''}`} onClick={() => go(`c/${c.id}`)}>
        <Avatar name={c.contact.name} id={c.contact.waId} />
        <span className="conv-row-main">
          <span className="conv-row-top">
            <span className="conv-name" dir="auto">{c.contact.name ?? phone(c.contact.waId)}</span>
            <time className="muted small">{relative(c.lastMessageAt)}</time>
          </span>
          <span className="conv-snippet" dir="auto">
            {c.lastText}
          </span>
          <span className="conv-row-chips">
            {c.needsReply && <PriorityChip priority={c.priority} />}
            {c.needsReply && <IntentChip intent={c.intent} />}
            {c.pendingDrafts > 0 && <span className="chip chip-accent">✎ {c.pendingDrafts}</span>}
            {!c.windowOpen && <span className="chip chip-muted" title={t.windowClosed}>⏱</span>}
            {c.unread > 0 && !selected && <span className="unread-dot" aria-label="unread" />}
          </span>
        </span>
      </button>
    </li>
  );
}

function ConversationView({ id, onChanged }: { id: string; onChanged: () => void }) {
  const { t, fmt } = useI18n();
  const detail = useLoad(() => api.conversation(id), [id], 4000);
  const bottom = useRef<HTMLDivElement>(null);
  const lastCount = useRef(0);

  useEffect(() => {
    const n = detail.data?.messages.length ?? 0;
    if (n !== lastCount.current) bottom.current?.scrollIntoView({ block: 'end' });
    lastCount.current = n;
  }, [detail.data?.messages.length]);

  if (!detail.data) return <ErrorNote error={detail.error} />;
  const { conversation: c, messages } = detail.data;
  const hoursLeft = c.lastInboundAt ? Math.max(0, 24 - (Date.now() - new Date(c.lastInboundAt).getTime()) / 3600_000) : 0;

  const refresh = () => {
    void detail.reload();
    onChanged();
  };

  return (
    <div className="conv-view">
      <header className="conv-header">
        <button className="btn btn-ghost btn-sm back" onClick={() => go('inbox')} aria-label="Back">
          ←
        </button>
        <Avatar name={c.contact.name} id={c.contact.waId} />
        <div className="conv-header-main">
          <h2 dir="auto">{c.contact.name ?? phone(c.contact.waId)}</h2>
          <div className="muted small">
            <span dir="ltr">{phone(c.contact.waId)}</span> ·{' '}
            <span className={c.windowOpen ? 'ok' : 'warn'}>
              {c.windowOpen ? fmt(t.windowLeft, { h: Math.floor(hoursLeft) }) : t.windowClosed}
            </span>
          </div>
        </div>
        <div className="conv-header-chips">
          {c.needsReply && <PriorityChip priority={c.priority} />}
          {c.needsReply && <IntentChip intent={c.intent} />}
        </div>
      </header>

      <SummaryCard id={id} detail={detail.data} />

      <div className="messages">
        {messages.map((m) => (
          <Bubble key={m.id} m={m} />
        ))}
        <div ref={bottom} />
      </div>

      <DraftPanel conversation={c} drafts={detail.data.drafts} onChanged={refresh} />
    </div>
  );
}

function SummaryCard({ id, detail }: { id: string; detail: ConversationDetail }) {
  const { t, lang, relative } = useI18n();
  const [summary, setSummary] = useState(detail.summary);
  const [open, setOpen] = useState(false);
  const action = useAction();

  const load = (force: boolean) =>
    action.run(async () => {
      setSummary(await api.summarize(id, { force, language: lang }));
      setOpen(true);
    });

  return (
    <div className="summary-card">
      <div className="summary-head">
        <button className="summary-toggle" onClick={() => (summary ? setOpen(!open) : load(false))} aria-expanded={open}>
          ✦ {t.summary}
          {summary && <span className="muted small"> · {relative(summary.updatedAt)}</span>}
        </button>
        <button className="btn btn-ghost btn-sm" disabled={action.busy} onClick={() => load(!!summary)}>
          {action.busy ? '…' : summary ? t.refresh : t.summarize}
        </button>
      </div>
      <ErrorNote error={action.error} />
      {summary && open && (
        <div className="summary-body" dir="auto">
          <p>{summary.summary}</p>
          {summary.open_questions.length > 0 && (
            <>
              <h4>{t.openQuestions}</h4>
              <ul>{summary.open_questions.map((q, i) => <li key={i} dir="auto">{q}</li>)}</ul>
            </>
          )}
          {summary.action_items.length > 0 && (
            <>
              <h4>{t.actionItems}</h4>
              <ul>{summary.action_items.map((q, i) => <li key={i} dir="auto">{q}</li>)}</ul>
            </>
          )}
          <p className="muted small">
            {t.mood}: {t.sentiment[summary.customer_mood]}
          </p>
        </div>
      )}
    </div>
  );
}

const STATUS_TICKS: Record<string, string> = { sent: '✓', delivered: '✓✓', read: '✓✓', failed: '!' };

function Bubble({ m }: { m: MessageDto }) {
  const { t, time } = useI18n();
  const out = m.direction === 'out';
  const origin =
    m.source === 'echo' ? t.fromPhone : m.source === 'history' ? t.history : m.source === 'import' ? t.imported : null;
  return (
    <div className={`bubble-row ${out ? 'out' : 'in'}`}>
      <div className={`bubble ${out ? 'bubble-out' : 'bubble-in'}`}>
        {m.type === 'audio' && (
          <div className="voice">
            🎤 {t.voiceNote}
            {m.transcript && <span className="muted small"> · {t.transcript}</span>}
          </div>
        )}
        {m.type === 'image' && <div className="media-tag">🖼</div>}
        {m.type === 'template' && <div className="media-tag small muted">{t.template}</div>}
        <div className="bubble-text" dir="auto">
          {m.text ?? m.transcript ?? <span className="muted">[{m.type}]</span>}
        </div>
        <div className="bubble-meta">
          {origin && <span>{origin} · </span>}
          <time>{time(m.createdAt)}</time>
          {out && m.status && <span className={`ticks ${m.status}`}> {STATUS_TICKS[m.status] ?? ''}</span>}
        </div>
        {m.triage && (
          <div className="triage" dir="auto">
            <PriorityChip priority={m.triage.priority} />
            <IntentChip intent={m.triage.intent} />
            <span className="muted small">{m.triage.summary}</span>
            {m.triage.action_items.map((a, i) => (
              <div key={i} className="action-item small">
                ☐ {a}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
