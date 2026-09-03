import { useEffect } from 'react';
import { CheckCircle2, CircleAlert, X } from 'lucide-react';

export type ToastState = { id: number; tone: 'success' | 'error'; message: string };

export function Toast({ toast, dismiss }: { toast: ToastState; dismiss: () => void }) {
  useEffect(() => {
    const timer = setTimeout(dismiss, 5_000);
    return () => clearTimeout(timer);
  }, [dismiss]);
  return (
    <div className={`toast toast-${toast.tone}`} role="status">
      {toast.tone === 'success' ? <CheckCircle2 size={18} /> : <CircleAlert size={18} />}
      <span>{toast.message}</span>
      <button onClick={dismiss} aria-label="Dismiss">
        <X size={16} />
      </button>
    </div>
  );
}
