import type { Intent, Priority } from '@wa/shared';
import { useState, type ReactNode } from 'react';
import { useI18n } from '../i18n.tsx';

export function PriorityChip({ priority }: { priority: Priority | null }) {
  const { t } = useI18n();
  if (!priority) return null;
  return <span className={`chip prio-${priority}`}>{t.priority[priority]}</span>;
}

export function IntentChip({ intent }: { intent: Intent | null }) {
  const { t } = useI18n();
  if (!intent) return null;
  return <span className="chip chip-muted">{t.intent[intent] ?? intent}</span>;
}

export function Avatar({ name, id }: { name: string | null; id: string }) {
  const label = (name ?? id).trim();
  const initials = label.split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360;
  return (
    <span className="avatar" style={{ background: `hsl(${h} 45% 45%)` }} aria-hidden>
      {initials}
    </span>
  );
}

export function ErrorNote({ error }: { error: string | null }) {
  const { t } = useI18n();
  if (!error) return null;
  return (
    <div className="error-note" role="alert">
      {t.error}: {error}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function CopyButton({ text }: { text: string }) {
  const { t } = useI18n();
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn btn-ghost btn-sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          // clipboard blocked; user can select the text manually
        }
      }}
    >
      {done ? t.copied : t.copy}
    </button>
  );
}

export const phone = (waId: string) => `+${waId}`;
