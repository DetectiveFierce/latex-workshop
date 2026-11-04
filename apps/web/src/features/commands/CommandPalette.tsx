import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ChevronRight, Command, File, Search } from 'lucide-react';
import { Switch } from '@latex-workshop/ui';
import type { ProjectSearchResult } from '../search/projectSearch';
import { useDialogReturnFocus } from '../../lib/dialogReturnFocus';
import '../../styles/workshop-panels.css';

export type PaletteCommand = {
  label: string;
  shortcut?: string | undefined;
  run: () => void;
  kind?: 'command' | 'file';
  path?: string;
  control?: ReactNode;
};
type Scope = 'all' | 'commands' | 'files' | 'text';
const scopes: { value: Scope; label: string; prefix: string }[] = [
  { value: 'all', label: 'All', prefix: '' },
  { value: 'commands', label: 'Commands', prefix: '>' },
  { value: 'files', label: 'Files', prefix: '/' },
  { value: 'text', label: 'Text in project', prefix: '#' },
];

export function CommandPalette({
  open,
  onOpenChange,
  query,
  onQuery,
  commands,
  textResults = [],
  onTextQuery,
  onOpenText,
  autoCompile,
  onAutoCompileChange,
  compiler,
  onCompiler,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  query: string;
  onQuery: (value: string) => void;
  commands: PaletteCommand[];
  textResults?: ProjectSearchResult[];
  onTextQuery?: (query: string) => void;
  onOpenText?: (result: ProjectSearchResult) => void;
  autoCompile?: boolean;
  onAutoCompileChange?: (value: boolean) => void;
  compiler?: string;
  onCompiler?: () => void;
}) {
  const restoreFocus = useDialogReturnFocus(open);
  const listboxId = useId();
  const [scope, setScope] = useState<Scope>('all');
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState<string[]>([]);
  const textQueryRef = useRef(onTextQuery);
  textQueryRef.current = onTextQuery;
  const prefix = /^[>/#]/.test(query) ? query[0] : '';
  const term = (prefix ? query.slice(1) : query).trim();
  const actualScope =
    scopes.find((value) => value.prefix && value.prefix === prefix)?.value ?? scope;
  useEffect(() => {
    if (!open) return;
    setActive(0);
    if (actualScope === 'all' || actualScope === 'text') textQueryRef.current?.(term);
  }, [term, actualScope, open]);
  const results = useMemo<{ group: string; command: PaletteCommand }[]>(() => {
    const settings: PaletteCommand[] = [];
    if (onAutoCompileChange)
      settings.push({
        label: 'Auto-compile on save',
        run: () => onAutoCompileChange(!autoCompile),
        control: (
          <Switch
            label="Auto-compile on save"
            checked={Boolean(autoCompile)}
            onCheckedChange={onAutoCompileChange}
          />
        ),
      });
    if (onCompiler)
      settings.push({
        label: 'Compiler',
        run: onCompiler,
        control: (
          <span className="end">
            {compiler}
            <ChevronRight size={14} />
          </span>
        ),
      });
    const ordered = [...commands, ...settings]
      .filter((command) =>
        `${command.label} ${command.path ?? ''}`
          .toLocaleLowerCase()
          .includes(term.toLocaleLowerCase()),
      )
      .sort((a, b) => {
        const aIndex = recent.indexOf(a.label),
          bIndex = recent.indexOf(b.label);
        return (aIndex < 0 ? 100 : aIndex) - (bIndex < 0 ? 100 : bIndex);
      });
    const commandItems = ordered.filter((command) => command.kind !== 'file');
    const fileItems = ordered.filter((command) => command.kind === 'file');
    return [
      ...(actualScope === 'all' || actualScope === 'commands'
        ? commandItems.map((command) => ({ group: 'Commands', command }))
        : []),
      ...(actualScope === 'all' || actualScope === 'files'
        ? fileItems.map((command) => ({ group: 'Files', command }))
        : []),
      ...(actualScope === 'all' || actualScope === 'text'
        ? textResults.slice(0, 12).map((result) => ({
            group: 'Text in project',
            command: {
              label: result.preview,
              run: () => onOpenText?.(result),
              path: `${result.path} : ${result.line}`,
            },
          }))
        : []),
    ].slice(0, 40);
  }, [
    commands,
    autoCompile,
    onAutoCompileChange,
    compiler,
    onCompiler,
    term,
    actualScope,
    recent,
    textResults,
    onOpenText,
  ]);
  function run(index: number) {
    const item = results[index];
    if (!item) return;
    setRecent((values) =>
      [item.command.label, ...values.filter((value) => value !== item.command.label)].slice(0, 12),
    );
    if (item.command.control && item.command.label === 'Auto-compile on save') {
      item.command.run();
      return;
    }
    onOpenChange(false);
    item.command.run();
  }
  function changeScope(value: Scope) {
    setScope(value);
    onQuery(term);
    setActive(0);
  }
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim palette-scrim" />
        <Dialog.Content
          className="dialog workshop-palette"
          aria-describedby={undefined}
          onCloseAutoFocus={restoreFocus}
        >
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <div className="palette-input-row">
            <Search size={16} />
            <input
              autoFocus
              role="combobox"
              aria-expanded="true"
              aria-autocomplete="list"
              aria-controls={listboxId}
              aria-activedescendant={results[active] ? `${listboxId}-option-${active}` : undefined}
              value={query}
              aria-label="Search commands, files and project text"
              placeholder="Search or run a command"
              onChange={(event) => onQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  setActive((value) =>
                    Math.max(
                      0,
                      Math.min(results.length - 1, value + (event.key === 'ArrowDown' ? 1 : -1)),
                    ),
                  );
                }
                if (event.key === 'Enter') {
                  event.preventDefault();
                  run(active);
                }
                if (event.key === 'Tab' && !event.shiftKey) {
                  event.preventDefault();
                  changeScope(
                    scopes[
                      (scopes.findIndex((item) => item.value === actualScope) + 1) % scopes.length
                    ]?.value ?? 'all',
                  );
                }
              }}
            />
            <Dialog.Close className="kbd" aria-label="Close command palette">
              Esc
            </Dialog.Close>
          </div>
          <div className="palette-scopes" role="tablist" aria-label="Command scope">
            {scopes.map((item) => (
              <button
                key={item.value}
                className="tab"
                role="tab"
                aria-selected={actualScope === item.value}
                onClick={() => changeScope(item.value)}
              >
                {item.label} {item.prefix}
              </button>
            ))}
          </div>
          <div id={listboxId} className="palette-results" role="listbox" aria-label="Results">
            {results.map((item, index) => (
              <div key={`${item.group}:${item.command.label}:${index}`}>
                {results[index - 1]?.group !== item.group && (
                  <h3 className="mhead">{item.group}</h3>
                )}
                <div
                  className="palette-result mi"
                  id={`${listboxId}-option-${index}`}
                  role="option"
                  tabIndex={-1}
                  aria-selected={index === active}
                  data-active={index === active ? '' : undefined}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => run(index)}
                >
                  {item.group === 'Files' ? (
                    <File size={15} />
                  ) : item.group === 'Text in project' ? (
                    <Search size={15} />
                  ) : (
                    <Command size={15} />
                  )}
                  <span className="palette-result-label">
                    {highlight(
                      item.group === 'Files'
                        ? item.command.label.replace(/^Open /, '')
                        : item.command.label,
                      term,
                    )}
                  </span>
                  {item.command.path && <code className="palette-path">{item.command.path}</code>}
                  {item.command.control ? (
                    <span className="palette-control" onClick={(event) => event.stopPropagation()}>
                      {item.command.control}
                    </span>
                  ) : item.command.shortcut ? (
                    <kbd className="kbd">{item.command.shortcut}</kbd>
                  ) : null}
                </div>
              </div>
            ))}
            {!results.length && <p className="hint">No results</p>}
          </div>
          <footer className="palette-footer">
            <span>
              <kbd className="kbd">↑</kbd> <kbd className="kbd">↓</kbd> Move
            </span>
            <span>
              <kbd className="kbd">↵</kbd> Run
            </span>
            <span>
              <kbd className="kbd">Tab</kbd> Scope
            </span>
            <span>Recent commands appear first</span>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
function highlight(value: string, term: string) {
  if (!term) return value;
  const index = value.toLocaleLowerCase().indexOf(term.toLocaleLowerCase());
  return index < 0 ? (
    value
  ) : (
    <>
      {value.slice(0, index)}
      <strong>{value.slice(index, index + term.length)}</strong>
      {value.slice(index + term.length)}
    </>
  );
}
