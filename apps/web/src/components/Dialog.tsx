import { useEffect, type ReactNode } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  wide = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    if (open) return;

    // Radix removes its modal pointer lock during the same commit. Restore the
    // document after those cleanups finish in case the dialog remains mounted.
    const timeout = window.setTimeout(restoreDocumentInteraction, 0);
    return () => window.clearTimeout(timeout);
  }, [open]);

  useEffect(
    () => () => {
      // Radix disables outside pointer events while a modal is open. If navigation
      // unmounts the route during a dialog submit, its own teardown can run after
      // this cleanup. Restore interaction once all unmount cleanups have settled.
      window.setTimeout(restoreDocumentInteraction, 0);
    },
    [],
  );
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="dialog-overlay" />
        <DialogPrimitive.Content className={`dialog-content${wide ? ' dialog-wide' : ''}`}>
          <div className="dialog-heading">
            <div>
              <DialogPrimitive.Title className="dialog-title">{title}</DialogPrimitive.Title>
              {description && (
                <DialogPrimitive.Description className="dialog-description">
                  {description}
                </DialogPrimitive.Description>
              )}
            </div>
            <DialogPrimitive.Close className="icon-button" aria-label="Close">
              <X size={18} />
            </DialogPrimitive.Close>
          </div>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function restoreDocumentInteraction() {
  document.documentElement.style.removeProperty('pointer-events');
  document.body.style.removeProperty('pointer-events');
}
