import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as DropdownPrimitive from '@radix-ui/react-dropdown-menu';
import { createElement as h, useRef } from 'react';
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  AnchorHTMLAttributes,
  ReactNode,
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
} from 'react';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost';
  large?: boolean;
};
const classes = (...values: (string | false | undefined)[]) => values.filter(Boolean).join(' ');
export function Button({ variant = 'secondary', large = false, className, ...props }: ButtonProps) {
  return h('button', {
    type: 'button',
    ...props,
    className: classes(
      'btn',
      variant === 'primary' ? 'btn-p' : variant === 'ghost' ? 'btn-g' : 'btn-s',
      large && 'btn-lg',
      className,
    ),
  });
}
export function IconButton({
  label,
  compact = false,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; compact?: boolean }) {
  return h('button', {
    type: 'button',
    ...props,
    'aria-label': label,
    title: label,
    className: classes(compact ? 'tb' : 'ib', className),
  });
}
export function Field({
  compact = false,
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { compact?: boolean }) {
  return h('input', { ...props, className: classes('fld', compact && 'fld-compact', className) });
}
export function Switch({
  checked,
  onCheckedChange,
  label,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> & {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
}) {
  return h('button', {
    type: 'button',
    ...props,
    className: classes('sw', props.className),
    role: 'switch',
    'aria-label': label,
    'aria-checked': checked,
    'data-on': checked ? '' : undefined,
    onClick: () => onCheckedChange(!checked),
  });
}
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (value: T) => void;
  options: readonly { value: T; label: ReactNode }[];
  label: string;
}) {
  return h(
    'div',
    { className: 'seg', role: 'group', 'aria-label': label },
    options.map((option) =>
      h(
        'button',
        {
          type: 'button',
          className: 'tb',
          key: option.value,
          'aria-pressed': option.value === value,
          onClick: () => onChange(option.value),
        },
        option.label,
      ),
    ),
  );
}
export function Tabs<T extends string>({
  value,
  onChange,
  tabs,
  label,
  variant = 'page',
}: {
  value: T;
  onChange: (value: T) => void;
  tabs: readonly { value: T; label: ReactNode; panelId?: string }[];
  label: string;
  variant?: 'page' | 'panel' | 'editor';
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  return h(
    'div',
    { role: 'tablist', 'aria-label': label },
    tabs.map((tab, index) =>
      h(
        'button',
        {
          type: 'button',
          key: tab.value,
          ref: (node: HTMLButtonElement | null): void => {
            refs.current[index] = node;
          },
          className: variant === 'panel' ? 'ptab' : variant === 'editor' ? 'etab' : 'tab',
          role: 'tab',
          'aria-selected': tab.value === value,
          'aria-controls': tab.panelId,
          tabIndex: tab.value === value ? 0 : -1,
          onClick: () => onChange(tab.value),
          onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => {
            const next =
              event.key === 'ArrowRight'
                ? (index + 1) % tabs.length
                : event.key === 'ArrowLeft'
                  ? (index + tabs.length - 1) % tabs.length
                  : event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? tabs.length - 1
                      : -1;
            const target = tabs[next];
            if (target) {
              event.preventDefault();
              onChange(target.value);
              refs.current[next]?.focus();
            }
          },
        },
        tab.label,
      ),
    ),
  );
}
export function NavRow({
  current,
  className,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & { current?: boolean }) {
  return h('a', {
    ...props,
    className: classes('nv', className),
    'aria-current': current ? 'page' : undefined,
  });
}
export function TreeRow({
  depth = 0,
  current,
  className,
  style,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { depth?: number; current?: boolean }) {
  return h('button', {
    type: 'button',
    ...props,
    className: classes('tr', className),
    style: { ...style, '--d': `${12 + depth * 16}px` } as CSSProperties,
    'aria-current': current ? 'true' : undefined,
  });
}
export function Menu({
  trigger,
  children,
  label,
}: {
  trigger: ReactNode;
  children: ReactNode;
  label: string;
}) {
  return h(
    DropdownPrimitive.Root,
    null,
    h(DropdownPrimitive.Trigger, { asChild: true, 'aria-label': label, title: label }, trigger),
    h(
      DropdownPrimitive.Portal,
      null,
      h(
        DropdownPrimitive.Content,
        { className: 'menu menu-popover', sideOffset: 4, align: 'end', 'aria-label': label },
        children,
      ),
    ),
  );
}
export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  return h(
    DialogPrimitive.Root,
    {
      open,
      onOpenChange: (value: boolean) => {
        if (!value) onClose();
      },
    },
    h(
      DialogPrimitive.Portal,
      null,
      h(DialogPrimitive.Overlay, { className: 'scrim scrim-modal' }),
      h(
        DialogPrimitive.Content,
        { className: classes('dialog dialog-modal', className), 'aria-describedby': undefined },
        h(
          'header',
          { className: 'dialog-head' },
          h(DialogPrimitive.Title, { className: 'dialog-title' }, title),
          h(DialogPrimitive.Close, { className: 'ib', 'aria-label': 'Close', title: 'Close' }, '×'),
        ),
        children,
        footer ? h('footer', { className: 'dialog-foot' }, footer) : null,
      ),
    ),
  );
}
