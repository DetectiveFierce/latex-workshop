import { useEffect, useMemo } from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { Logo } from '../components/Logo';
import {
  parseOAuthConsentQuery,
  preservedOAuthConsentQuery,
} from '../features/agent-proposals/oauthConsentQuery';
import { appPath } from '../lib/api';
import { authClient } from '../lib/auth';
import { AccountSettingsContent } from './AccountPage';

export function OAuthConsentPage() {
  const { data: session, isPending } = authClient.useSession();
  const pendingConsent = useMemo(
    () => parseOAuthConsentQuery(preservedOAuthConsentQuery(window.location.search)),
    [],
  );

  useEffect(() => {
    if (isPending || session?.user) return;
    const next = encodeURIComponent(window.location.href);
    window.location.assign(
      `${appPath('/auth')}?next=${next}&oauth_query=${encodeURIComponent(pendingConsent.oauthQuery)}`,
    );
  }, [isPending, pendingConsent.oauthQuery, session?.user]);

  if (!session?.user)
    return (
      <main className="screen-center">
        <span className="spinner" />
        <p>Checking your account…</p>
      </main>
    );

  if (!pendingConsent.clientId)
    return (
      <div className="app-shell">
        <header className="topbar">
          <Logo />
          <Link to="/projects" search={{}} className="button button-ghost">
            <ArrowLeft size={16} /> Projects
          </Link>
        </header>
        <main className="account-card">
          <h1>Account settings</h1>
          <p className="field-error" role="alert">
            This agent connection request is missing its client id. Close this tab and start the
            connection again from your agent.
          </p>
        </main>
      </div>
    );

  return (
    <div className="app-shell">
      <header className="topbar">
        <Logo />
        <Link to="/projects" search={{}} className="button button-ghost">
          <ArrowLeft size={16} /> Projects
        </Link>
      </header>
      <main className="account-card">
        <h1>Account settings</h1>
        <AccountSettingsContent pendingConsent={pendingConsent} />
      </main>
    </div>
  );
}
