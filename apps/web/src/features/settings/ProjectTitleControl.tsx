import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';

export function ProjectTitleControl({
  projectId,
  name,
  onRenamed,
  onError,
}: {
  projectId: string;
  name: string;
  onRenamed: (name: string) => void;
  onError: (message: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const editing = draft !== null;

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
    const cancelOutside = (event: PointerEvent) => {
      if (event.target !== inputRef.current) setDraft(null);
    };
    document.addEventListener('pointerdown', cancelOutside, true);
    return () => document.removeEventListener('pointerdown', cancelOutside, true);
  }, [editing]);

  async function save() {
    if (draft === null || pending) return;
    const nextName = draft.trim();
    if (!nextName) {
      onError('Project name is required.');
      return;
    }
    setDraft(null);
    if (nextName === name) return;
    setPending(true);
    try {
      await api<unknown>(`/api/v1/projects/${projectId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: nextName }),
      });
      onRenamed(nextName);
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Unable to rename project');
    } finally {
      setPending(false);
    }
  }

  if (draft !== null)
    return (
      <input
        ref={inputRef}
        className="input project-title-input"
        aria-label="Project title"
        maxLength={120}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => setDraft(null)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' || event.key === 'Enter') {
            event.preventDefault();
            event.stopPropagation();
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'Escape') setDraft(null);
            else void save();
          }
        }}
      />
    );

  return (
    <button
      type="button"
      className="project-title-name"
      title="Double-click to rename project"
      aria-label={`Rename project ${name}`}
      disabled={pending}
      aria-busy={pending}
      onDoubleClick={() => setDraft(name)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          setDraft(name);
        }
      }}
    >
      {name}
    </button>
  );
}
