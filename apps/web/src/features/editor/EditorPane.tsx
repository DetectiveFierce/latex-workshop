import { useEffect, useMemo, useRef, useState } from 'react';
import Editor, { loader, type OnMount } from '@monaco-editor/react';
import { get, set, del } from 'idb-keyval';
import * as Monaco from 'monaco-editor';
import { CommandsRegistry } from 'monaco-editor/platform/commands/common/commands.js';
import MonacoEditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import {
  mergeText,
  shortcutRegistry,
  type EditorSelectionSnapshot,
  type ProjectEntry,
  type ShortcutActionId,
} from '@latex-workshop/contracts';
import { registerLatexLanguage, languageFor } from './latexLanguage';
import { TexLabClient, type TexLabStatus } from './lspClient';

self.MonacoEnvironment = {
  getWorker: () => new MonacoEditorWorker(),
};
loader.config({ monaco: Monaco });

export type SaveState = 'saved' | 'saving' | 'dirty' | 'offline' | 'conflict';
export type SaveResult = {
  version: number;
  content: string;
  merged: boolean;
  unchanged: boolean;
};
export type SaveMetadata = {
  selectionBefore: EditorSelectionSnapshot | null;
  selectionAfter: EditorSelectionSnapshot | null;
  recoveredDraft?: boolean;
};

type FileController = {
  entryId: string;
  modelPath: string;
  baseVersion: number;
  acknowledgedValue: string;
  latestValue: string;
  timer: ReturnType<typeof setTimeout> | null;
  saveLoop: Promise<void> | null;
  saveState: SaveState;
  selection: EditorSelectionSnapshot | null;
  recoveryPending: boolean;
  staleModelPaths: string[];
};

const ownedModels = new Map<string, Map<string, string>>();
const controllerDisposers = new Map<string, (entryId?: string) => void>();

export function disposeEditorEntry(projectId: string, entryId: string) {
  controllerDisposers.get(projectId)?.(entryId);
  const models = ownedModels.get(projectId);
  const uri = models?.get(entryId);
  if (uri) Monaco.editor.getModel(Monaco.Uri.parse(uri))?.dispose();
  models?.delete(entryId);
}

export function disposeProjectEditors(projectId: string) {
  controllerDisposers.get(projectId)?.();
  for (const uri of ownedModels.get(projectId)?.values() ?? [])
    Monaco.editor.getModel(Monaco.Uri.parse(uri))?.dispose();
  ownedModels.delete(projectId);
}

