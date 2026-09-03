import { z } from 'zod';

export const shortcutCategories = [
  'Workspace',
  'Navigation',
  'Selection',
  'Line editing',
  'General editing',
  'Search',
  'Multicursor',
  'Folding',
] as const;

export type ShortcutCategory = (typeof shortcutCategories)[number];
export type ShortcutScope = 'workspace' | 'editor';

export type ShortcutDefinition = {
  id: string;
  label: string;
  category: ShortcutCategory;
  scope: ShortcutScope;
  defaultBinding: string | null;
  macDefaultBinding?: string | null;
  command?: string;
  args?: Record<string, unknown>;
};

const workspace = (
  id: string,
  label: string,
  defaultBinding: string | null,
  macDefaultBinding?: string | null,
): ShortcutDefinition => ({
  id,
  label,
  category: 'Workspace',
  scope: 'workspace',
  defaultBinding,
  ...(macDefaultBinding !== undefined ? { macDefaultBinding } : {}),
});
const editor = (
  id: string,
  label: string,
  category: ShortcutCategory,
  defaultBinding: string | null,
  command: string,
  args?: Record<string, unknown>,
  macDefaultBinding?: string | null,
): ShortcutDefinition => ({
  id,
  label,
  category,
  scope: 'editor',
  defaultBinding,
  command,
  ...(args ? { args } : {}),
  ...(macDefaultBinding !== undefined ? { macDefaultBinding } : {}),
});

