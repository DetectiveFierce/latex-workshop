import { useEffect, useMemo } from 'react';
import { Link } from '@tanstack/react-router';
import {
  parseOAuthConsentQuery,
  preservedOAuthConsentQuery,
} from '../features/agent-proposals/oauthConsentQuery';
import { appPath } from '../lib/api';
import { authClient } from '../lib/auth';
import { AccountSettingsContent } from './AccountPage';
import '../styles/auth.css';

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

  return (
    <main className="workshop-auth workshop-consent">
      <header className="running-head">
        <span>
          <a href="/" className="sc">
            Mind Palace
          </a>
          <span> · LaTeX Workshop</span>
        </span>
        <i>Private instance</i>
      </header>
      <Link to="/projects" search={{}} className="crumb">
        Projects
      </Link>
      <section className="workshop-consent-body">
        <h1 className="display">Agent access</h1>
        {!pendingConsent.clientId ? (
          <p className="field-error" role="alert">
            This connection request is missing its client id. Start the connection again from your
            agent.
          </p>
        ) : (
          <AccountSettingsContent pendingConsent={pendingConsent} />
        )}
      </section>
    </main>
  );
}