export function EditorPane({
  projectId,
  entry,
  path,
  content,
  onChange,
  onSave,
  onConflict,
  onCursor,
  onLanguageStatus,
  onRegisterSave,
  onRegisterFocus,
  onRegisterShortcutRunner,
  onSourceLocate,
  onSaveState,
  shortcuts,
  keymap,
  onWorkspaceShortcut,
  onHistoryAction,
  revealLine,
  navigationToken,
  navigationSelections,
  fontSize,
  touchLayout,
}: {
  projectId: string;
  entry: ProjectEntry;
  path: string;
  content: string;
  onChange: (entryId: string, value: string) => void;
  onSave: (
    entryId: string,
    value: string,
    baseVersion: number,
    metadata: SaveMetadata,
  ) => Promise<SaveResult>;
  onConflict: (
    entryId: string,
    local: string,
    server: { version: number; content: string },
  ) => void;
  onCursor: (line: number, column: number) => void;
  onLanguageStatus: (status: TexLabStatus) => void;
  onRegisterSave?: (save: () => Promise<void>) => void;
  onRegisterFocus?: (focus: () => void) => void;
  onRegisterShortcutRunner?: (run: (action: ShortcutActionId) => void) => void;
  onSourceLocate?: (selection: {
    start: { line: number; column: number };
    end: { line: number; column: number };
    text: string;
    before: string;
    after: string;
  }) => void;
  onSaveState?: (entryId: string, state: SaveState) => void;
  shortcuts: Record<ShortcutActionId, string | null>;
  keymap: 'linux' | 'macos';
  onWorkspaceShortcut: (action: ShortcutActionId) => void;
  onHistoryAction?: (direction: 'undo' | 'redo') => void;
  revealLine?: number | null;
  navigationToken?: number;
  navigationSelections?: EditorSelectionSnapshot | null;
  fontSize: number;
  touchLayout: boolean;
}) {
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const lspRef = useRef<TexLabClient | null>(null);
  const controllers = useRef(new Map<string, FileController>());
  const activeEntryId = useRef(entry.id);
  const mounted = useRef(true);
  const applyingSyncedContent = useRef(false);
  const onSaveRef = useRef(onSave);
  const onConflictRef = useRef(onConflict);
  const onChangeRef = useRef(onChange);
  const onSaveStateRef = useRef(onSaveState);
  const onSourceLocateRef = useRef(onSourceLocate);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [editorReady, setEditorReady] = useState(false);
  const modelPath = useMemo(() => `file:///workspace/${path}`, [path]);

  onSaveRef.current = onSave;
  onConflictRef.current = onConflict;
  onChangeRef.current = onChange;
  onSaveStateRef.current = onSaveState;
  onSourceLocateRef.current = onSourceLocate;

  let controller = controllers.current.get(entry.id);
  if (!controller) {
    controller = {
      entryId: entry.id,
      modelPath,
      baseVersion: entry.version,
      acknowledgedValue: content,
      latestValue: content,
      timer: null,
      saveLoop: null,
      saveState: 'saved',
      selection: null,
      recoveryPending: false,
      staleModelPaths: [],
    };
    controllers.current.set(entry.id, controller);
  }
  if (controller.modelPath !== modelPath) {
    controller.staleModelPaths.push(controller.modelPath);
    controller.modelPath = modelPath;
  }
  const projectModels = ownedModels.get(projectId) ?? new Map<string, string>();
  projectModels.set(entry.id, modelPath);
  ownedModels.set(projectId, projectModels);

  const setControllerSaveState = (target: FileController, state: SaveState) => {
    target.saveState = state;
    if (mounted.current && activeEntryId.current === target.entryId) setSaveState(state);
    onSaveStateRef.current?.(target.entryId, state);
  };

  function applySyncedContent(target: FileController, value: string) {
    target.latestValue = value;
    const editor = editorRef.current;
    const model = Monaco.editor.getModel(Monaco.Uri.parse(target.modelPath));
    if (model && model.getValue() !== value) {
      const current = model.getValue();
      let start = 0;
      const prefixLimit = Math.min(current.length, value.length);
      while (start < prefixLimit && current[start] === value[start]) start += 1;
      let currentEnd = current.length;
      let valueEnd = value.length;
      while (
        currentEnd > start &&
        valueEnd > start &&
        current[currentEnd - 1] === value[valueEnd - 1]
      ) {
        currentEnd -= 1;
        valueEnd -= 1;
      }
      const startPosition = model.getPositionAt(start);
      const endPosition = model.getPositionAt(currentEnd);
      applyingSyncedContent.current = true;
      const edit = {
        range: new Monaco.Range(
          startPosition.lineNumber,
          startPosition.column,
          endPosition.lineNumber,
          endPosition.column,
        ),
        text: value.slice(start, valueEnd),
        forceMoveMarkers: true,
      };
      if (editor?.getModel() === model) editor.executeEdits('background-sync', [edit]);
      else model.applyEdits([edit]);
      applyingSyncedContent.current = false;
      lspRef.current?.change(model);
    }
    onChangeRef.current(target.entryId, value);
  }

  function flush(entryId = activeEntryId.current): Promise<void> {
    const target = controllers.current.get(entryId);
    if (!target) return Promise.resolve();
    if (target.timer) {
      clearTimeout(target.timer);
      target.timer = null;
    }
    if (target.saveLoop) return target.saveLoop;

    const run = (async () => {
      while (target.latestValue !== target.acknowledgedValue) {
        const value = target.latestValue;
        const requestVersion = target.baseVersion;
        setControllerSaveState(target, 'saving');
        try {
          const selectionAfter =
            activeEntryId.current === entryId
              ? snapshotSelections(editorRef.current?.getSelections())
              : target.selection;
          const result = await onSaveRef.current(entryId, value, requestVersion, {
            selectionBefore: target.selection,
            selectionAfter,
            ...(target.recoveryPending ? { recoveredDraft: true } : {}),
          });
          target.baseVersion = result.version;
          target.acknowledgedValue = result.content;
          target.selection = selectionAfter;
          target.recoveryPending = false;

          if (result.merged) {
            const rebased = mergeText(value, target.latestValue, result.content);
            if (!rebased.clean) {
              setControllerSaveState(target, 'conflict');
              onConflictRef.current(entryId, target.latestValue, {
                version: result.version,
                content: result.content,
              });
              return;
            }
            applySyncedContent(target, rebased.content);
            if (rebased.content !== result.content)
              void set(draftKeyFor(projectId, entryId), rebased.content);
          }

          if (target.latestValue === target.acknowledgedValue) {
            const draftKey = draftKeyFor(projectId, entryId);
            const storedDraft = await get<string>(draftKey);
            if (storedDraft === target.acknowledgedValue) await del(draftKey);
            setControllerSaveState(target, 'saved');
          } else {
            setControllerSaveState(target, 'dirty');
          }
          const model = Monaco.editor.getModel(Monaco.Uri.parse(target.modelPath));
          if (model) lspRef.current?.save(model);
        } catch (error) {
          const conflict = conflictDetails(error);
          if (conflict) {
            setControllerSaveState(target, 'conflict');
            onConflictRef.current(entryId, target.latestValue, conflict);
          } else {
            setControllerSaveState(target, 'offline');
          }
          return;
        }
      }
    })();
    target.saveLoop = run;
    void run.finally(() => {
      if (target.saveLoop === run) target.saveLoop = null;
      if (
        mounted.current &&
        target.latestValue !== target.acknowledgedValue &&
        target.saveState !== 'conflict' &&
        target.saveState !== 'offline'
      )
        setControllerSaveState(target, 'dirty');
    });
    return run;
  }

  useEffect(() => {
    mounted.current = true;
    controllerDisposers.set(projectId, (entryId) => {
      const targets = entryId
        ? [controllers.current.get(entryId)].filter(
            (target): target is FileController => target !== undefined,
          )
        : [...controllers.current.values()];
      for (const target of targets) {
        if (target.timer) clearTimeout(target.timer);
        const model = Monaco.editor.getModel(Monaco.Uri.parse(target.modelPath));
        if (model) lspRef.current?.close(model);
        controllers.current.delete(target.entryId);
      }
    });
    const retry = () => {
      for (const target of controllers.current.values()) void flush(target.entryId);
    };
    const preserve = () => {
      for (const target of controllers.current.values()) {
        if (target.latestValue !== target.acknowledgedValue)
          void set(draftKeyFor(projectId, target.entryId), target.latestValue);
        void flush(target.entryId);
      }
    };
    window.addEventListener('online', retry);
    window.addEventListener('pagehide', preserve);
    return () => {
      window.removeEventListener('online', retry);
      window.removeEventListener('pagehide', preserve);
      preserve();
      for (const target of controllers.current.values()) {
        if (target.timer) clearTimeout(target.timer);
      }
      controllerDisposers.delete(projectId);
      mounted.current = false;
    };
  }, [projectId]);

  useEffect(() => {
    const previousId = activeEntryId.current;
    if (previousId !== entry.id) {
      const previous = controllers.current.get(previousId);
      if (previous) {
        previous.selection = snapshotSelections(editorRef.current?.getSelections());
        const previousModel = Monaco.editor.getModel(Monaco.Uri.parse(previous.modelPath));
        if (previousModel) lspRef.current?.close(previousModel);
        void flush(previousId);
      }
    }
    activeEntryId.current = entry.id;
    const target = controllers.current.get(entry.id)!;
    setSaveState(target.saveState);
    onSaveStateRef.current?.(entry.id, target.saveState);
    void get<string>(draftKeyFor(projectId, entry.id)).then((draft) => {
      if (
        !mounted.current ||
        activeEntryId.current !== entry.id ||
        draft === undefined ||
        draft === target.acknowledgedValue
      )
        return;
      applySyncedContent(target, draft);
      target.recoveryPending = true;
      setControllerSaveState(target, 'dirty');
      if (target.timer) clearTimeout(target.timer);
      target.timer = setTimeout(() => void flush(target.entryId), 750);
    });
    return () => {
      target.selection = snapshotSelections(editorRef.current?.getSelections());
    };
  }, [entry.id, projectId]);

  useEffect(() => {
    const target = controllers.current.get(entry.id)!;
    target.modelPath = modelPath;
    if (!target.saveLoop && target.latestValue === target.acknowledgedValue) {
      target.baseVersion = entry.version;
      target.acknowledgedValue = content;
      applySyncedContent(target, content);
      setControllerSaveState(target, 'saved');
    }
  }, [content, entry.id, entry.version, modelPath]);
  useEffect(() => {
    onRegisterSave?.(() => flush(activeEntryId.current));
  });
  useEffect(() => {
    onRegisterFocus?.(() => editorRef.current?.focus());
  }, [onRegisterFocus]);
  useEffect(() => {
    onRegisterShortcutRunner?.((action) => {
      const definition = shortcutRegistry.find((item) => item.id === action);
      if (!definition || definition.scope !== 'editor' || !definition.command) return;
      if (action === 'editor.undo' || action === 'editor.redo') {
        onHistoryAction?.(action === 'editor.undo' ? 'undo' : 'redo');
        return;
      }
      const editor = editorRef.current;
      if (!editor) return;
      editor.focus();
      const boundary = ['Line editing', 'General editing'].includes(definition.category);
      if (boundary) editor.pushUndoStop();
      runMonacoCommand(editor, definition.id, definition.command, definition.args);
      if (boundary) {
        editor.pushUndoStop();
        window.setTimeout(() => void flush(activeEntryId.current));
      }
    });
  }, [onHistoryAction, onRegisterShortcutRunner]);
  useEffect(() => {
    if (revealLine && editorRef.current) {
      if (navigationSelections?.length)
        editorRef.current.setSelections(
          navigationSelections.map(
            (selection) =>
              new Monaco.Selection(
                selection.startLine,
                selection.startColumn,
                selection.endLine,
                selection.endColumn,
              ),
          ),
        );
      else editorRef.current.setPosition({ lineNumber: revealLine, column: 1 });
      editorRef.current.revealLineInCenter(revealLine);
      editorRef.current.focus();
    }
  }, [navigationSelections, navigationToken, revealLine]);
  useEffect(() => {
    const handle = window.setTimeout(() => {
      const model = editorRef.current?.getModel();
      if (model) {
        lspRef.current?.open(model);
        const selection = controllers.current.get(entry.id)?.selection;
        if (selection?.length)
          editorRef.current?.setSelections(
            selection.map(
              (range) =>
                new Monaco.Selection(
                  range.startLine,
                  range.startColumn,
                  range.endLine,
                  range.endColumn,
                ),
            ),
          );
      }
      const target = controllers.current.get(entry.id);
      for (const stalePath of target?.staleModelPaths.splice(0) ?? []) {
        const staleModel = Monaco.editor.getModel(Monaco.Uri.parse(stalePath));
        if (staleModel) {
          lspRef.current?.close(staleModel);
          staleModel.dispose();
        }
      }
    });
    return () => window.clearTimeout(handle);
  }, [entry.id, modelPath]);

  const mount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    setEditorReady(true);
    registerLatexLanguage(monaco);
    if (import.meta.env.DEV) {
      const missing = shortcutRegistry
        .filter(
          (definition) => definition.command && !CommandsRegistry.getCommand(definition.command),
        )
        .map((definition) => `${definition.id} (${definition.command})`);
      if (missing.length)
        throw new Error(`Unknown Monaco commands in shortcut registry: ${missing.join(', ')}`);
    }
    if (!lspRef.current) {
      lspRef.current = new TexLabClient(monaco, projectId, onLanguageStatus);
      lspRef.current.connect();
    }
    const model = editor.getModel();
    controllers.current.get(entry.id)!.selection = snapshotSelections(editor.getSelections());
    if (model) setTimeout(() => lspRef.current?.open(model), 500);
    editor.onDidPaste(() => window.setTimeout(() => void flush()));
    editor.onDidBlurEditorText(() => void flush());
    editor.onDidChangeCursorPosition(({ position, reason }) => {
      onCursor(position.lineNumber, position.column);
      if (reason === monaco.editor.CursorChangeReason.Explicit) void flush(activeEntryId.current);
    });
  };

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const disposables = shortcutRegistry.flatMap((definition) => {
      const binding = shortcuts[definition.id];
      const keybinding = binding ? monacoKeybinding(Monaco, binding) : null;
      if (!keybinding) return [];
      return [
        editor.addAction({
          id: `latex-workshop.${definition.id}`,
          label: definition.label,
          keybindings: [keybinding],
          run: () => {
            if (definition.scope === 'workspace') onWorkspaceShortcut(definition.id);
            else if (definition.id === 'editor.undo' || definition.id === 'editor.redo')
              onHistoryAction?.(definition.id === 'editor.undo' ? 'undo' : 'redo');
            else if (definition.command) {
              const boundary = ['Line editing', 'General editing'].includes(definition.category);
              if (boundary) editor.pushUndoStop();
              runMonacoCommand(editor, definition.id, definition.command, definition.args);
              if (boundary) {
                editor.pushUndoStop();
                window.setTimeout(() => void flush(activeEntryId.current));
              }
            }
          },
        }),
      ];
    });
    return () => disposables.forEach((disposable) => disposable.dispose());
  }, [editorReady, keymap, onHistoryAction, onWorkspaceShortcut, shortcuts]);

  useEffect(() => {
    if (!editorReady) return;
    const locateSelection = (event: MouseEvent) => {
      const editor = editorRef.current;
      const target = event.target;
      if (!editor || !(target instanceof Node) || !editor.getDomNode()?.contains(target)) return;
      window.setTimeout(() => {
        const model = editor.getModel();
        const selection = editor.getSelection();
        if (!model || !selection) return;
        const line = model.getLineContent(selection.startLineNumber);
        onSourceLocateRef.current?.({
          start: { line: selection.startLineNumber, column: selection.startColumn },
          end: { line: selection.endLineNumber, column: selection.endColumn },
          text: model.getValueInRange(selection),
          before: line.slice(0, selection.startColumn - 1),
          after: line.slice(selection.endColumn - 1),
        });
      });
    };
    document.addEventListener('dblclick', locateSelection, true);
    return () => document.removeEventListener('dblclick', locateSelection, true);
  }, [editorReady]);

  useEffect(() => () => lspRef.current?.dispose(), [projectId]);
  return (
    <div className="editor-container">
      <Editor
        path={modelPath}
        language={languageFor(entry.name)}
        theme="hate-of-nature"
        beforeMount={registerLatexLanguage}
        defaultValue={content}
        onMount={mount}
        onChange={(value = '', event) => {
          if (applyingSyncedContent.current) return;
          const target = controllers.current.get(activeEntryId.current);
          if (!target) return;
          target.latestValue = value;
          onChange(target.entryId, value);
          setControllerSaveState(target, 'dirty');
          void set(draftKeyFor(projectId, target.entryId), value);
          const model = editorRef.current?.getModel();
          if (model) lspRef.current?.change(model);
          if (target.timer) clearTimeout(target.timer);
          const boundary = event.changes.some((change) => change.text.includes('\n'));
          target.timer = setTimeout(() => void flush(target.entryId), boundary ? 0 : 750);
        }}
        keepCurrentModel
        options={{
          automaticLayout: true,
          fontFamily: '"JetBrains Mono", "Fira Code", ui-monospace, monospace',
          fontSize,
          lineHeight: Math.round(fontSize * 1.62),
          minimap: { enabled: !touchLayout },
          wordWrap: 'on',
          tabSize: 2,
          insertSpaces: true,
          smoothScrolling: true,
          cursorSmoothCaretAnimation: 'on',
          bracketPairColorization: { enabled: true },
          guides: { bracketPairs: true, indentation: true },
          stickyScroll: { enabled: !touchLayout },
          renderWhitespace: 'selection',
          scrollBeyondLastLine: false,
          padding: { top: 8, bottom: 8 },
          accessibilitySupport: 'auto',
        }}
      />
      <span className="sr-only" role="status">
        {saveState === 'saved' ? 'Changes saved' : saveState}
      </span>
    </div>
  );
}

