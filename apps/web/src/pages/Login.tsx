import { useState, type FormEvent } from 'react';
import { api } from '../api.ts';
import { ErrorNote } from '../components/ui.tsx';
import { useAction } from '../hooks.ts';
import { useI18n } from '../i18n.tsx';

export function Login({ onDone }: { onDone: () => void }) {
  const { t, lang, setLang } = useI18n();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const action = useAction();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void action.run(async () => {
      await api.login(email, password);
      onDone();
    });
  };

  return (
    <div className="login">
      <form className="card login-card" onSubmit={submit}>
        <div className="brand">
          <span className="brand-mark">✦</span> {t.appName}
        </div>
        <label>
          {t.email}
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} dir="ltr" required />
        </label>
        <label>
          {t.password}
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} dir="ltr" required />
        </label>
        <ErrorNote error={action.error} />
        <button className="btn btn-primary" disabled={action.busy}>
          {t.signIn}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')}>
          {lang === 'ar' ? 'English' : 'العربية'}
        </button>
      </form>
    </div>
  );
}
