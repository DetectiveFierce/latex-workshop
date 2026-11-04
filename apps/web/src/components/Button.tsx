import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { classNames } from '../lib/utils';

export function Button({
  children,
  variant = 'default',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
}) {
  return (
    <button
      className={classNames(
        'btn',
        variant === 'primary'
          ? 'btn-p'
          : variant === 'ghost'
            ? 'btn-g'
            : variant === 'danger'
              ? 'btn-s btn-danger'
              : 'btn-s',
        'button',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export function IconButton({
  label,
  children,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return (
    <button
      className={classNames('ib', 'icon-button', className)}
      aria-label={label}
      title={label}
      {...props}
    >
      {children}
    </button>
  );
}