export const shortcutRegistry = [
  workspace('workspace.compile', 'Compile project', 'Ctrl+Enter', 'Meta+Enter'),
  workspace('workspace.save', 'Save current file', 'Ctrl+KeyS', 'Meta+KeyS'),
  workspace('workspace.commandPalette', 'Open command palette', 'Ctrl+KeyK', 'Meta+KeyK'),
  workspace(
    'workspace.keyboardShortcuts',
    'Open keyboard shortcuts',
    'Ctrl+Alt+KeyK',
    'Meta+Alt+KeyK',
  ),
  workspace('workspace.history', 'Open version history', 'Ctrl+Shift+KeyH', 'Meta+Shift+KeyH'),
  workspace('workspace.problems', 'Toggle Problems and Logs', 'Ctrl+KeyJ', 'Meta+KeyJ'),
  workspace('workspace.files', 'Toggle file tree', 'Ctrl+KeyB', 'Meta+KeyB'),
  workspace('workspace.focusFiles', 'Focus files', 'Alt+Digit1'),
  workspace('workspace.focusEditor', 'Focus editor', 'Alt+Digit2'),
  workspace('workspace.focusPreview', 'Focus PDF preview', 'Alt+Digit3'),
  {
    ...workspace('workspace.previousTab', 'Previous editor tab', 'Ctrl+PageUp'),
    macDefaultBinding: 'Meta+Shift+BracketLeft',
  },
  {
    ...workspace('workspace.nextTab', 'Next editor tab', 'Ctrl+PageDown'),
    macDefaultBinding: 'Meta+Shift+BracketRight',
  },
  workspace('workspace.togglePreview', 'Toggle PDF preview', null),
  workspace('workspace.closeTab', 'Close current tab', null),
  workspace('workspace.forwardSearch', 'Forward SyncTeX search', null),
  workspace('workspace.projectSettings', 'Open project settings', null),
  workspace('workspace.createFile', 'Create file', null),
  workspace('workspace.createFolder', 'Create folder', null),

  editor('editor.characterLeft', 'Move left', 'Navigation', 'ArrowLeft', 'cursorLeft'),
  editor('editor.characterRight', 'Move right', 'Navigation', 'ArrowRight', 'cursorRight'),
  editor('editor.characterUp', 'Move up', 'Navigation', 'ArrowUp', 'cursorUp'),
  editor('editor.characterDown', 'Move down', 'Navigation', 'ArrowDown', 'cursorDown'),
  editor(
    'editor.wordLeft',
    'Move word left',
    'Navigation',
    'Ctrl+ArrowLeft',
    'cursorWordLeft',
    undefined,
    'Alt+ArrowLeft',
  ),
  editor(
    'editor.wordRight',
    'Move word right',
    'Navigation',
    'Ctrl+ArrowRight',
    'cursorWordRight',
    undefined,
    'Alt+ArrowRight',
  ),
  editor(
    'editor.paragraphUp',
    'Move to previous paragraph',
    'Navigation',
    'Ctrl+ArrowUp',
    'cursorMove',
    { to: 'prevBlankLine' },
  ),
  editor(
    'editor.paragraphDown',
    'Move to next paragraph',
    'Navigation',
    'Ctrl+ArrowDown',
    'cursorMove',
    { to: 'nextBlankLine' },
  ),
  editor('editor.lineStart', 'Move to line start', 'Navigation', 'Home', 'cursorHome'),
  editor('editor.lineEnd', 'Move to line end', 'Navigation', 'End', 'cursorEnd'),
  editor('editor.documentStart', 'Move to document start', 'Navigation', 'Ctrl+Home', 'cursorTop'),
  editor('editor.documentEnd', 'Move to document end', 'Navigation', 'Ctrl+End', 'cursorBottom'),
  editor(
    'editor.matchBracket',
    'Go to matching bracket',
    'Navigation',
    'Ctrl+Shift+Backslash',
    'editor.action.jumpToBracket',
  ),
  editor(
    'editor.definition',
    'Go to definition',
    'Navigation',
    'F12',
    'editor.action.revealDefinition',
  ),
  editor(
    'editor.references',
    'Go to references',
    'Navigation',
    'Shift+F12',
    'editor.action.goToReferences',
  ),
  editor(
    'editor.symbols',
    'Go to symbol',
    'Navigation',
    'Ctrl+Shift+KeyO',
    'editor.action.quickOutline',
  ),
  editor('editor.nextProblem', 'Next problem', 'Navigation', 'F8', 'editor.action.marker.next'),
  editor(
    'editor.previousProblem',
    'Previous problem',
    'Navigation',
    'Shift+F8',
    'editor.action.marker.prev',
  ),

  editor('editor.selectLeft', 'Select left', 'Selection', 'Shift+ArrowLeft', 'cursorLeftSelect'),
  editor(
    'editor.selectRight',
    'Select right',
    'Selection',
    'Shift+ArrowRight',
    'cursorRightSelect',
  ),
  editor('editor.selectUp', 'Select up', 'Selection', 'Shift+ArrowUp', 'cursorUpSelect'),
  editor('editor.selectDown', 'Select down', 'Selection', 'Shift+ArrowDown', 'cursorDownSelect'),
  editor(
    'editor.selectWordLeft',
    'Select word left',
    'Selection',
    'Ctrl+Shift+ArrowLeft',
    'cursorWordLeftSelect',
    undefined,
    'Alt+Shift+ArrowLeft',
  ),
  editor(
    'editor.selectWordRight',
    'Select word right',
    'Selection',
    'Ctrl+Shift+ArrowRight',
    'cursorWordRightSelect',
    undefined,
    'Alt+Shift+ArrowRight',
  ),
  editor(
    'editor.selectParagraphUp',
    'Select to previous paragraph',
    'Selection',
    'Ctrl+Shift+ArrowUp',
    'cursorMove',
    { to: 'prevBlankLine', select: true },
  ),
  editor(
    'editor.selectParagraphDown',
    'Select to next paragraph',
    'Selection',
    'Ctrl+Shift+ArrowDown',
    'cursorMove',
    { to: 'nextBlankLine', select: true },
  ),
  editor(
    'editor.selectLineStart',
    'Select to line start',
    'Selection',
    'Shift+Home',
    'cursorHomeSelect',
  ),
  editor('editor.selectLineEnd', 'Select to line end', 'Selection', 'Shift+End', 'cursorEndSelect'),
  editor(
    'editor.selectDocumentStart',
    'Select to document start',
    'Selection',
    'Ctrl+Shift+Home',
    'cursorTopSelect',
  ),
  editor(
    'editor.selectDocumentEnd',
    'Select to document end',
    'Selection',
    'Ctrl+Shift+End',
    'cursorBottomSelect',
  ),
  editor(
    'editor.expandSelection',
    'Expand selection',
    'Selection',
    'Shift+Alt+ArrowRight',
    'editor.action.smartSelect.expand',
    undefined,
    'Ctrl+Shift+ArrowRight',
  ),
  editor(
    'editor.shrinkSelection',
    'Shrink selection',
    'Selection',
    'Shift+Alt+ArrowLeft',
    'editor.action.smartSelect.shrink',
    undefined,
    'Ctrl+Shift+ArrowLeft',
  ),
  editor(
    'editor.selectLine',
    'Select current line',
    'Selection',
    'Ctrl+KeyL',
    'expandLineSelection',
  ),
  editor(
    'editor.nextOccurrence',
    'Add next occurrence',
    'Selection',
    null,
    'editor.action.addSelectionToNextFindMatch',
  ),
  editor(
    'editor.allOccurrences',
    'Select all occurrences',
    'Selection',
    'Ctrl+Shift+KeyL',
    'editor.action.selectHighlights',
  ),

  editor(
    'editor.moveLineUp',
    'Move line up',
    'Line editing',
    'Alt+ArrowUp',
    'editor.action.moveLinesUpAction',
  ),
  editor(
    'editor.moveLineDown',
    'Move line down',
    'Line editing',
    'Alt+ArrowDown',
    'editor.action.moveLinesDownAction',
  ),
  editor(
    'editor.duplicateLineUp',
    'Duplicate line up',
    'Line editing',
    'Ctrl+Alt+ArrowUp',
    'editor.action.copyLinesUpAction',
  ),
  editor(
    'editor.duplicateLineDown',
    'Duplicate line down',
    'Line editing',
    'Ctrl+Alt+ArrowDown',
    'editor.action.copyLinesDownAction',
  ),
  editor(
    'editor.deleteLine',
    'Delete line',
    'Line editing',
    'Ctrl+KeyD',
    'editor.action.deleteLines',
  ),
  editor('editor.indent', 'Indent line', 'Line editing', 'Tab', 'tab'),
  editor('editor.outdent', 'Outdent line', 'Line editing', 'Shift+Tab', 'outdent'),
  editor(
    'editor.toggleComment',
    'Toggle line comment',
    'Line editing',
    'Ctrl+Slash',
    'editor.action.commentLine',
  ),
  editor(
    'editor.deleteWordLeft',
    'Delete previous word',
    'Line editing',
    'Ctrl+Backspace',
    'deleteWordLeft',
    undefined,
    'Alt+Backspace',
  ),
  editor(
    'editor.deleteWordRight',
    'Delete next word',
    'Line editing',
    'Ctrl+Delete',
    'deleteWordRight',
    undefined,
    'Alt+Delete',
  ),
  editor(
    'editor.insertLineAbove',
    'Insert line above',
    'Line editing',
    'Ctrl+Shift+Enter',
    'editor.action.insertLineBefore',
  ),
  editor(
    'editor.insertLineBelow',
    'Insert line below',
    'Line editing',
    null,
    'editor.action.insertLineAfter',
  ),
  editor('editor.joinLines', 'Join lines', 'Line editing', null, 'editor.action.joinLines'),
  editor(
    'editor.trimWhitespace',
    'Trim trailing whitespace',
    'Line editing',
    null,
    'editor.action.trimTrailingWhitespace',
  ),
  editor(
    'editor.uppercase',
    'Transform to uppercase',
    'Line editing',
    null,
    'editor.action.transformToUppercase',
  ),
  editor(
    'editor.lowercase',
    'Transform to lowercase',
    'Line editing',
    null,
    'editor.action.transformToLowercase',
  ),

  editor('editor.undo', 'Undo', 'General editing', 'Ctrl+KeyZ', 'undo', undefined, 'Meta+KeyZ'),
  editor(
    'editor.redo',
    'Redo',
    'General editing',
    'Ctrl+KeyY',
    'redo',
    undefined,
    'Meta+Shift+KeyZ',
  ),
  editor(
    'editor.cut',
    'Cut',
    'General editing',
    'Ctrl+KeyX',
    'editor.action.clipboardCutAction',
    undefined,
    'Meta+KeyX',
  ),
  editor(
    'editor.copy',
    'Copy',
    'General editing',
    'Ctrl+KeyC',
    'editor.action.clipboardCopyAction',
    undefined,
    'Meta+KeyC',
  ),
  editor(
    'editor.paste',
    'Paste',
    'General editing',
    'Ctrl+KeyV',
    'editor.action.clipboardPasteAction',
  ),
  editor(
    'editor.selectAll',
    'Select all',
    'General editing',
    'Ctrl+KeyA',
    'editor.action.selectAll',
  ),
  editor('editor.find', 'Find', 'Search', 'Ctrl+KeyF', 'actions.find', undefined, 'Meta+KeyF'),
  editor(
    'editor.replace',
    'Replace',
    'Search',
    'Ctrl+KeyH',
    'editor.action.startFindReplaceAction',
  ),
  editor(
    'editor.nextFind',
    'Next find result',
    'Search',
    'F3',
    'editor.action.nextMatchFindAction',
  ),
  editor(
    'editor.previousFind',
    'Previous find result',
    'Search',
    'Shift+F3',
    'editor.action.previousMatchFindAction',
  ),
  editor(
    'editor.cursorAbove',
    'Add cursor above',
    'Multicursor',
    'Shift+Alt+ArrowUp',
    'editor.action.insertCursorAbove',
  ),
  editor(
    'editor.cursorBelow',
    'Add cursor below',
    'Multicursor',
    'Shift+Alt+ArrowDown',
    'editor.action.insertCursorBelow',
  ),
  editor(
    'editor.cursorsAtLineEnds',
    'Add cursors to line ends',
    'Multicursor',
    'Shift+Alt+KeyI',
    'editor.action.insertCursorAtEndOfEachLineSelected',
  ),
  editor('editor.undoCursor', 'Undo last cursor', 'Multicursor', 'Ctrl+KeyU', 'cursorUndo'),
  editor(
    'editor.fold',
    'Fold',
    'Folding',
    'Ctrl+Shift+BracketLeft',
    'editor.fold',
    undefined,
    'Meta+Alt+BracketLeft',
  ),
  editor(
    'editor.unfold',
    'Unfold',
    'Folding',
    'Ctrl+Shift+BracketRight',
    'editor.unfold',
    undefined,
    'Meta+Alt+BracketRight',
  ),
  editor('editor.foldAll', 'Fold all', 'Folding', null, 'editor.foldAll'),
  editor('editor.unfoldAll', 'Unfold all', 'Folding', null, 'editor.unfoldAll'),
] as const satisfies readonly ShortcutDefinition[];

