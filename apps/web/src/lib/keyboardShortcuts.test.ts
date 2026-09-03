import { describe, expect, it } from 'vitest';
import { displayShortcut, shortcutStrokeFromEvent } from './keyboardShortcuts';

describe('browser shortcut normalization', () => {
  it('records literal Ctrl and Meta modifiers', () => {
    const base = { isComposing: false, code: 'KeyK', key: 'k', altKey: false, shiftKey: true };
    expect(
      shortcutStrokeFromEvent({ ...base, ctrlKey: true, metaKey: false } as KeyboardEvent, false),
    ).toBe('Ctrl+Shift+KeyK');
    expect(
      shortcutStrokeFromEvent({ ...base, ctrlKey: false, metaKey: true } as KeyboardEvent, true),
    ).toBe('Meta+Shift+KeyK');
  });

  it('retains explicit non-primary Ctrl and Meta modifiers', () => {
    const base = {
      isComposing: false,
      code: 'ArrowUp',
      key: 'ArrowUp',
      altKey: false,
      shiftKey: false,
    };
    expect(
      shortcutStrokeFromEvent({ ...base, ctrlKey: true, metaKey: false } as KeyboardEvent, true),
    ).toBe('Ctrl+ArrowUp');
    expect(
      shortcutStrokeFromEvent({ ...base, ctrlKey: false, metaKey: true } as KeyboardEvent, false),
    ).toBe('Meta+ArrowUp');
  });

  it('formats platform labels', () => {
    expect(displayShortcut('Ctrl+Alt+KeyK', false)).toBe('Ctrl+Alt+K');
    expect(displayShortcut('Meta+Alt+KeyK', true)).toBe('⌘⌥K');
  });
});
