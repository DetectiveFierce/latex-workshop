import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronDown, FileText, LoaderCircle, Play, Terminal, Trash2 } from 'lucide-react';
import { Button, Switch } from '@latex-workshop/ui';
import type { Project, ProjectEntry } from '@latex-workshop/contracts';

export function CompileControl({
  project,
  entries,
  autoCompile,
  running,
  stale,
  errors,
  shortcut,
  onCompile,
  onStop,
  onAutoCompile,
  onProjectChange,
  onProblems,
  onLogs,
  onClearCache,
}: {
  project: Project;
  entries: ProjectEntry[];
  autoCompile: boolean;
  running: boolean;
  stale: boolean;
  errors: number;
  shortcut?: string | undefined;
  onCompile: () => void;
  onStop: () => void;
  onAutoCompile: (on: boolean) => void;
  onProjectChange: (update: { compiler?: Project['compiler']; mainFileId?: string }) => void;
  onProblems: () => void;
  onLogs: () => void;
  onClearCache: () => void;
}) {
  return (
    <div className="split compile-control" role="group" aria-label="Compile project">
      <Button variant="primary" className="compile-main" onClick={running ? onStop : onCompile}>
        {running ? <LoaderCircle size={15} className="spin" /> : <Play size={15} />}
        {running ? 'Compiling · Stop' : 'Compile'}
        {!running && stale && !errors && (
          <span className="dot" data-tone="warn" title="Source changed since last build" />
        )}
        {!running && autoCompile && !errors && <small>Auto</small>}
      </Button>
      {!running && errors > 0 && (
        <button
          className="compile-errors"
          onClick={onProblems}
          title="Open Problems"
          aria-label={`Open ${errors} compile errors`}
        >
          {errors} {errors === 1 ? 'error' : 'errors'}
        </button>
      )}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <Button
            variant="primary"
            className="compile-caret"
            aria-label="Compile options"
            title="Compile options"
          >
            <ChevronDown size={14} />
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="menu" align="end" sideOffset={6}>
            <DropdownMenu.Item className="mi" onSelect={onCompile}>
              <Play size={15} />
              Compile now{shortcut && <kbd className="end kbd">{shortcut}</kbd>}
            </DropdownMenu.Item>
            <DropdownMenu.Item
              className="mi"
              onSelect={(event) => {
                event.preventDefault();
                onAutoCompile(!autoCompile);
              }}
            >
              <span>Compile on save</span>
              <span className="end">
                <Switch
                  checked={autoCompile}
                  label="Compile on save"
                  onCheckedChange={onAutoCompile}
                />
              </span>
            </DropdownMenu.Item>
            <DropdownMenu.Separator className="msep" />
            <DropdownMenu.Label className="mhead">Engine</DropdownMenu.Label>
            {(['pdflatex', 'xelatex', 'lualatex'] as const).map((compiler) => (
              <DropdownMenu.Item
                className="mi"
                key={compiler}
                onSelect={() => onProjectChange({ compiler })}
              >
                <span className="menu-icon-slot">
                  {project.compiler === compiler && <Check size={15} />}
                </span>
                {compiler === 'pdflatex'
                  ? 'pdfLaTeX'
                  : compiler === 'xelatex'
                    ? 'XeLaTeX'
                    : 'LuaLaTeX'}
              </DropdownMenu.Item>
            ))}
            <DropdownMenu.Sub>
              <DropdownMenu.SubTrigger className="mi">
                <FileText size={15} />
                Main document<span className="end">›</span>
              </DropdownMenu.SubTrigger>
              <DropdownMenu.Portal>
                <DropdownMenu.SubContent className="menu" sideOffset={6}>
                  {entries
                    .filter((entry) => entry.kind === 'file' && entry.name.endsWith('.tex'))
                    .map((entry) => (
                      <DropdownMenu.Item
                        className="mi"
                        key={entry.id}
                        onSelect={() => onProjectChange({ mainFileId: entry.id })}
                      >
                        <span className="menu-icon-slot">
                          {project.mainFileId === entry.id && <Check size={15} />}
                        </span>
                        {entry.name}
                      </DropdownMenu.Item>
                    ))}
                </DropdownMenu.SubContent>
              </DropdownMenu.Portal>
            </DropdownMenu.Sub>
            <DropdownMenu.Separator className="msep" />
            <DropdownMenu.Item className="mi" onSelect={onLogs}>
              <Terminal size={15} />
              Compiler log
            </DropdownMenu.Item>
            <DropdownMenu.Item className="mi" onSelect={onClearCache}>
              <Trash2 size={15} />
              Clear build cache
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}
