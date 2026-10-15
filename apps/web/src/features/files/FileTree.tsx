import { useState } from 'react';
import { ChevronDown, ChevronRight, File, FileImage, Folder, FolderOpen } from 'lucide-react';
import type { AgentProposalChange, ProjectEntry } from '@latex-workshop/contracts';
import { classNames } from '../../lib/utils.js';
import { EntryContextMenu } from './EntryContextMenu.js';

export function FileTree({
  entries,
  proposalChanges,
  selectedId,
  onSelect,
  onMove,
  onCreate,
  onRename,
  onDuplicate,
  onDelete,
  onRequestMove,
}: {
  entries: ProjectEntry[];
  proposalChanges: AgentProposalChange[];
  selectedId: string | null;
  onSelect: (entry: ProjectEntry) => void;
  onMove: (id: string, parentId: string | null) => void;
  onCreate: (kind: 'file' | 'folder', entry: ProjectEntry) => void;
  onRename: (entry: ProjectEntry) => void;
  onDuplicate: (entry: ProjectEntry) => void;
  onDelete: (entry: ProjectEntry) => void;
  onRequestMove: (entry: ProjectEntry) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(entries.filter((entry) => entry.kind === 'folder').map((entry) => entry.id)),
  );
  const proposalByEntry = new Map(
    proposalChanges.filter((change) => change.entryId).map((change) => [change.entryId, change]),
  );
  const children = (parentId: string | null) =>
    entries
      .filter((entry) => entry.parentId === parentId)
      .sort((a, b) =>
        a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'folder' ? -1 : 1,
      );
  const render = (parentId: string | null, depth = 0): React.ReactNode =>
    children(parentId).map((entry) => (
      <div key={entry.id}>
        <EntryContextMenu
          entry={entry}
          onOpen={() => onSelect(entry)}
          onCreate={(kind) => {
            setExpanded((old) => new Set(old).add(entry.id));
            onCreate(kind, entry);
          }}
          onRename={() => onRename(entry)}
          onDuplicate={() => onDuplicate(entry)}
          onDelete={() => onDelete(entry)}
          onMove={() => onRequestMove(entry)}
        >
          <button
            type="button"
            role="treeitem"
            data-entry-id={entry.id}
            data-parent-id={entry.parentId ?? undefined}
            aria-level={depth + 1}
            aria-selected={selectedId === entry.id}
            aria-expanded={entry.kind === 'folder' ? expanded.has(entry.id) : undefined}
            tabIndex={
              selectedId === entry.id ||
              (!selectedId && depth === 0 && children(null)[0]?.id === entry.id)
                ? 0
                : -1
            }
            className={classNames(
              'tree-row',
              selectedId === entry.id && 'selected',
              proposalByEntry.get(entry.id)?.operation === 'delete' && 'proposal-deleted',
            )}
            style={{ paddingLeft: 7 + depth * 14 }}
            draggable
            onDragStart={(event) => event.dataTransfer.setData('text/entry-id', entry.id)}
            onDragOver={(event) => {
              if (entry.kind === 'folder') event.preventDefault();
            }}
            onDrop={(event) => {
              event.preventDefault();
              event.stopPropagation();
              const id = event.dataTransfer.getData('text/entry-id');
              if (id && id !== entry.id && entry.kind === 'folder') onMove(id, entry.id);
            }}
            onClick={() => {
              onSelect(entry);
              if (entry.kind === 'folder')
                setExpanded((old) => {
                  const next = new Set(old);
                  if (next.has(entry.id)) next.delete(entry.id);
                  else next.add(entry.id);
                  return next;
                });
            }}
            onKeyDown={(event) => {
              const root = event.currentTarget.closest('[role="tree"]');
              const rows = root
                ? Array.from(root.querySelectorAll<HTMLElement>('[role="treeitem"]'))
                : [];
              const index = rows.indexOf(event.currentTarget);
              const focusAt = (next: number) =>
                rows[Math.max(0, Math.min(rows.length - 1, next))]?.focus();
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                focusAt(index + 1);
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                focusAt(index - 1);
              } else if (event.key === 'Home') {
                event.preventDefault();
                focusAt(0);
              } else if (event.key === 'End') {
                event.preventDefault();
                focusAt(rows.length - 1);
              } else if (event.key === 'ArrowRight' && entry.kind === 'folder') {
                event.preventDefault();
                if (!expanded.has(entry.id)) setExpanded((old) => new Set(old).add(entry.id));
                else
                  window.setTimeout(() =>
                    root?.querySelector<HTMLElement>(`[data-parent-id="${entry.id}"]`)?.focus(),
                  );
              } else if (event.key === 'ArrowLeft') {
                event.preventDefault();
                if (entry.kind === 'folder' && expanded.has(entry.id))
                  setExpanded((old) => {
                    const next = new Set(old);
                    next.delete(entry.id);
                    return next;
                  });
                else if (entry.parentId)
                  root?.querySelector<HTMLElement>(`[data-entry-id="${entry.parentId}"]`)?.focus();
              }
            }}
          >
            {entry.kind === 'folder' ? (
              <>
                {expanded.has(entry.id) ? (
                  <ChevronDown className="chevron" size={13} />
                ) : (
                  <ChevronRight className="chevron" size={13} />
                )}
                {expanded.has(entry.id) ? <FolderOpen size={15} /> : <Folder size={15} />}
              </>
            ) : (
              <>
                <span style={{ width: 13 }} />
                {entry.mimeType?.startsWith('image/') ? (
                  <FileImage size={15} />
                ) : (
                  <File size={15} />
                )}
              </>
            )}
            <span>{entry.name}</span>
            {proposalByEntry.get(entry.id) && (
              <span className="badge proposal-tree-badge">
                {proposalByEntry.get(entry.id)?.operation.replace('_file', '').replace('_', ' ')}
              </span>
            )}
          </button>
        </EntryContextMenu>
        {entry.kind === 'folder' && expanded.has(entry.id) && render(entry.id, depth + 1)}
      </div>
    ));
  return (
    <div
      role="tree"
      aria-label="Project files"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        const id = event.dataTransfer.getData('text/entry-id');
        if (id) onMove(id, null);
      }}
    >
      {render(null)}
    </div>
  );
}
