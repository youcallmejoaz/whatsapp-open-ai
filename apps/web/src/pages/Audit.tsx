import { api } from '../api.ts';
import { ErrorNote } from '../components/ui.tsx';
import { useLoad } from '../hooks.ts';
import { useI18n } from '../i18n.tsx';

export function Audit() {
  const { t, time } = useI18n();
  const log = useLoad(() => api.audit(), [], 10000);
  return (
    <div className="page">
      <h1>{t.audit}</h1>
      <ErrorNote error={log.error} />
      <div className="table-wrap">
        <table className="table">
          <tbody>
            {log.data?.items.map((a) => (
              <tr key={a.id}>
                <td className="muted small nowrap">{time(a.at)}</td>
                <td>
                  <code>{a.action}</code>
                </td>
                <td className="small">{a.actorType === 'user' ? a.actor : `${a.actorType}${a.actor ? `:${a.actor.slice(0, 8)}` : ''}`}</td>
                <td className="muted small" dir="auto">
                  {a.details ? JSON.stringify(a.details).slice(0, 140) : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
