import type { ReportDto } from '@wa/shared';
import { useState } from 'react';
import { api } from '../api.ts';
import { Empty, ErrorNote } from '../components/ui.tsx';
import { useAction, useLoad } from '../hooks.ts';
import { useI18n, type Lang } from '../i18n.tsx';
import { go } from '../router.ts';

export function Reports() {
  const { t, lang, time } = useI18n();
  const list = useLoad(() => api.reports(), []);
  const [selected, setSelected] = useState<string | null>(null);
  const [period, setPeriod] = useState<'24h' | '7d'>('24h');
  const [language, setLanguage] = useState<Lang>(lang);
  const action = useAction();

  const report = list.data?.items.find((r) => r.id === selected) ?? list.data?.items[0] ?? null;

  const generate = () =>
    action.run(async () => {
      const hours = period === '24h' ? 24 : 24 * 7;
      const r = await api.generateReport({ since: new Date(Date.now() - hours * 3600_000).toISOString(), language });
      await list.reload();
      setSelected(r.id);
    });

  return (
    <div className="page">
      <h1>{t.reports}</h1>
      <div className="composer-row wrap card">
        <select value={period} onChange={(e) => setPeriod(e.target.value as '24h' | '7d')}>
          <option value="24h">{t.last24h}</option>
          <option value="7d">{t.last7d}</option>
        </select>
        <select value={language} onChange={(e) => setLanguage(e.target.value as Lang)} aria-label={t.language}>
          <option value="en">English</option>
          <option value="ar">العربية</option>
        </select>
        <button className="btn btn-primary" disabled={action.busy} onClick={generate}>
          {action.busy ? '…' : t.generateReport}
        </button>
        <span className="grow" />
        {list.data && list.data.items.length > 0 && (
          <select value={report?.id ?? ''} onChange={(e) => setSelected(e.target.value)}>
            {list.data.items.map((r) => (
              <option key={r.id} value={r.id}>
                {time(r.createdAt)} · {r.language.toUpperCase()}
              </option>
            ))}
          </select>
        )}
      </div>
      <ErrorNote error={action.error ?? list.error} />
      {list.data?.items.length === 0 && <Empty>{t.noReports}</Empty>}
      {report && <ReportView report={report} />}
    </div>
  );
}

function ReportView({ report }: { report: ReportDto }) {
  const { t, time } = useI18n();
  const s = report.stats;
  const tiles: [string, string | number][] = [
    [t.inboundMsgs, s.inbound],
    [t.outboundMsgs, s.outbound],
    [t.conversations, s.conversations],
    [t.waiting, `${s.needsReplyOpen} (${s.urgentOpen} ${t.urgent})`],
    [t.medianResponse, s.medianFirstResponseMinutes === null ? '—' : `${s.medianFirstResponseMinutes} ${t.minutes}`],
  ];
  const maxIntent = Math.max(1, ...Object.values(s.byIntent));
  return (
    <div className="report">
      <p className="muted small">
        {time(report.periodStart)} – {time(report.periodEnd)}
      </p>
      <div className="tiles">
        {tiles.map(([label, value]) => (
          <div key={label} className="tile">
            <div className="tile-value">{value}</div>
            <div className="tile-label">{label}</div>
          </div>
        ))}
      </div>
      <div className="report-cols">
        <div className="card">
          <h3>{t.byIntent}</h3>
          {Object.entries(s.byIntent)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => (
              <div key={k} className="bar-row">
                <span className="bar-label">{t.intent[k as keyof typeof t.intent] ?? k}</span>
                <span className="bar-track">
                  <span className="bar-fill" style={{ inlineSize: `${(v / maxIntent) * 100}%` }} />
                </span>
                <span className="bar-value">{v}</span>
              </div>
            ))}
          <h3>{t.bySentiment}</h3>
          <div className="composer-row wrap">
            {Object.entries(s.bySentiment).map(([k, v]) => (
              <span key={k} className={`chip sentiment-${k}`}>
                {t.sentiment[k as keyof typeof t.sentiment] ?? k}: {v}
              </span>
            ))}
          </div>
        </div>
        <div className="card">
          <h3>{t.actionItems}</h3>
          <ul className="action-list">
            {s.actionItems.map((a, i) => (
              <li key={i}>
                <button className="link" onClick={() => go(`c/${a.conversationId}`)}>
                  {a.contact}
                </button>
                : <span dir="auto">{a.item}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="card narrative" dir={report.language === 'ar' ? 'rtl' : 'ltr'} lang={report.language}>
        {report.narrative}
      </div>
    </div>
  );
}
