export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <div className="logo" aria-label="LaTeX Workshop">
      <span className="logo-mark">λ</span>
      {!compact && (
        <span>
          LaTeX <strong>Workshop</strong>
        </span>
      )}
    </div>
  );
}