export type ShortcutActionId = (typeof shortcutRegistry)[number]['id'];
export const shortcutActionIds = shortcutRegistry.map(({ id }) => id) as ShortcutActionId[];

const modifiers = ['Ctrl', 'Meta', 'Alt', 'Shift'] as const;
const modifierSet = new Set<string>(modifiers);
const primaryPattern =
  /^(?:Key[A-Z]|Digit[0-9]|Arrow(?:Up|Down|Left|Right)|F(?:[1-9]|1[0-2])|Enter|Escape|Tab|Backspace|Delete|Home|End|PageUp|PageDown|Space|BracketLeft|BracketRight|Backslash|Slash|Comma|Period|Semicolon|Quote|Minus|Equal)$/;

export function canonicalizeShortcutSequence(input: string): string {
  const strokes = input.trim().split(/\s+/);
  if (strokes.length < 1 || strokes.length > 2)
    throw new Error('A shortcut must contain one or two strokes');
  return strokes
    .map((stroke) => {
      const parts = stroke.split('+').filter(Boolean);
      const primary = parts.filter((part) => !modifierSet.has(part));
      if (primary.length !== 1 || !primaryPattern.test(primary[0]!))
        throw new Error('Each stroke needs one supported non-modifier key');
      if (new Set(parts).size !== parts.length)
        throw new Error('A shortcut cannot repeat a key or modifier');
      return [...modifiers.filter((modifier) => parts.includes(modifier)), primary[0]].join('+');
    })
    .join(' ');
}

