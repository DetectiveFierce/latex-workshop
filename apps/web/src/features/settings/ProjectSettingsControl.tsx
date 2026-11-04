import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  Bot,
  Eye,
  File,
  Keyboard,
  LoaderCircle,
  Minus,
  Pencil,
  Plus,
  SlidersHorizontal,
  UserRound,
  X,
} from 'lucide-react';
import type { Project, ProjectEntry } from '@latex-workshop/contracts';
import { Button, IconButton, Segmented, Switch } from '@latex-workshop/ui';
import { api } from '../../lib/api';
import { useDialogReturnFocus } from '../../lib/dialogReturnFocus';
import { useAppearance } from '../../lib/appearance';
import { AccountSettingsContent } from '../../routes/AccountPage';
import '../../styles/workshop-panels.css';

export type SettingsSection =
  | 'project'
  | 'editor'
  | 'appearance'
  | 'keyboard-shortcuts'
  | 'agent-access'
  | 'account';
export type ProjectSettingsControlHandle = { open: (section?: SettingsSection) => void };
export type ProjectSettingsProps = {
  project: Project;
  entries: ProjectEntry[];
  onSaved: () => void;
  onOpenProfileSettings?: () => void;
  autoCompile?: boolean;
  onAutoCompileChange?: (value: boolean) => void;
};
export const ProjectSettingsControl = forwardRef<
  ProjectSettingsControlHandle,
  ProjectSettingsProps
