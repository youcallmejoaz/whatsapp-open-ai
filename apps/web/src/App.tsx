import { useCallback, useEffect, useState } from 'react';
import { api, type Me } from './api.ts';
import { useLoad } from './hooks.ts';
import { useI18n } from './i18n.tsx';
import { Approvals } from './pages/Approvals.tsx';
import { Audit } from './pages/Audit.tsx';
import { Inbox } from './pages/Inbox.tsx';
import { Login } from './pages/Login.tsx';
import { Reports } from './pages/Reports.tsx';
import { Search } from './pages/Search.tsx';
import { Settings } from './pages/Settings.tsx';
import { useRoute } from './router.ts';

export function App() {
  // undefined = still checking the session, null = signed out.
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const refresh = useCallback(async () => setMe(await api.me().catch(() => null)), []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (me === undefined) return null;
  if (me === null) return <Login onDone={refresh} />;
  return <Shell me={me} onSignOut={refresh} />;
}

function Shell({ me, onSignOut }: { me: Me; onSignOut: () => Promise<void> }) {
  const { t, lang, setLang } = useI18n();
  const [page, arg] = useRoute();
  const pending = useLoad(() => api.conversations('needs_reply'), [], 8000);
  const counts = pending.data?.counts;

  const nav: [string, string, number | undefined][] = [
    ['inbox', t.inbox, counts?.needs_reply],
    ['approvals', t.approvals, counts?.pending_drafts],
    ['search', t.search, undefined],
    ['reports', t.reports, undefined],
    ['settings', t.settings, undefined],
    ...(me.user.role === 'admin' ? ([['audit', t.audit, undefined]] as [string, string, undefined][]) : []),
  ];
  const current = page === 'c' ? 'inbox' : page;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">✦</span> <span className="brand-name">{t.appName}</span>
        </div>
        <nav>
          {nav.map(([key, label, n]) => (
            <a key={key} href={`#/${key}`} className={`nav-item ${current === key ? 'active' : ''}`}>
              <span>{label}</span>
              {!!n && <span className="count">{n}</span>}
            </a>
          ))}
        </nav>
        <div className="sidebar-foot">
          {me.config.waMode === 'mock' && <div className="badge-mode">{t.mockMode}</div>}
          {me.config.ai === 'mock' && <div className="badge-mode">{t.mockAi}</div>}
          <button className="btn btn-ghost btn-sm" onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')}>
            {lang === 'ar' ? 'English' : 'العربية'}
          </button>
          <div className="muted small">{me.user.email}</div>
          <button className="btn btn-ghost btn-sm" onClick={() => api.logout().then(onSignOut)}>
            {t.signOut}
          </button>
        </div>
      </aside>
      <main className="main">
        {current === 'inbox' && <Inbox selectedId={page === 'c' ? (arg ?? null) : null} />}
        {current === 'approvals' && <Approvals />}
        {current === 'search' && <Search />}
        {current === 'reports' && <Reports />}
        {current === 'settings' && <Settings />}
        {current === 'audit' && <Audit />}
      </main>
    </div>
  );
}
