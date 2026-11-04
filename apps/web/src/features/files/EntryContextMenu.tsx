import { useRef, type ReactNode } from 'react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { Copy, FilePlus2, FolderInput, FolderPlus, FileCheck, Pencil, Trash2 } from 'lucide-react';
import type { ProjectEntry } from '@latex-workshop/contracts';

export function EntryContextMenu({
  entry,
  children,
  onOpen,
  onCreate,
  onRename,
  onDuplicate,
  onMove,
  onDelete,
  onSetMain,
}: {
  entry: ProjectEntry;
  children: ReactNode;
  onOpen: () => void;
  onCreate: (kind: 'file' | 'folder') => void;
  onRename: () => void;
  onDuplicate: () => void;
  onMove: () => void;
  onDelete: () => void;
  onSetMain?: (() => void) | undefined;
}) {
  const trigger = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef(false);
  const focusTarget = useRef<HTMLElement | null>(null);
  return (
    <ContextMenu.Root
      modal={false}
      onOpenChange={(open) => {
        if (open) {
          restoreFocus.current = false;
          onOpen();
        }
      }}
    >
      <ContextMenu.Trigger
        asChild
        ref={trigger}
        onContextMenuCapture={(event) => {
          const active = document.activeElement;
          focusTarget.current =
            event.target instanceof Element ? event.target.closest('button') : null;
          if (
            !focusTarget.current &&
            active instanceof HTMLElement &&
            trigger.current?.contains(active)
          )
            focusTarget.current = active;
          focusTarget.current ??=
            trigger.current?.querySelector<HTMLElement>('[role="treeitem"]') ?? null;
        }}
        onKeyDown={(event) => {
          if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
          event.preventDefault();
          event.stopPropagation();
          const bounds = event.currentTarget.getBoundingClientRect();
          event.currentTarget.dispatchEvent(
            new MouseEvent('contextmenu', {
              bubbles: true,
              cancelable: true,
              clientX: bounds.left + 16,
              clientY: bounds.bottom,
            }),
          );
        }}
      >
        {children}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          className="menu file-context-menu"
          aria-label={`Actions for ${entry.name}`}
          collisionPadding={8}
          onEscapeKeyDown={() => {
            restoreFocus.current = true;
          }}
          onCloseAutoFocus={(event) => {
            if (restoreFocus.current) {
              event.preventDefault();
              focusTarget.current?.focus();
            }
          }}
        >
          {entry.kind === 'folder' && (
            <>
              <ContextMenu.Item className="mi" onSelect={() => onCreate('file')}>
                <FilePlus2 size={15} /> New file
              </ContextMenu.Item>
              <ContextMenu.Item className="mi" onSelect={() => onCreate('folder')}>
                <FolderPlus size={15} /> New folder
              </ContextMenu.Item>
              <ContextMenu.Separator className="msep" />
            </>
          )}
          <ContextMenu.Item className="mi" onSelect={onRename}>
            <Pencil size={15} /> Rename
          </ContextMenu.Item>
          <ContextMenu.Item className="mi" onSelect={onDuplicate}>
            <Copy size={15} /> Duplicate
          </ContextMenu.Item>
          <ContextMenu.Item className="mi" onSelect={onMove}>
            <FolderInput size={15} /> Move to…
          </ContextMenu.Item>
          {entry.kind === 'file' && entry.name.endsWith('.tex') && onSetMain && (
            <ContextMenu.Item className="mi" onSelect={onSetMain}>
              <FileCheck size={15} />
              Set as main document
            </ContextMenu.Item>
          )}
          <ContextMenu.Separator className="msep" />
          <ContextMenu.Item className="mi mi-danger" onSelect={onDelete}>
            <Trash2 size={15} /> Delete
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
