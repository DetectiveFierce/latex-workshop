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
    <button className={classNames('button', `button-${variant}`, className)} {...props}>
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
      className={classNames('icon-button', className)}
      aria-label={label}
      title={label}
      {...props}
    >
      {children}
    </button>
  );
}
