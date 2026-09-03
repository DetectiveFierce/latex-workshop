import { useQuery } from '@tanstack/react-query';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  canonicalizeShortcutSequence,
  keyboardShortcutsResponseSchema,
  resolveShortcutBindings,
  shortcutRegistry,
  type KeyboardKeymap,
  type KeyboardShortcutOverrides,
  type KeyboardShortcutsResponse,
  type ShortcutActionId,
} from '@latex-workshop/contracts';
import { api, queryKeys } from './api';

export type { KeyboardShortcutsResponse } from '@latex-workshop/contracts';

export const isMacPlatform = () =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export function shortcutCacheKey(userId: string) {
  return `keyboard-shortcuts:${userId}`;
}

export function readShortcutCache(userId: string): KeyboardShortcutsResponse | undefined {
  try {
    const value = localStorage.getItem(shortcutCacheKey(userId));
    if (!value) return undefined;
    const parsed = keyboardShortcutsResponseSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function cacheShortcuts(userId: string, value: KeyboardShortcutsResponse) {
  localStorage.setItem(shortcutCacheKey(userId), JSON.stringify(value));
}

export function useKeyboardShortcuts(userId?: string) {
  return useQuery({
    queryKey: queryKeys.keyboardShortcuts(userId ?? ''),
    enabled: Boolean(userId),
    initialData: userId ? readShortcutCache(userId) : undefined,
    queryFn: async () => {
      const value = await api<KeyboardShortcutsResponse>('/api/v1/preferences/keyboard-shortcuts');
      if (userId) cacheShortcuts(userId, value);
      return value;
    },
    staleTime: 0,
  });
}

export function resolvedShortcuts(
  overrides: KeyboardShortcutOverrides = {},
  keymap: KeyboardKeymap = 'linux',
) {
  return resolveShortcutBindings(overrides, keymap === 'macos');
}

const modifierCodes = new Set([
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
]);

export function shortcutStrokeFromEvent(
  event: KeyboardEvent | ReactKeyboardEvent,
  _mac = isMacPlatform(),
): string | null {
  if (('isComposing' in event && event.isComposing) || modifierCodes.has(event.code)) return null;
  const parts: string[] = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.metaKey) parts.push('Meta');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  parts.push(normalizeEventCode(event.code, event.key));
  try {
    return canonicalizeShortcutSequence(parts.join('+'));
  } catch {
    return null;
  }
}

export function shortcutStrokeCandidatesFromEvent(event: KeyboardEvent): string[] {
  const primary = shortcutStrokeFromEvent(event);
  return primary ? [primary] : [];
}

function normalizeEventCode(code: string, key: string) {
  if (code === 'NumpadEnter') return 'Enter';
  if (
    code &&
    /^(Key|Digit|Arrow|F\d|Enter|Escape|Tab|Backspace|Delete|Home|End|Page|Space|Bracket|Backslash|Slash|Comma|Period|Semicolon|Quote|Minus|Equal)/.test(
      code,
    )
  )
    return code;
  return key.length === 1 && /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : key;
}

export function displayShortcut(binding: string | null | undefined, mac = isMacPlatform()): string {
  if (!binding) return 'Unbound';
  return binding
    .split(' ')
    .map((stroke) =>
      stroke
        .split('+')
        .map((part) => {
          if (part === 'Meta') return mac ? '⌘' : 'Meta';
          if (part === 'Alt') return mac ? '⌥' : 'Alt';
          if (part === 'Shift') return mac ? '⇧' : 'Shift';
          if (part.startsWith('Key')) return part.slice(3);
          if (part.startsWith('Digit')) return part.slice(5);
          return part.replace('Arrow', '');
        })
        .join(mac ? '' : '+'),
    )
    .join('  ');
}

export function findShortcutAction(
  resolved: Record<ShortcutActionId, string | null>,
  sequence: string,
) {
  return shortcutRegistry.find((definition) => resolved[definition.id] === sequence);
}
