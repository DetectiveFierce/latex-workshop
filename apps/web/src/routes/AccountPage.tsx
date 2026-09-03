import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, Keyboard, LogOut, RotateCcw, ShieldCheck, Trash2 } from 'lucide-react';
import {
  shortcutCategories,
  shortcutRegistry,
  shortcutsConflict,
  type KeyboardKeymap,
  type KeyboardShortcutProfiles,
  type KeyboardShortcutOverrides,
  type ShortcutActionId,
} from '@latex-workshop/contracts';
import { Button } from '../components/Button';
import { Dialog } from '../components/Dialog';
import { Logo } from '../components/Logo';
import { authClient } from '../lib/auth';
import { api, appPath, queryKeys } from '../lib/api';
import {
  cacheShortcuts,
  displayShortcut,
  resolvedShortcuts,
  shortcutStrokeFromEvent,
  useKeyboardShortcuts,
  type KeyboardShortcutsResponse,
} from '../lib/keyboardShortcuts';

export function AccountPage() {
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
        <AccountSettingsContent />
      </main>
    </div>
  );
}

export function AccountSettingsDialog({
  open,
  onOpenChange,
  initialSection = 'account',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialSection?: 'account' | 'keyboard-shortcuts';
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Account settings"
      description="Manage security, shortcuts, sessions, and account access."
      wide
    >
      <div className="account-dialog-body">
        <AccountSettingsContent
          focusKeyboard={open && initialSection === 'keyboard-shortcuts'}
          onClose={() => onOpenChange(false)}
        />
      </div>
    </Dialog>
  );
}

function AccountSettingsContent({
  focusKeyboard = false,
  onClose,
}: {
  focusKeyboard?: boolean;
  onClose?: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: session, isPending } = authClient.useSession();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (!isPending && !session?.user) void navigate({ to: '/auth' });
  }, [session, isPending, navigate]);
  if (!session?.user)
    return (
      <main className="screen-center">
        <span className="spinner" />
      </main>
    );
  async function changePassword(event: FormEvent) {
    event.preventDefault();
    setError('');
    setMessage('');
    const result = await authClient.changePassword({
      currentPassword,
      newPassword,
      revokeOtherSessions: true,
    });
    if (result.error) setError(result.error.message ?? 'Unable to change password');
    else {
      setMessage('Password changed and other sessions revoked.');
      setCurrentPassword('');
      setNewPassword('');
    }
  }
  return (
    <>
      <p className="hint account-identity">Signed in as {session.user.email}</p>
      <section className="account-section">
        <h2>
          <ShieldCheck size={18} aria-hidden="true" /> Security
        </h2>
        <form onSubmit={changePassword}>
          <label className="field">
            Current password
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              required
            />
          </label>
          <label className="field">
            New password
            <input
              className="input"
              type="password"
              minLength={8}
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              required
            />
          </label>
          <Button type="submit">Change password</Button>
        </form>
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        {message && (
          <p className="status-ok" role="status">
            {message}
          </p>
        )}
        <Button
          onClick={async () => {
            await authClient.revokeOtherSessions();
            setMessage('Other sessions revoked.');
          }}
        >
          Revoke other sessions
        </Button>
      </section>
      <KeyboardShortcutSettings
        userId={session.user.id}
        queryClient={queryClient}
        focusOnOpen={focusKeyboard}
      />
      <section className="account-section">
        <h2>Session</h2>
        <Button
          onClick={async () => {
            await authClient.signOut();
            onClose?.();
            await navigate({ to: '/auth' });
          }}
        >
          <LogOut size={16} aria-hidden="true" /> Sign out
        </Button>
      </section>
      <section className="account-section">
        <h2 style={{ color: 'var(--hon-red)' }}>Delete account</h2>
        <p className="hint">
          This permanently removes your projects, history, and compiled documents.
        </p>
        <div>
          <Button
            variant="danger"
            onClick={async () => {
              if (!window.confirm('Permanently delete your account and all projects?')) return;
              const result = await authClient.deleteUser({
                callbackURL: `${window.location.origin}${appPath('/auth')}`,
              });
              if (result.error) setError(result.error.message ?? 'Unable to delete account');
            }}
          >
            <Trash2 size={16} aria-hidden="true" /> Delete account
          </Button>
        </div>
      </section>
    </>
  );
}

