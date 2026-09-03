import { describe, expect, it } from 'vitest';
import {
  canonicalizeShortcutSequence,
  keyboardShortcutOverridesSchema,
  migrateLegacyShortcutOverrides,
  putKeyboardShortcutsSchema,
  replaceConflictingShortcut,
  resolveShortcutBindings,
  shortcutsConflict,
} from './keyboard-shortcuts.js';

describe('keyboard shortcuts', () => {
  it('canonicalizes modifier order and supports two-stroke chords', () => {
    expect(canonicalizeShortcutSequence('Shift+Ctrl+KeyP Alt+KeyX')).toBe(
      'Ctrl+Shift+KeyP Alt+KeyX',
    );
  });

  it.each(['', 'Mod', 'Mod+KeyA+KeyB', 'Mod+KeyA Ctrl+KeyB Alt+KeyC', 'Mod+Ctrl+KeyK'])(
    'rejects malformed sequence %j',
    (sequence) => expect(() => canonicalizeShortcutSequence(sequence)).toThrow(),
  );

  it('merges defaults, overrides, and explicit unbinding', () => {
    const resolved = resolveShortcutBindings(
      { 'workspace.compile': 'Ctrl+KeyR', 'workspace.save': null },
      false,
    );
    expect(resolved['workspace.compile']).toBe('Ctrl+KeyR');
    expect(resolved['workspace.save']).toBeNull();
    expect(resolved['workspace.commandPalette']).toBe('Ctrl+KeyK');
    expect(resolved['editor.deleteLine']).toBe('Ctrl+KeyD');
    expect(resolved['editor.nextOccurrence']).toBeNull();
  });

  it('uses platform-specific defaults', () => {
    expect(resolveShortcutBindings({}, true)['editor.wordLeft']).toBe('Alt+ArrowLeft');
    expect(resolveShortcutBindings({}, false)['editor.wordLeft']).toBe('Ctrl+ArrowLeft');
  });

  it('detects exact and prefix conflicts', () => {
    expect(shortcutsConflict('Ctrl+KeyK', 'Ctrl+KeyK Alt+KeyX')).toBe(true);
    expect(shortcutsConflict('Ctrl+KeyK Alt+KeyX', 'Ctrl+KeyK Alt+KeyC')).toBe(false);
    expect(shortcutsConflict('Ctrl+KeyK Alt+KeyX', 'Ctrl+KeyK Alt+KeyX')).toBe(true);
  });

  it('atomically unbinds a conflicting action on replacement', () => {
    const next = replaceConflictingShortcut({}, 'workspace.save', 'Ctrl+Enter', false);
    expect(next['workspace.compile']).toBeNull();
    expect(next['workspace.save']).toBe('Ctrl+Enter');
  });

  it('migrates v1 Mod overrides into the Linux profile', () => {
    expect(migrateLegacyShortcutOverrides({ 'workspace.save': 'Mod+KeyS' })).toEqual({
      linux: { 'workspace.save': 'Ctrl+KeyS' },
      macos: {},
    });
  });

  it('accepts sparse v2 profile overrides', () => {
    expect(
      putKeyboardShortcutsSchema.safeParse({
        keymap: 'linux',
        overrides: {
          linux: { 'workspace.compile': null, 'workspace.commandPalette': 'Ctrl+Enter' },
          macos: {},
        },
      }).success,
    ).toBe(true);
  });

  it('rejects unknown actions and oversized bindings', () => {
    expect(keyboardShortcutOverridesSchema.safeParse({ unknown: 'Ctrl+KeyK' }).success).toBe(false);
    expect(
      keyboardShortcutOverridesSchema.safeParse({ 'workspace.save': `Ctrl+${'A'.repeat(101)}` })
        .success,
    ).toBe(false);
  });

  it('rejects exact and chord-prefix conflicts in persisted maps', () => {
    expect(
      keyboardShortcutOverridesSchema.safeParse({
        'workspace.save': 'Ctrl+KeyK Alt+KeyX',
      }).success,
    ).toBe(false);
    expect(
      keyboardShortcutOverridesSchema.safeParse({
        'workspace.save': 'Ctrl+Enter',
      }).success,
    ).toBe(false);
  });
});
