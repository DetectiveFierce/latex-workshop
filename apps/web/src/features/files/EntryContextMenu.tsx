import { useRef, type ReactNode } from 'react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { Copy, FilePlus2, FolderInput, FolderPlus, Pencil, Trash2 } from 'lucide-react';
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
}: {
  entry: ProjectEntry;
  children: ReactNode;
  onOpen: () => void;
  onCreate: (kind: 'file' | 'folder') => void;
  onRename: () => void;
  onDuplicate: () => void;
  onMove: () => void;
  onDelete: () => void;
}) {
  const trigger = useRef<HTMLSpanElement>(null);
  const restoreFocus = useRef(false);
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
          className="dropdown file-context-menu"
          aria-label={`Actions for ${entry.name}`}
          collisionPadding={8}
          onEscapeKeyDown={() => {
            restoreFocus.current = true;
          }}
          onCloseAutoFocus={(event) => {
            if (restoreFocus.current) {
              event.preventDefault();
              trigger.current?.focus();
            }
          }}
        >
          {entry.kind === 'folder' && (
            <>
              <ContextMenu.Item className="dropdown-item" onSelect={() => onCreate('file')}>
                <FilePlus2 size={15} /> New file
              </ContextMenu.Item>
              <ContextMenu.Item className="dropdown-item" onSelect={() => onCreate('folder')}>
                <FolderPlus size={15} /> New folder
              </ContextMenu.Item>
              <ContextMenu.Separator className="dropdown-separator" />
            </>
          )}
          <ContextMenu.Item className="dropdown-item" onSelect={onRename}>
            <Pencil size={15} /> Rename
          </ContextMenu.Item>
          <ContextMenu.Item className="dropdown-item" onSelect={onDuplicate}>
            <Copy size={15} /> Duplicate
          </ContextMenu.Item>
          <ContextMenu.Item className="dropdown-item" onSelect={onMove}>
            <FolderInput size={15} /> Move
          </ContextMenu.Item>
          <ContextMenu.Separator className="dropdown-separator" />
          <ContextMenu.Item className="dropdown-item dropdown-danger" onSelect={onDelete}>
            <Trash2 size={15} /> Delete
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