function runMonacoCommand(
  editor: Monaco.editor.IStandaloneCodeEditor,
  action: ShortcutActionId,
  command: string,
  args: unknown,
) {
  // Firefox's wrapped Select All command selects Monaco's hidden textarea instead
  // of the text model. Applying the full model range is the public, portable form.
  if (action === 'editor.selectAll') {
    const model = editor.getModel();
    if (model) editor.setSelection(model.getFullModelRange());
    return;
  }
  void editor.trigger('keyboard-shortcut', command, args);
}

function monacoKeybinding(monaco: typeof Monaco, binding: string): number | null {
  const strokes = binding.split(' ');
  if (strokes.length > 2) return null;
  const parse = (stroke: string) => {
    let value = 0;
    let key = 0;
    for (const part of stroke.split('+')) {
      if (part === 'Ctrl') value |= isMacRuntime() ? monaco.KeyMod.WinCtrl : monaco.KeyMod.CtrlCmd;
      else if (part === 'Meta')
        value |= isMacRuntime() ? monaco.KeyMod.CtrlCmd : monaco.KeyMod.WinCtrl;
      else if (part === 'Alt') value |= monaco.KeyMod.Alt;
      else if (part === 'Shift') value |= monaco.KeyMod.Shift;
      else key = monaco.KeyCode[part as keyof typeof monaco.KeyCode] as number;
    }
    return key ? value | key : 0;
  };
  const first = parse(strokes[0]!);
  if (!first) return null;
  if (strokes.length === 1) return first;
  const second = parse(strokes[1]!);
  return second ? monaco.KeyMod.chord(first, second) : null;
}

const isMacRuntime = () => /Mac|iPhone|iPad/.test(navigator.platform);

function conflictDetails(error: unknown): { version: number; content: string } | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as { code?: unknown; details?: unknown };
  if (candidate.code !== 'CONFLICT' || typeof candidate.details !== 'object' || !candidate.details)
    return null;
  const details = candidate.details as { version?: unknown; content?: unknown };
  return typeof details.version === 'number' &&
    Number.isInteger(details.version) &&
    typeof details.content === 'string'
    ? { version: details.version, content: details.content }
    : null;
}

function snapshotSelections(
  selections: Monaco.Selection[] | null | undefined,
): EditorSelectionSnapshot | null {
  return selections?.length
    ? selections.map((selection) => ({
        startLine: selection.startLineNumber,
        startColumn: selection.startColumn,
        endLine: selection.endLineNumber,
        endColumn: selection.endColumn,
      }))
    : null;
}

const draftKeyFor = (projectId: string, entryId: string) => `draft:${projectId}:${entryId}`;