function KeyboardShortcutSettings({
  userId,
  queryClient,
  focusOnOpen = false,
}: {
  userId: string;
  queryClient: ReturnType<typeof useQueryClient>;
  focusOnOpen?: boolean;
}) {
  const query = useKeyboardShortcuts(userId);
  const sectionRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [keymap, setKeymap] = useState<KeyboardKeymap>('linux');
  const [profiles, setProfiles] = useState<KeyboardShortcutProfiles>({ linux: {}, macos: {} });
  const [draft, setDraft] = useState<KeyboardShortcutOverrides>({});
  const [saved, setSaved] = useState<KeyboardShortcutOverrides>({});
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('All');
  const [recording, setRecording] = useState<ShortcutActionId | null>(null);
  const [strokes, setStrokes] = useState<string[]>([]);
  const [conflict, setConflict] = useState<{
    action: ShortcutActionId;
    other: ShortcutActionId;
    binding: string;
  } | null>(null);
  const [status, setStatus] = useState('');
  useEffect(() => {
    if (!query.data) return;
    setKeymap(query.data.keymap);
    setProfiles(query.data.overrides);
    setDraft(query.data.overrides[query.data.keymap]);
    setSaved(query.data.overrides[query.data.keymap]);
  }, [query.data?.updatedAt]);
  useEffect(() => {
    if (!focusOnOpen && window.location.hash !== '#keyboard-shortcuts') return;
    sectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    window.setTimeout(() => searchRef.current?.focus(), 250);
  }, [focusOnOpen]);
  const resolved = useMemo(() => resolvedShortcuts(draft, keymap), [draft, keymap]);
  const filtered = shortcutRegistry.filter(
    (item) =>
      (category === 'All' || item.category === category) &&
      `${item.label} ${item.id}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved) || keymap !== query.data?.keymap;

  function stopRecording() {
    setRecording(null);
    setStrokes([]);
    setConflict(null);
  }
  function assign(action: ShortcutActionId, binding = strokes.join(' ')) {
    if (!binding) return;
    const other = shortcutRegistry.find(
      (item) =>
        item.id !== action && resolved[item.id] && shortcutsConflict(resolved[item.id]!, binding),
    );
    if (other) {
      setConflict({ action, other: other.id, binding });
      return;
    }
    setDraft((value) => ({ ...value, [action]: binding }));
    stopRecording();
  }
  async function save() {
    setStatus('Saving…');
    try {
      const nextProfiles = { ...profiles, [keymap]: draft };
      const value = await api<KeyboardShortcutsResponse>('/api/v1/preferences/keyboard-shortcuts', {
        method: 'PUT',
        body: JSON.stringify({ keymap, overrides: nextProfiles }),
      });
      cacheShortcuts(userId, value);
      queryClient.setQueryData(queryKeys.keyboardShortcuts(userId), value);
      setProfiles(value.overrides);
      setSaved(value.overrides[value.keymap]);
      setDraft(value.overrides[value.keymap]);
      setStatus('Keyboard shortcuts saved.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Unable to save shortcuts');
    }
  }
  return (
    <section className="account-section shortcut-settings" id="keyboard-shortcuts" ref={sectionRef}>
      <h2>
        <Keyboard size={18} aria-hidden="true" /> Keyboard shortcuts
      </h2>
      <p className="hint">
        Shortcuts sync with your account. Bindings use literal Ctrl, Alt, Shift, and Meta keys.
      </p>
      <div className="shortcut-tools">
        <select
          className="input"
          aria-label="Keyboard profile"
          value={keymap}
          onChange={(event) => {
            const next = event.target.value as KeyboardKeymap;
            setProfiles((value) => ({ ...value, [keymap]: draft }));
            setKeymap(next);
            setDraft(profiles[next]);
            setSaved(query.data?.overrides[next] ?? {});
          }}
        >
          <option value="linux">Linux / Ctrl</option>
          <option value="macos">macOS / Command</option>
        </select>
        <input
          ref={searchRef}
          className="input"
          type="search"
          placeholder="Search shortcuts…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <select
          className="input"
          aria-label="Shortcut category"
          value={category}
          onChange={(event) => setCategory(event.target.value)}
        >
          <option>All</option>
          {shortcutCategories.map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
      </div>
      <div className="shortcut-list">
        {filtered.map((item) => {
          const active = recording === item.id;
          return (
            <div className="shortcut-row" key={item.id}>
              <div>
                <strong>{item.label}</strong>
                <small>{item.category}</small>
              </div>
              {active ? (
                <div
                  className="shortcut-recorder"
                  onKeyDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (event.key === 'Escape') return stopRecording();
                    if (event.key === 'Backspace') return setStrokes((value) => value.slice(0, -1));
                    const stroke = shortcutStrokeFromEvent(event, keymap === 'macos');
                    if (stroke && strokes.length < 2) setStrokes((value) => [...value, stroke]);
                  }}
                  tabIndex={0}
                  autoFocus
                >
                  <kbd>
                    {strokes.length
                      ? displayShortcut(strokes.join(' '), keymap === 'macos')
                      : 'Press keys…'}
                  </kbd>
                  {isLikelyReservedShortcut(strokes.join(' ')) && (
                    <small className="shortcut-warning">Browser/OS reserved</small>
                  )}
                  <Button onClick={() => assign(item.id)} disabled={!strokes.length}>
                    Assign
                  </Button>
                  <Button variant="ghost" onClick={stopRecording}>
                    Cancel
                  </Button>
                </div>
              ) : (
                <button
                  className="shortcut-binding"
                  onClick={() => {
                    setRecording(item.id);
                    setStrokes([]);
                    setConflict(null);
                  }}
                >
                  <kbd>{displayShortcut(resolved[item.id], keymap === 'macos')}</kbd>
                </button>
              )}
              <div className="shortcut-row-actions">
                <button
                  title="Clear shortcut"
                  onClick={() => setDraft((value) => ({ ...value, [item.id]: null }))}
                >
                  Clear
                </button>
                <button
                  title="Reset shortcut"
                  onClick={() =>
                    setDraft((value) => {
                      const next = { ...value };
                      delete next[item.id];
                      return next;
                    })
                  }
                >
                  <RotateCcw size={13} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {conflict && (
        <div className="shortcut-conflict" role="alert">
          <span>
            Conflicts with {shortcutRegistry.find((item) => item.id === conflict.other)?.label}.
          </span>
          <Button
            onClick={() => {
              setDraft((value) => ({
                ...value,
                [conflict.other]: null,
                [conflict.action]: conflict.binding,
              }));
              stopRecording();
            }}
          >
            Replace
          </Button>
          <Button variant="ghost" onClick={() => setConflict(null)}>
            Cancel
          </Button>
        </div>
      )}
      <div className="shortcut-footer">
        <Button variant="ghost" onClick={() => setDraft({})}>
          Reset all
        </Button>
        <span className="hint" role="status">
          {status}
        </span>
        <Button variant="ghost" disabled={!dirty} onClick={() => setDraft(saved)}>
          Cancel
        </Button>
        <Button disabled={!dirty} onClick={() => void save()}>
          Save
        </Button>
      </div>
    </section>
  );
}

function isLikelyReservedShortcut(binding: string) {
  return /^(?:Ctrl|Meta)\+(?:Key[QRTW]|KeyL|KeyN|Shift\+KeyT)$/.test(binding);
}