>(function ProjectSettingsControl(props, ref) {
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<SettingsSection>('project');
  useImperativeHandle(
    ref,
    () => ({
      open: (value = 'project') => {
        setSection(value);
        setOpen(true);
      },
    }),
    [],
  );
  return (
    <>
      <IconButton
        label="Settings"
        onClick={() => {
          setSection('project');
          setOpen(true);
        }}
      >
        <SlidersHorizontal size={16} />
      </IconButton>
      <WorkshopSettingsDialog
        {...props}
        open={open}
        onOpenChange={setOpen}
        initialSection={section}
      />
    </>
  );
});
const sections: { id: SettingsSection; name: string; icon: typeof File }[] = [
  { id: 'project', name: 'Project', icon: File },
  { id: 'editor', name: 'Editor', icon: Pencil },
  { id: 'appearance', name: 'Appearance', icon: Eye },
  { id: 'keyboard-shortcuts', name: 'Keyboard shortcuts', icon: Keyboard },
  { id: 'agent-access', name: 'Agent access', icon: Bot },
  { id: 'account', name: 'Account', icon: UserRound },
];
export function WorkshopSettingsDialog({
  open,
  onOpenChange,
  initialSection = 'project',
  project,
  entries = [],
  onSaved,
  autoCompile,
  onAutoCompileChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialSection?: SettingsSection;
  project?: Project;
  entries?: ProjectEntry[];
  onSaved?: () => void;
  autoCompile?: boolean;
  onAutoCompileChange?: (value: boolean) => void;
}) {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [name, setName] = useState(project?.name ?? '');
  const [compiler, setCompiler] = useState<Project['compiler']>(project?.compiler ?? 'pdflatex');
  const [mainFileId, setMainFileId] = useState(project?.mainFileId ?? '');
  const [isTemplate, setIsTemplate] = useState(project?.isTemplate ?? false);
  const [compile, setCompile] = useState(Boolean(autoCompile));
  const { preferences, update } = useAppearance();
  const [editorSize, setEditorSize] = useState(preferences.editorFontSize);
  const [uiScale, setUiScale] = useState(preferences.uiScale);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const restoreFocus = useDialogReturnFocus(open);
  useEffect(() => {
    if (open) {
      setSection(
        project ? initialSection : initialSection === 'project' ? 'account' : initialSection,
      );
      setName(project?.name ?? '');
      setCompiler(project?.compiler ?? 'pdflatex');
      setMainFileId(project?.mainFileId ?? '');
      setIsTemplate(project?.isTemplate ?? false);
      setCompile(Boolean(autoCompile));
      setEditorSize(preferences.editorFontSize);
      setUiScale(preferences.uiScale);
      setError('');
    }
  }, [open, initialSection, project?.id]);
  async function save() {
    setPending(true);
    setError('');
    try {
      if (project) {
        if (!name.trim()) throw new Error('Name is required.');
        await api(`/api/v1/projects/${project.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ name: name.trim(), compiler, mainFileId, isTemplate }),
        });
        onAutoCompileChange?.(compile);
        onSaved?.();
      }
      update({ editorFontSize: editorSize, uiScale });
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to save settings');
    } finally {
      setPending(false);
    }
  }
  const editorText = (
    <div className="settings-step-row">
      <span>Editor text</span>
      <Stepper
        label="Editor text"
        value={`${editorSize} px`}
        decrease={() => setEditorSize((value) => Math.max(11, value - 1))}
        increase={() => setEditorSize((value) => Math.min(22, value + 1))}
      />
    </div>
  );
  const interfaceText = (
    <div className="settings-step-row">
      <span>Interface text</span>
      <Stepper
        label="Interface text"
        value={`${Math.round(uiScale * 100)}%`}
        decrease={() => setUiScale((value) => Math.max(0.9, value - 0.05))}
        increase={() => setUiScale((value) => Math.min(1.2, value + 0.05))}
      />
    </div>
  );
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim settings-scrim" />
        <Dialog.Content
          className="dialog workshop-settings"
          aria-describedby={undefined}
          onCloseAutoFocus={restoreFocus}
        >
          <aside className="settings-nav">
            <div className="lbl">{project ? 'This project' : 'LaTeX Workshop'}</div>
            {sections
              .filter((item) => project || item.id !== 'project')
              .map((item) => (
                <button
                  className="nv"
                  key={item.id}
                  aria-current={section === item.id ? 'page' : undefined}
                  onClick={() => setSection(item.id)}
                >
                  <item.icon size={15} />
                  {item.name}
                </button>
              ))}
          </aside>
          <div className="settings-main">
            <header className="dialog-head">
              <Dialog.Title className="dialog-title">
                {sections.find((item) => item.id === section)?.name}
              </Dialog.Title>
              <Dialog.Close className="ib" aria-label="Close settings" title="Close settings">
                <X size={16} />
              </Dialog.Close>
            </header>
            <div className="settings-body">
              {section === 'project' && project && (
                <>
                  <label className="settings-row">
                    <span>Name</span>
                    <input
                      className="fld settings-name"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      disabled={pending}
                    />
                  </label>
                  <div className="settings-row">
                    <span>Compiler</span>
                    <Segmented
                      label="Compiler"
                      value={compiler}
                      onChange={setCompiler}
                      options={[
                        { value: 'pdflatex', label: 'pdfLaTeX' },
                        { value: 'xelatex', label: 'XeLaTeX' },
                        { value: 'lualatex', label: 'LuaLaTeX' },
                      ]}
                    />
                  </div>
                  <label className="settings-row">
                    <span>Main document</span>
                    <select
                      className="fld"
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
                  <div className="settings-row">
                    <span>
                      Compile automatically<small>After each save</small>
                    </span>
                    <Switch
                      checked={compile}
                      onCheckedChange={setCompile}
                      label="Compile automatically"
                      disabled={!onAutoCompileChange}
                    />
                  </div>
                  <div className="settings-row">
                    <span>
                      Use as template<small>Show in Templates instead of the library</small>
                    </span>
                    <Switch
                      checked={isTemplate}
                      onCheckedChange={setIsTemplate}
                      label="Use as template"
                    />
                  </div>
                  <div className="settings-quick">
                    <h3 className="lbl">Appearance · quick</h3>
                    {editorText}
                    {interfaceText}
                  </div>
                </>
              )}
              {section === 'editor' && editorText}
              {section === 'appearance' && interfaceText}
              {(section === 'keyboard-shortcuts' ||
                section === 'agent-access' ||
                section === 'account') && (
                <AccountSettingsContent
                  section={section}
                  focusKeyboard={section === 'keyboard-shortcuts'}
                  onClose={() => onOpenChange(false)}
                />
              )}
              {error && (
                <p className="form-error" role="alert">
                  {error}
                </p>
              )}
            </div>
            <footer className="dialog-foot">
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button variant="primary" disabled={pending} onClick={() => void save()}>
                {pending && <LoaderCircle size={14} className="spin" />}Save
              </Button>
            </footer>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
function Stepper({
  label,
  value,
  decrease,
  increase,
}: {
  label: string;
  value: string;
  decrease: () => void;
  increase: () => void;
}) {
  return (
    <div className="seg seg-stepper settings-stepper">
      <IconButton label={`Decrease ${label.toLowerCase()}`} compact onClick={decrease}>
        <Minus size={13} />
      </IconButton>
      <output className="tnum">{value}</output>
      <IconButton label={`Increase ${label.toLowerCase()}`} compact onClick={increase}>
        <Plus size={13} />
      </IconButton>
    </div>
  );
}
