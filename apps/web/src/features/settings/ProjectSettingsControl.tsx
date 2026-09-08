import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { LoaderCircle, Settings, UserRound } from 'lucide-react';
import type { Project, ProjectEntry } from '@latex-workshop/contracts';
import { Button, IconButton } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { api } from '../../lib/api';

export type ProjectSettingsControlHandle = {
  open: () => void;
};

export const ProjectSettingsControl = forwardRef<
  ProjectSettingsControlHandle,
  {
    project: Project;
    entries: ProjectEntry[];
    onSaved: () => void;
    onOpenProfileSettings: () => void;
  }
>(function ProjectSettingsControl({ project, entries, onSaved, onOpenProfileSettings }, ref) {
  const [open, setOpen] = useState(false);
  useImperativeHandle(ref, () => ({ open: () => setOpen(true) }), []);

  return (
    <>
      <IconButton label="Project settings" onClick={() => setOpen(true)}>
        <Settings size={17} />
      </IconButton>
      <ProjectSettingsDialog
        open={open}
        onOpenChange={setOpen}
        project={project}
        entries={entries}
        onSaved={onSaved}
        onOpenProfileSettings={onOpenProfileSettings}
      />
    </>
  );
});

function ProjectSettingsDialog({
  open,
  onOpenChange,
  project,
  entries,
  onSaved,
  onOpenProfileSettings,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project;
  entries: ProjectEntry[];
  onSaved: () => void;
  onOpenProfileSettings: () => void;
}) {
  const [name, setName] = useState(project.name);
  const [compiler, setCompiler] = useState(project.compiler);
  const [mainFileId, setMainFileId] = useState(project.mainFileId ?? '');
  const [isTemplate, setIsTemplate] = useState(project.isTemplate);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(project.name);
    setCompiler(project.compiler);
    setMainFileId(project.mainFileId ?? '');
    setIsTemplate(project.isTemplate);
    setError(null);
  }, [open, project.compiler, project.isTemplate, project.mainFileId, project.name]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Project settings">
      <form
        className="auth-form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!name.trim()) {
            setError('Project name is required.');
            return;
          }
          setPending(true);
          setError(null);
          try {
            await api(`/api/v1/projects/${project.id}`, {
              method: 'PATCH',
              body: JSON.stringify({ name: name.trim(), compiler, mainFileId, isTemplate }),
            });
            onSaved();
            onOpenChange(false);
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Unable to save settings');
          } finally {
            setPending(false);
          }
        }}
      >
        <label className="field">
          Name
          <input
            className="input"
            disabled={pending}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="settings-checkbox">
          <input
            type="checkbox"
            disabled={pending}
            checked={isTemplate}
            onChange={(event) => setIsTemplate(event.target.checked)}
          />
          <span>
            <strong>Use as template</strong>
            <small>Show this project in Templates instead of the normal library.</small>
          </span>
        </label>
        <label className="field">
          Compiler
          <select
            className="select"
            disabled={pending}
            value={compiler}
            onChange={(event) => setCompiler(event.target.value as Project['compiler'])}
          >
            <option value="pdflatex">pdfLaTeX</option>
            <option value="xelatex">XeLaTeX</option>
            <option value="lualatex">LuaLaTeX</option>
          </select>
        </label>
        <label className="field">
          Main document
          <select
            className="select"
            disabled={pending}
            value={mainFileId}
            onChange={(event) => setMainFileId(event.target.value)}
          >
            {entries
              .filter((entry) => entry.kind === 'file' && entry.name.endsWith('.tex'))
              .map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
          </select>
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <Button variant="primary" disabled={pending}>
          {pending && <LoaderCircle className="spin" size={15} />} Save settings
        </Button>
      </form>
      <div className="settings-shortcuts">
        <div>
          <strong>Profile settings</strong>
          <p className="hint">Manage your account, agent access, security, and shortcuts.</p>
        </div>
        <Button
          type="button"
          onClick={() => {
            onOpenChange(false);
            onOpenProfileSettings();
          }}
        >
          <UserRound size={16} aria-hidden="true" /> Open profile
        </Button>
      </div>
    </Dialog>
  );
}
