import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { ArrowRight, MailCheck } from 'lucide-react';
import { Button } from '../components/Button';
import { Logo } from '../components/Logo';
import { authClient } from '../lib/auth';
import { appPath } from '../lib/api';

type Mode = 'signin' | 'signup' | 'forgot' | 'reset';

export function AuthPage() {
  const navigate = useNavigate();
  const { data: session, isPending } = authClient.useSession();
  const search = new URLSearchParams(window.location.search);
  const [mode, setMode] = useState<Mode>(search.get('token') ? 'reset' : 'signin');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (session) void navigate({ to: '/projects', search: {} });
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
        await navigate({ to: '/projects', search: {} });
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
    <main className="auth-layout">
      <section className="auth-panel">
        <Logo />
        <div className="auth-card">
          {mode !== 'forgot' && mode !== 'reset' && (
            <div className="auth-tabs" role="tablist">
              <button
                role="tab"
                aria-selected={mode === 'signin'}
                onClick={() => setMode('signin')}
              >
                Sign in
              </button>
              <button
                role="tab"
                aria-selected={mode === 'signup'}
                onClick={() => setMode('signup')}
              >
                Create account
              </button>
            </div>
          )}
          <h1>
            {mode === 'signin'
              ? 'Welcome back.'
              : mode === 'signup'
                ? 'Start writing.'
                : mode === 'forgot'
                  ? 'Reset your password.'
                  : 'Choose a new password.'}
          </h1>
          <p>
            {mode === 'signin'
              ? 'Your projects, compilation history, and PDFs are waiting.'
              : mode === 'signup'
                ? 'Create a private browser workspace for editing and compiling LaTeX.'
                : 'We’ll email a link so you can choose a new password.'}
          </p>
          {message ? (
            <div className="auth-message">
              <MailCheck size={32} aria-hidden="true" />
              <p>{message}</p>
            </div>
          ) : (
            <form className="auth-form" onSubmit={submit}>
              {mode === 'signup' && (
                <label className="field">
                  Name
                  <input
                    className="input"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    required
                    autoComplete="name"
                  />
                </label>
              )}
              {mode !== 'reset' && (
                <label className="field">
                  Email
                  <input
                    className="input"
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    required
                    autoComplete="email"
                  />
                </label>
              )}
              {mode !== 'forgot' && (
                <label className="field">
                  {mode === 'reset' ? 'New password' : 'Password'}
                  <input
                    className="input"
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
                <label className="field">
                  Confirm password
                  <input
                    className="input"
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
              <Button variant="primary" disabled={submitting}>
                {submitting ? (
                  'Please wait…'
                ) : (
                  <>
                    {mode === 'signin'
                      ? 'Sign in'
                      : mode === 'signup'
                        ? 'Create account'
                        : mode === 'forgot'
                          ? 'Send reset link'
                          : 'Change password'}{' '}
                    <ArrowRight size={16} />
                  </>
                )}
              </Button>
            </form>
          )}
          {mode === 'signin' && (
            <button
              className="button button-ghost"
              onClick={() => {
                setMode('forgot');
                setMessage('');
              }}
            >
              Forgot password?
            </button>
          )}
          {(mode === 'forgot' || message) && (
            <button
              className="button button-ghost"
              onClick={() => {
                setMode('signin');
                setMessage('');
              }}
            >
              Back to sign in
            </button>
          )}
        </div>
        <small className="hint">Secure, isolated compilation · No shell escape</small>
      </section>
      <section className="auth-hero" aria-hidden="true">
        <div className="tex-card">
          <span className="kw">\documentclass</span>
          {'{'}
          <span className="str">article</span>
          {'}'}
          <br />
          <span className="kw">\begin</span>
          {'{'}
          <span className="fn">document</span>
          {'}'}
          <br />
          <br />
          Ideas become documents here.
          <br />
          <span className="comment">% Fast feedback. Beautiful output.</span>
          <br />
          <br />
          <span className="kw">\end</span>
          {'{'}
          <span className="fn">document</span>
          {'}'}
        </div>
      </section>
    </main>
  );
}
