import { useRef } from 'react';

// Radix restores focus only to Dialog.Trigger. These dialogs are controlled, so
// the close handler has to return focus itself. Capture the opener during
// render, before the dialog's own focus effect runs.
export function useDialogReturnFocus(open: boolean) {
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current && typeof document !== 'undefined') {
    const active = document.activeElement;
    if (active instanceof HTMLElement) returnFocusRef.current = active;
  }
  wasOpen.current = open;
  return (event: Event) => {
    event.preventDefault();
    const target = returnFocusRef.current;
    if (target?.isConnected) target.focus();
  };
}
