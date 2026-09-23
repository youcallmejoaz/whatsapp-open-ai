import type { SearchHit } from '@wa/shared';
import { useState, type FormEvent } from 'react';
import { api } from '../api.ts';
import { Empty, ErrorNote, phone } from '../components/ui.tsx';
import { useAction } from '../hooks.ts';
import { useI18n } from '../i18n.tsx';
import { go } from '../router.ts';

export function Search() {
  const { t, time } = useI18n();
  const [query, setQuery] = useState('');
  const [since, setSince] = useState('');
  const [until, setUntil] = useState('');
  const [direction, setDirection] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const action = useAction();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    void action.run(async () => {
      const r = await api.search({
        q: query,
        since: since ? new Date(since).toISOString() : undefined,
        until: until ? new Date(until).toISOString() : undefined,
        direction: direction || undefined,
      });
      setHits(r.items);
    });
  };

  return (
    <div className="page">
      <h1>{t.search}</h1>
      <form className="search-form" onSubmit={submit}>
        <input dir="auto" className="search-input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t.searchPh} autoFocus />
        <div className="composer-row wrap">
          <label>
            {t.since} <input type="date" value={since} onChange={(e) => setSince(e.target.value)} />
          </label>
          <label>
            {t.until} <input type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
          </label>
          <label>
            {t.direction}{' '}
            <select value={direction} onChange={(e) => setDirection(e.target.value)}>
              <option value="">{t.any}</option>
              <option value="in">{t.incoming}</option>
              <option value="out">{t.outgoing}</option>
            </select>
          </label>
          <span className="grow" />
          <button className="btn btn-primary" disabled={action.busy}>
            {t.search}
          </button>
        </div>
      </form>
      <ErrorNote error={action.error} />
      {hits?.length === 0 && <Empty>{t.noResults}</Empty>}
      <ul className="hits">
        {hits?.map((h) => (
          <li key={h.messageId}>
            <button className="hit" onClick={() => go(`c/${h.conversationId}`)}>
              <span className="hit-top">
                <strong dir="auto">{h.contactName ?? phone(h.waId)}</strong>
                <span className="chip chip-muted">{h.direction === 'in' ? t.incoming : t.outgoing}</span>
                <span className="grow" />
                <time className="muted small">{time(h.createdAt)}</time>
              </span>
              <span className="hit-text" dir="auto">
                <Highlight text={h.text} query={query} />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Highlight({ text, query }: { text: string; query: string }) {
  const words = query.split(/\s+/).filter((w) => w.length > 1).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!words.length) return <>{text}</>;
  const parts = text.split(new RegExp(`(${words.join('|')})`, 'gi'));
  return <>{parts.map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : p))}</>;
}