export const shortcutSequenceSchema = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => {
    try {
      return canonicalizeShortcutSequence(value) === value;
    } catch {
      return false;
    }
  }, 'Shortcut must be a supported canonical sequence');

const keyboardShortcutOverridesBaseSchema = z.partialRecord(
  z.enum(shortcutActionIds as [ShortcutActionId, ...ShortcutActionId[]]),
  z.union([shortcutSequenceSchema, z.null()]),
);

function shortcutOverridesSchema(isMac: boolean) {
  return keyboardShortcutOverridesBaseSchema.superRefine((overrides, context) => {
    const resolved = resolveShortcutBindings(overrides, isMac);
    for (let leftIndex = 0; leftIndex < shortcutRegistry.length; leftIndex += 1) {
      const left = shortcutRegistry[leftIndex]!;
      const leftBinding = resolved[left.id];
      if (!leftBinding) continue;
      for (let rightIndex = leftIndex + 1; rightIndex < shortcutRegistry.length; rightIndex += 1) {
        const right = shortcutRegistry[rightIndex]!;
        const rightBinding = resolved[right.id];
        let conflicts = false;
        try {
          conflicts = Boolean(rightBinding && shortcutsConflict(leftBinding, rightBinding));
        } catch {
          continue;
        }
        if (conflicts) {
          context.addIssue({
            code: 'custom',
            path: [right.id],
            message: `Conflicts with ${left.id}`,
          });
        }
      }
    }
  });
}

