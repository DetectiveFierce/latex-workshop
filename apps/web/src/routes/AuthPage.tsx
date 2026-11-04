import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { MailCheck } from 'lucide-react';
import { Button } from '../components/Button';
import { authClient } from '../lib/auth';
import { appPath } from '../lib/api';
import { oauthAuthorizationQuery } from '../features/agent-proposals/oauthConsentQuery';
import '../styles/auth.css';

type Mode = 'signin' | 'signup' | 'forgot' | 'reset';

function localNext(search: URLSearchParams) {
  const raw = search.get('next');
  if (!raw) return null;
  try {
    const next = new URL(raw, window.location.origin);
    return next.origin === window.location.origin ? next.href : null;
  } catch {
    return null;
  }
}

export function AuthPage() {
  const navigate = useNavigate();
  const { data: session, isPending } = authClient.useSession();
  const search = new URLSearchParams(window.location.search);
  const [mode, setMode] = useState<Mode>(
    search.get('token') ? 'reset' : search.get('signup') === 'true' ? 'signup' : 'signin',
  );
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function continueOAuth() {
    const oauthQuery = oauthAuthorizationQuery(window.location.search);
    if (!oauthQuery) return false;
    const response = await fetch(appPath('/api/auth/oauth2/continue'), {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ postLogin: true, oauth_query: oauthQuery }),
    });
    const result = (await response.json()) as { url?: unknown; redirect_uri?: unknown };
    if (!response.ok) throw new Error('Unable to continue agent authorization');
    const destination = typeof result.url === 'string' ? result.url : result.redirect_uri;
    if (typeof destination !== 'string')
      throw new Error('Authorization continuation was incomplete');
    window.location.assign(destination);
    return true;
  }

  useEffect(() => {
    if (!session) return;
    const next = localNext(search);
    if (next) window.location.assign(next);
    else if (oauthAuthorizationQuery(window.location.search)) void continueOAuth();
    else void navigate({ to: '/projects', search: {} });
  }, [session, navigate]);
  if (isPending)
    return (
      <main className="screen-center">
        <span className="spinner" />
        <p>Checking your session…</p>
      </main>
    );

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    setMessage('');
    setSubmitting(true);
    try {
      if (mode === 'signin') {
        const result = await authClient.signIn.email({ email, password });
        if (result.error) throw new Error(result.error.message);
        const next = localNext(search);
        if (next) window.location.assign(next);
        else if (!(await continueOAuth())) await navigate({ to: '/projects', search: {} });
      } else if (mode === 'signup') {
        if (password !== confirm) throw new Error('Passwords do not match');
        const result = await authClient.signUp.email({
          name,
          email,
          password,
          callbackURL: `${window.location.origin}${appPath('/projects')}`,
        });
        if (result.error) throw new Error(result.error.message);
        setMessage('Check your inbox to verify your email, then sign in.');
      } else if (mode === 'forgot') {
        const result = await authClient.requestPasswordReset({
          email,
          redirectTo: `${window.location.origin}${appPath('/auth')}`,
        });
        if (result.error) throw new Error(result.error.message);
        setMessage('If that address has an account, a reset link is on its way.');
      } else {
        if (password !== confirm) throw new Error('Passwords do not match');
        const token = search.get('token');
        if (!token) throw new Error('The password reset link is missing its token.');
        const result = await authClient.resetPassword({ newPassword: password, token });
        if (result.error) throw new Error(result.error.message);
        setMessage('Password changed. You can now sign in.');
        setMode('signin');
        setPassword('');
        setConfirm('');
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to continue');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="workshop-auth">
      <header className="running-head">
        <span>
          <a href="/" className="sc">
            Mind Palace
          </a>
          <span> · LaTeX Workshop</span>
        </span>
        <i>Private instance</i>
      </header>
      <div className="workshop-auth-columns">
        <section className="workshop-auth-intro">
          <h1>LaTeX Workshop</h1>
          <pre className="workshop-auth-code" aria-label="LaTeX document example">
            <code>
              <span className="syntax-command">{'\\documentclass'}</span>
              {'{'}
              <span className="syntax-type">article</span>
              {'}'}
              {'\n'}
              <span className="syntax-command">{'\\begin'}</span>
              {'{'}
              <span className="syntax-type">document</span>
              {'}'}
              {'\n'}
              <span className="syntax-comment"> % Your work here.</span>
              {'\n'}
              <span className="syntax-command">{'\\end'}</span>
              {'{'}
              <span className="syntax-type">document</span>
              {'}'}
            </code>
          </pre>
        </section>
        <section className="workshop-auth-panel">
          <h2>
            {mode === 'signin'
              ? 'Sign in'
              : mode === 'signup'
                ? 'Create account'
                : mode === 'forgot'
                  ? 'Reset password'
                  : 'New password'}
          </h2>
          {message ? (
            <div className="workshop-auth-message" role="status">
              <MailCheck size={24} aria-hidden="true" />
              <p>{message}</p>
            </div>
          ) : (
            <form className="workshop-auth-form" onSubmit={submit}>
              {mode === 'signup' && (
                <label>
                  Name
                  <input
                    className="fld fld-auth"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    required
                    autoComplete="name"
                  />
                </label>
              )}
              {mode !== 'reset' && (
                <label>
                  Email
                  <input
                    className="fld fld-auth"
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    required
                    autoComplete="email"
                  />
                </label>
              )}
              {mode !== 'forgot' && (
                <label>
                  {mode === 'reset' ? 'New password' : 'Password'}
                  <input
                    className="fld fld-auth"
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    minLength={8}
                    required
                    autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                  />
                </label>
              )}
              {(mode === 'signup' || mode === 'reset') && (
                <label>
                  Confirm password
                  <input
                    className="fld fld-auth"
                    type="password"
                    value={confirm}
                    onChange={(event) => setConfirm(event.target.value)}
                    minLength={8}
                    required
                    autoComplete="new-password"
                  />
                </label>
              )}
              {error && (
                <p className="field-error" role="alert">
                  {error}
                </p>
              )}
              <Button variant="primary" type="submit" className="btn-lg" disabled={submitting}>
                {submitting
                  ? 'Signing in'
                  : mode === 'signin'
                    ? 'Sign in'
                    : mode === 'signup'
                      ? 'Create account'
                      : mode === 'forgot'
                        ? 'Send reset link'
                        : 'Change password'}
              </Button>
            </form>
          )}
          <div className="workshop-auth-links">
            {mode === 'signin' && (
              <button
                type="button"
                onClick={() => {
                  setMode('forgot');
                  setMessage('');
                  setError('');
                }}
              >
                Reset password
              </button>
            )}
            {mode === 'signin' &&
              new URLSearchParams(window.location.search).get('signup') === 'true' && (
                <button
                  type="button"
                  onClick={() => {
                    setMode('signup');
                    setMessage('');
                    setError('');
                  }}
                >
                  Create account
                </button>
              )}
            {mode !== 'signin' || message ? (
              <button
                type="button"
                onClick={() => {
                  setMode('signin');
                  setMessage('');
                  setError('');
                }}
              >
                Back to sign in
              </button>
            ) : null}
          </div>
        </section>
      </div>
    </main>
  );
}
