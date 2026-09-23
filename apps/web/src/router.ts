import { useEffect, useState } from 'react';

// Hash routes: #/inbox, #/c/<conversationId>, #/approvals, #/search, #/reports, #/settings, #/audit
export function useRoute(): string[] {
  const read = () => (window.location.hash.replace(/^#\/?/, '') || 'inbox').split('/');
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export const go = (path: string) => {
  window.location.hash = `/${path}`;
};