export const keyboardShortcutOverridesSchema = shortcutOverridesSchema(false);
export type KeyboardShortcutOverrides = z.infer<typeof keyboardShortcutOverridesSchema>;
export const keyboardKeymapSchema = z.enum(['linux', 'macos']);
export type KeyboardKeymap = z.infer<typeof keyboardKeymapSchema>;
export const keyboardShortcutProfilesSchema = z.object({
  linux: keyboardShortcutOverridesSchema,
  macos: shortcutOverridesSchema(true),
});
export type KeyboardShortcutProfiles = z.infer<typeof keyboardShortcutProfilesSchema>;

export const putKeyboardShortcutsSchema = z.union([
  z.object({
    overrides: z.partialRecord(
      z.enum(shortcutActionIds as [ShortcutActionId, ...ShortcutActionId[]]),
      z.union([z.string().min(1).max(100), z.null()]),
    ),
  }),
  z.object({
    keymap: keyboardKeymapSchema,
    overrides: keyboardShortcutProfilesSchema,
  }),
]);
export const keyboardShortcutsResponseSchema = z.object({
  version: z.literal(2),
  keymap: keyboardKeymapSchema,
  overrides: keyboardShortcutProfilesSchema,
  updatedAt: z.iso.datetime().nullable(),
});
export type KeyboardShortcutsResponse = z.infer<typeof keyboardShortcutsResponseSchema>;

export function migrateLegacyShortcutOverrides(value: unknown): KeyboardShortcutProfiles {
  const profiles = keyboardShortcutProfilesSchema.safeParse(value);
  if (profiles.success) return profiles.data;
  const raw = z
    .partialRecord(
      z.enum(shortcutActionIds as [ShortcutActionId, ...ShortcutActionId[]]),
      z.unknown(),
    )
    .safeParse(value);
  const linux: KeyboardShortcutOverrides = {};
  if (raw.success) {
    for (const [id, binding] of Object.entries(raw.data)) {
      if (binding === null) {
        linux[id as ShortcutActionId] = null;
        continue;
      }
      if (typeof binding !== 'string') continue;
      try {
        linux[id as ShortcutActionId] = canonicalizeShortcutSequence(
          binding.replaceAll('Mod', 'Ctrl'),
        );
      } catch {
        // Ignore bindings that can no longer be represented literally.
      }
    }
  }
  return { linux, macos: {} };
}

export function shortcutDefault(definition: ShortcutDefinition, isMac: boolean): string | null {
  if (!isMac) return definition.defaultBinding;
  if (definition.macDefaultBinding !== undefined) return definition.macDefaultBinding;
  return definition.defaultBinding?.replaceAll('Ctrl', 'Meta') ?? null;
}

export function resolveShortcutBindings(overrides: KeyboardShortcutOverrides, isMac: boolean) {
  return Object.fromEntries(
    shortcutRegistry.map((definition) => [
      definition.id,
      Object.prototype.hasOwnProperty.call(overrides, definition.id)
        ? (overrides[definition.id as ShortcutActionId] ?? null)
        : shortcutDefault(definition, isMac),
    ]),
  ) as Record<ShortcutActionId, string | null>;
}

export function shortcutsConflict(left: string, right: string): boolean {
  const a = canonicalizeShortcutSequence(left).split(' ');
  const b = canonicalizeShortcutSequence(right).split(' ');
  return a[0] === b[0] && (a.length === 1 || b.length === 1 || a[1] === b[1]);
}

export function replaceConflictingShortcut(
  overrides: KeyboardShortcutOverrides,
  actionId: ShortcutActionId,
  binding: string,
  isMac: boolean,
): KeyboardShortcutOverrides {
  const canonical = canonicalizeShortcutSequence(binding);
  const resolved = resolveShortcutBindings(overrides, isMac);
  const next = { ...overrides };
  for (const definition of shortcutRegistry) {
    const existing = resolved[definition.id];
    if (definition.id !== actionId && existing && shortcutsConflict(existing, canonical)) {
      next[definition.id] = null;
    }
  }
  next[actionId] = canonical;
  return next;
}
