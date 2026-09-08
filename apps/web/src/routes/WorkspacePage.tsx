import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { DiffEditor } from '@monaco-editor/react';
import { del, get, set } from 'idb-keyval';
import {
  ArrowLeft,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleStop,
  Code2,
  Command,
  Copy,
  File,
  FileImage,
  FilePlus2,
  FileSearch,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  History,
  LoaderCircle,
  PanelBottomClose,
  PanelBottomOpen,
  Pencil,
  Play,
  Target,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type {
  Checkpoint,
  CompileJob,
  Diagnostic,
  EditHistoryNode,
  EditHistoryResponse,
  EditorSelectionSnapshot,
  PdfSyncResult,
  Project,
  ProjectEntry,
  ShortcutActionId,
  SourceSelection,
  AgentProposalChange,
} from '@latex-workshop/contracts';
import { shortcutRegistry } from '@latex-workshop/contracts';
import { Button, IconButton } from '../components/Button';
import { AppearanceMenu } from '../components/AppearanceMenu';
import { Dialog } from '../components/Dialog';
import { Toast, type ToastState } from '../components/Toast';
import { AccountSettingsDialog } from './AccountPage';
import {
  disposeEditorEntry,
  disposeProjectEditors,
  EditorPane,
  type EditorViewportSnapshot,
  type SaveMetadata,
  type SaveState,
} from '../features/editor/EditorPane';
import type { TexLabStatus } from '../features/editor/lspClient';
import { PdfViewer } from '../features/pdf/PdfViewer';
import { currentPdfSyncResult, type CompilationPdfSyncResult } from '../features/pdf/pdfSyncState';
import {
  autoCompileTargetKey,
  decideAutoCompile,
  selectAutoCompileTarget,
  type AutoCompileTarget,
} from '../features/compile/autoCompileState';
import { ProposalEditorDock } from '../features/agent-proposals/ProposalEditorDock';
import { ProjectSearchDialog } from '../features/search/ProjectSearchDialog';
import type { ProjectSearchResult, ProjectSearchSource } from '../features/search/projectSearch';
import { useAgentProposal } from '../features/agent-proposals/useAgentProposal';
import { canDiscardDraftChange } from '../features/agent-proposals/proposalActiveState';
import {
  ProjectSettingsControl,
  type ProjectSettingsControlHandle,
} from '../features/settings/ProjectSettingsControl';
import { api, appPath, queryKeys } from '../lib/api';
import { authClient } from '../lib/auth';
import { prefersTouchWorkspace, TOUCH_WORKSPACE_MEDIA } from '../lib/layout';
import { projectDocumentTitle } from '../lib/document-title';
import { classNames, formatRelative, isTextFile } from '../lib/utils';
import { useAppearance } from '../lib/appearance';
import {
  displayShortcut,
  resolvedShortcuts,
  shortcutStrokeCandidatesFromEvent,
  useKeyboardShortcuts,
} from '../lib/keyboardShortcuts';

type CompileWithArtifact = CompileJob & {
  pdfObjectKey?: string | null;
  synctexObjectKey?: string | null;
};
type ProjectPayload = {
  project: Project;
  entries: ProjectEntry[];
  latestCompile: CompileWithArtifact | null;
};
type FileContent = { content: string; version: number };
type HistoryOutboxMutation = {
  content: string;
  clientMutationId: string;
  baseVersion: number;
  expectedHeadId: string | null;
  metadata: SaveMetadata;
  queuedAt?: number;
};
const historyCommitsEnabled = import.meta.env.VITE_EDIT_HISTORY_COMMITS !== 'false';
const AUTO_COMPILE_IDLE_MS = 2_500;

export default function WorkspacePage() {
  const { projectId } = useParams({ from: '/projects/$projectId' });
  const initialPreferences = useRef(readWorkspacePreferences(projectId));
  const { preferences: appearance } = useAppearance();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: session, isPending: sessionPending } = authClient.useSession();
  const shortcutQuery = useKeyboardShortcuts(session?.user?.id);
  const shortcuts = useMemo(() => {
    const keymap = shortcutQuery.data?.keymap ?? 'linux';
    return resolvedShortcuts(shortcutQuery.data?.overrides[keymap], keymap);
  }, [shortcutQuery.data?.keymap, shortcutQuery.data?.overrides]);
  const projectQuery = useQuery({
    queryKey: queryKeys.project(projectId),
    queryFn: () => api<ProjectPayload>(`/api/v1/projects/${projectId}`),
    enabled: Boolean(session?.user),
  });
  const compileQuery = useQuery({
    queryKey: queryKeys.compiles(projectId),
    queryFn: () =>
      api<{ jobs: CompileWithArtifact[] }>(`/api/v1/projects/${projectId}/compilations`),
    enabled: Boolean(session?.user),
    refetchInterval: 10_000,
  });
  const [previewTarget, setPreviewTarget] = useState<'accepted' | 'proposal'>('proposal');
  const [autoCompileOverride, setAutoCompileOverride] = useState<boolean | null>(null);
  const [openTabs, setOpenTabs] = useState<string[]>(initialPreferences.current.openTabs);
  const [selectedId, setSelectedId] = useState<string | null>(
    initialPreferences.current.selectedId,
  );
  const [contents, setContents] = useState<Record<string, FileContent>>({});
  const [activeEditorId, setActiveEditorId] = useState<string | null>(null);
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [lspStatus, setLspStatus] = useState<TexLabStatus>('connecting');
  const [problemsOpen, setProblemsOpen] = useState(initialPreferences.current.problemsOpen);
  const [bottomTab, setBottomTab] = useState<'problems' | 'logs'>('problems');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [editHistoryOpen, setEditHistoryOpen] = useState(false);
  const [editHistories, setEditHistories] = useState<Record<string, EditHistoryResponse>>({});
  const projectSettingsRef = useRef<ProjectSettingsControlHandle>(null);
  const [accountSettings, setAccountSettings] = useState<'account' | 'keyboard-shortcuts' | null>(
    null,
  );
  const [conflictState, setConflictState] = useState<{
    entryId: string;
    local: string;
    server: FileContent;
  } | null>(null);
  const [forward, setForward] = useState<CompilationPdfSyncResult | null>(null);
  const [pdfPageHint, setPdfPageHint] = useState<number | null>(null);
  const [saveStates, setSaveStates] = useState<Record<string, SaveState>>({});
  const [navigation, setNavigation] = useState<{
    line: number;
    token: number;
    selections?: EditorSelectionSnapshot;
  } | null>(null);
  const [viewportRestore, setViewportRestore] = useState<{
    snapshot: EditorViewportSnapshot;
    token: number;
  } | null>(null);
  const [mobilePanel, setMobilePanel] = useState<'files' | 'editor' | 'preview'>(
    initialPreferences.current.mobilePanel,
  );
  const [filesVisible, setFilesVisible] = useState(initialPreferences.current.filesVisible);
  const [previewVisible, setPreviewVisible] = useState(initialPreferences.current.previewVisible);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');
  const [projectSearchOpen, setProjectSearchOpen] = useState(false);
  const [projectSearchQuery, setProjectSearchQuery] = useState('');
  const [projectSearchSources, setProjectSearchSources] = useState<ProjectSearchSource[]>([]);
  const [projectSearchLoading, setProjectSearchLoading] = useState(false);
  const [projectSearchFailedFiles, setProjectSearchFailedFiles] = useState(0);
  const [treeWidth, setTreeWidth] = useState(initialPreferences.current.treeWidth);
  const [editorWidth, setEditorWidth] = useState(initialPreferences.current.editorWidth);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [entryDialog, setEntryDialog] = useState<{
    mode: 'create-file' | 'create-folder' | 'rename' | 'delete' | 'move';
    entryId?: string;
    value: string;
    parentId: string | null;
  } | null>(null);
  const [entryDialogError, setEntryDialogError] = useState<string | null>(null);
  const [entryDialogPending, setEntryDialogPending] = useState(false);
  const [touchLayout, setTouchLayout] = useState(() => prefersTouchWorkspace());
  const [proposalOpenPath, setProposalOpenPath] = useState<string | null>(null);
  const saveCurrentRef = useRef<(() => Promise<void>) | null>(null);
  const focusEditorRef = useRef<(() => void) | null>(null);
  const captureViewportRef = useRef<(() => EditorViewportSnapshot | null) | null>(null);
  const pendingViewportRef = useRef<EditorViewportSnapshot | null>(null);
  const editorShortcutRef = useRef<((action: ShortcutActionId) => void) | null>(null);
  const pendingChordRef = useRef<{ sequences: string[]; timer: number } | null>(null);
  const projectSearchRequestRef = useRef(0);
  const uploadRef = useRef<HTMLInputElement>(null);
  const autoCompileTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoCompileTarget = useRef<AutoCompileTarget | null>(null);
  const autoCompileActivityAt = useRef(0);
  const autoCompileAttempted = useRef<string | null>(null);
  const autoCompileRequestPending = useRef(false);
  const manualCompile = useRef(false);
  const syncRequestRef = useRef<{ id: number; controller: AbortController } | null>(null);
  const editHistoriesRef = useRef<Record<string, EditHistoryResponse>>({});

  useEffect(() => {
    if (!sessionPending && !session?.user) void navigate({ to: '/auth' });
  }, [session, sessionPending, navigate]);
  useEffect(() => {
    const media = window.matchMedia(TOUCH_WORKSPACE_MEDIA);
    const update = () => setTouchLayout(prefersTouchWorkspace());
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(
    () => () => {
      if (autoCompileTimer.current) clearTimeout(autoCompileTimer.current);
      syncRequestRef.current?.controller.abort();
      disposeProjectEditors(projectId);
    },
    [projectId],
  );
  const payload = projectQuery.data;
  const autoCompileEnabled = autoCompileOverride ?? payload?.project.autoCompile ?? false;
  const entries = payload?.entries ?? [];
  const paths = useMemo(() => buildPaths(entries), [entries]);
  const selected = entries.find((entry) => entry.id === selectedId) ?? null;
  const selectedPath = selected ? (paths.get(selected.id) ?? null) : proposalOpenPath;
  const selectedTextContent =
    selected?.kind === 'file' && isTextFile(selected.name, selected.mimeType)
      ? contents[selected.id]
      : undefined;
  useEffect(() => {
    if (selectedTextContent && selected) setActiveEditorId(selected.id);
  }, [selected, selectedTextContent]);
  const agentProposal = useAgentProposal({
    projectId,
    openPath: selectedPath,
    saveState: selectedId ? saveStates[selectedId] : undefined,
    flushEditor: () => saveCurrentRef.current?.() ?? Promise.resolve(),
    onAcceptedHeadChanged: async () => {
      const preservedPath = selectedPath;
      pendingViewportRef.current = captureViewportRef.current?.() ?? null;
      disposeProjectEditors(projectId);
      setContents({});
      editHistoriesRef.current = {};
      setEditHistories({});
      const refreshedPayload = (await projectQuery.refetch()).data;
      const refreshedEntries = refreshedPayload?.entries ?? [];
      const refreshedPaths = buildPaths(refreshedEntries);
      const selectedEntry =
        refreshedEntries.find((entry) => refreshedPaths.get(entry.id) === preservedPath) ??
        refreshedEntries.find((entry) => entry.id === selectedId);
      if (
        selectedEntry?.kind === 'file' &&
        isTextFile(selectedEntry.name, selectedEntry.mimeType)
      ) {
        try {
          const data = await api<FileContent & { hash: string }>(
            `/api/v1/projects/${projectId}/entries/${selectedEntry.id}/content`,
          );
          setContents({
            [selectedEntry.id]: { content: data.content, version: data.version },
          });
          setSelectedId(selectedEntry.id);
          setActiveEditorId(selectedEntry.id);
          setProposalOpenPath(refreshedPaths.get(selectedEntry.id) ?? null);
          setOpenTabs((tabs) => [
            ...tabs.filter(
              (id) =>
                id !== activeEditorId && id !== selectedEntry.id && !id.startsWith('proposal:'),
            ),
            selectedEntry.id,
          ]);
          const pendingViewport = pendingViewportRef.current;
          if (pendingViewport)
            setViewportRestore((current) => ({
              snapshot: pendingViewport,
              token: (current?.token ?? 0) + 1,
            }));
          await loadEditHistory(selectedEntry.id, true);
        } catch {
          setSelectedId(null);
        }
      }
      pendingViewportRef.current = null;
    },
  });
  const activeProposal = agentProposal.proposal;
  const acceptedCompile =
    compileQuery.data?.jobs.find(
      (job) => job.status === 'succeeded' && job.target === 'accepted',
    ) ??
    (payload?.latestCompile?.status === 'succeeded' && payload.latestCompile.target === 'accepted'
      ? payload.latestCompile
      : null);
  const proposalCompile = activeProposal
    ? (compileQuery.data?.jobs.find(
        (job) =>
          job.status === 'succeeded' &&
          job.target === 'proposal' &&
          job.proposalId === activeProposal.id,
      ) ?? null)
    : null;
  const latestProposalCompile = activeProposal
    ? (compileQuery.data?.jobs.find(
        (job) => job.target === 'proposal' && job.proposalId === activeProposal.id,
      ) ?? null)
    : null;
  const successfulCompile =
    previewTarget === 'proposal' && activeProposal
      ? (proposalCompile ?? acceptedCompile)
      : acceptedCompile;
  const activeCompile =
    compileQuery.data?.jobs.find((job) => job.status === 'queued' || job.status === 'running') ??
    null;
  const latestCompile = compileQuery.data?.jobs[0] ?? payload?.latestCompile ?? null;

  useEffect(() => {
    if (!payload) return;
    const mode = touchLayout
      ? mobilePanel === 'preview'
        ? 'pdf'
        : 'editor'
      : previewVisible
        ? 'combined'
        : 'editor';
    document.title = projectDocumentTitle(payload.project.name, mode);
    return () => {
      document.title = 'LaTeX Workshop';
    };
  }, [mobilePanel, payload, previewVisible, touchLayout]);

  useEffect(() => {
    if (!payload) return;
    void api(`/api/v1/library/projects/${payload.project.id}/opened`, { method: 'POST' }).then(
      () => queryClient.invalidateQueries({ queryKey: ['library'] }),
      () => undefined,
    );
  }, [payload?.project.id, queryClient]);

  useEffect(() => {
    if (!payload) return;
    const initial =
      entries.find((entry) => entry.id === selectedId) ??
      entries.find((entry) => entry.id === payload.project.mainFileId) ??
      entries.find((entry) => entry.kind === 'file');
    if (initial) void openEntry(initial);
  }, [payload?.project.id]);

  useEffect(() => {
    if (!payload) return;
    const validFiles = new Set(
      entries.filter((entry) => entry.kind === 'file').map(({ id }) => id),
    );
    for (const file of agentProposal.virtualFiles) validFiles.add(`proposal:${file.changeId}`);
    setOpenTabs((tabs) => tabs.filter((id) => validFiles.has(id)));
    if (selectedId && !validFiles.has(selectedId)) setSelectedId(null);
  }, [agentProposal.virtualFiles, entries, payload, selectedId]);

  useEffect(() => {
    localStorage.setItem(
      `workspace:${projectId}`,
      JSON.stringify({
        openTabs,
        selectedId,
        problemsOpen,
        mobilePanel,
        filesVisible,
        previewVisible,
        treeWidth,
        editorWidth,
      }),
    );
  }, [
    projectId,
    openTabs,
    selectedId,
    problemsOpen,
    mobilePanel,
    filesVisible,
    previewVisible,
    treeWidth,
    editorWidth,
  ]);

  useEffect(() => {
    if (!session?.user) return;
    const source = new EventSource(appPath(`/api/v1/projects/${projectId}/compile-events`), {
      withCredentials: true,
    });
    source.addEventListener('compile', (event) => {
      const data = JSON.parse((event as MessageEvent).data) as {
        type: string;
        job?: CompileWithArtifact;
      };
      if (data.type === 'status') {
        void queryClient.invalidateQueries({ queryKey: queryKeys.compiles(projectId) });
        if (data.job && ['succeeded', 'failed', 'cancelled'].includes(data.job.status))
          armAutoCompile();
        if (data.job?.status === 'succeeded')
          setToast({ id: Date.now(), tone: 'success', message: 'PDF compiled successfully' });
        if (data.job?.status === 'failed')
          setToast({ id: Date.now(), tone: 'error', message: 'Compilation failed — see Problems' });
      }
    });
    return () => source.close();
  }, [projectId, session, queryClient]);

  useEffect(() => {
    const cancelChord = () => {
      if (pendingChordRef.current) window.clearTimeout(pendingChordRef.current.timer);
      pendingChordRef.current = null;
    };
    const shortcut = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && pendingChordRef.current) {
        event.preventDefault();
        cancelChord();
        return;
      }
      if (event.isComposing) return;
      const target = event.target as HTMLElement | null;
      const inEditor = Boolean(target?.closest('.monaco-editor'));
      if (inEditor) return;
      if (!inEditor && target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (document.querySelector('[role="dialog"]')) return;
      const strokes = shortcutStrokeCandidatesFromEvent(event);
      if (!strokes.length) return;
      const sequences = pendingChordRef.current
        ? pendingChordRef.current.sequences.flatMap((prefix) =>
            strokes.map((stroke) => `${prefix} ${stroke}`),
          )
        : strokes;
      cancelChord();
      const exact = shortcutRegistry.find(
        (item) => shortcuts[item.id] && sequences.includes(shortcuts[item.id]!),
      );
      if (exact) {
        if (exact.scope === 'editor' && !inEditor) return;
        event.preventDefault();
        event.stopPropagation();
        if (
          event.repeat &&
          (exact.scope === 'workspace' || !['Navigation', 'Selection'].includes(exact.category))
        )
          return;
        runShortcut(exact.id);
        return;
      }
      const prefixes = sequences.filter((sequence) =>
        shortcutRegistry.some((item) => shortcuts[item.id]?.startsWith(`${sequence} `)),
      );
      if (prefixes.length) {
        event.preventDefault();
        event.stopPropagation();
        pendingChordRef.current = {
          sequences: prefixes,
          timer: window.setTimeout(cancelChord, 1_500),
        };
        return;
      }
    };
    window.addEventListener('keydown', shortcut, true);
    window.addEventListener('blur', cancelChord);
    return () => {
      window.removeEventListener('keydown', shortcut, true);
      window.removeEventListener('blur', cancelChord);
      cancelChord();
    };
  });

  function switchTab(direction: number) {
    if (!openTabs.length) return;
    const current = openTabs.indexOf(selectedId ?? '');
    const nextId = openTabs[(current + direction + openTabs.length) % openTabs.length];
    const next = entries.find((entry) => entry.id === nextId);
    if (next) void openEntry(next);
    else {
      const virtual = agentProposal.virtualFiles.find(
        (file) => `proposal:${file.changeId}` === nextId,
      );
      if (virtual) openProposalPath(virtual.path);
    }
  }

  function closeTab(id: string) {
    setOpenTabs((tabs) => {
      const index = tabs.indexOf(id);
      const nextTabs = tabs.filter((tab) => tab !== id);
      if (selectedId === id) {
        const adjacent = nextTabs[Math.min(Math.max(index, 0), nextTabs.length - 1)] ?? null;
        setSelectedId(adjacent);
        const entry = entries.find((item) => item.id === adjacent);
        if (entry) void openEntry(entry);
        else {
          const virtual = agentProposal.virtualFiles.find(
            (file) => `proposal:${file.changeId}` === adjacent,
          );
          if (virtual) openProposalPath(virtual.path);
          else setProposalOpenPath(null);
        }
      }
      return nextTabs;
    });
  }

  function runShortcut(action: ShortcutActionId) {
    const definition = shortcutRegistry.find((item) => item.id === action);
    if (definition?.scope === 'editor') return editorShortcutRef.current?.(action);
    switch (action) {
      case 'workspace.compile':
        requestManualCompile();
        break;
      case 'workspace.save':
        requestManualCompile();
        break;
      case 'workspace.commandPalette':
        setPaletteQuery('');
        setPaletteOpen(true);
        break;
      case 'workspace.projectSearch':
        void openProjectSearch();
        break;
      case 'workspace.keyboardShortcuts':
        setAccountSettings('keyboard-shortcuts');
        break;
      case 'workspace.history':
        setHistoryOpen(true);
        break;
      case 'workspace.problems':
        setProblemsOpen((value) => !value);
        break;
      case 'workspace.files':
        setFilesVisible((value) => !value);
        break;
      case 'workspace.focusFiles':
        setMobilePanel('files');
        document.querySelector<HTMLElement>('.file-tree [role="treeitem"]')?.focus();
        break;
      case 'workspace.focusEditor':
        setMobilePanel('editor');
        focusEditorRef.current?.();
        break;
      case 'workspace.focusPreview':
        setMobilePanel('preview');
        document.querySelector<HTMLElement>('.pdf-container')?.focus();
        break;
      case 'workspace.previousTab':
        switchTab(-1);
        break;
      case 'workspace.nextTab':
        switchTab(1);
        break;
      case 'workspace.togglePreview':
        setPreviewVisible((value) => !value);
        break;
      case 'workspace.closeTab':
        if (selectedId) closeTab(selectedId);
        break;
      case 'workspace.forwardSearch':
        void forwardSearch();
        break;
      case 'workspace.projectSettings':
        projectSettingsRef.current?.open();
        break;
      case 'workspace.createFile':
        void createEntry('file');
        break;
      case 'workspace.createFolder':
        void createEntry('folder');
        break;
    }
  }

  function openProposalPath(path: string) {
    const entry = entries.find((item) => paths.get(item.id) === path);
    if (entry) {
      void openEntry(entry);
      return;
    }
    const virtual = agentProposal.virtualFiles.find((file) => file.path === path);
    if (!virtual) return;
    const id = `proposal:${virtual.changeId}`;
    setSelectedId(id);
    setProposalOpenPath(path);
    setActiveEditorId(id);
    setOpenTabs((tabs) => (tabs.includes(id) ? tabs : [...tabs, id]));
    setContents((value) => (value[id] ? value : { ...value, [id]: { content: '', version: 0 } }));
  }

  async function openEntry(entry: ProjectEntry) {
    setSelectedId(entry.id);
    setProposalOpenPath(paths.get(entry.id) ?? null);
    if (entry.kind !== 'file') return;
    setOpenTabs((tabs) => (tabs.includes(entry.id) ? tabs : [...tabs, entry.id]));
    if (!isTextFile(entry.name, entry.mimeType)) return;
    void loadEditHistory(entry.id);
    if (contents[entry.id]) return;
    try {
      const data = await api<FileContent & { hash: string }>(
        `/api/v1/projects/${projectId}/entries/${entry.id}/content`,
      );
      setContents((value) => ({
        ...value,
        [entry.id]: { content: data.content, version: data.version },
      }));
    } catch (error) {
      setToast({
        id: Date.now(),
        tone: 'error',
        message: error instanceof Error ? error.message : 'Unable to open file',
      });
    }
  }

  async function openProjectSearch() {
    const requestId = ++projectSearchRequestRef.current;
    setProjectSearchQuery('');
    setProjectSearchOpen(true);
    setProjectSearchLoading(true);
    setProjectSearchFailedFiles(0);
    const sourceEntries = entries.filter(
      (entry) => entry.kind === 'file' && isTextFile(entry.name, entry.mimeType),
    );
    const loaded: ProjectSearchSource[] = [];
    let failed = 0;
    const queue = [...sourceEntries];
    const workers = Array.from({ length: Math.min(6, queue.length) }, async () => {
      while (queue.length) {
        const entry = queue.shift();
        if (!entry) return;
        try {
          const cached = contents[entry.id];
          const data =
            cached ??
            (await api<FileContent & { hash: string }>(
              `/api/v1/projects/${projectId}/entries/${entry.id}/content`,
            ));
          loaded.push({
            entryId: entry.id,
            path: paths.get(entry.id) ?? entry.name,
            content: data.content,
          });
        } catch {
          failed += 1;
        }
      }
    });
    await Promise.all(workers);
    if (projectSearchRequestRef.current !== requestId) return;
    const order = new Map(sourceEntries.map((entry, index) => [entry.id, index]));
    loaded.sort(
      (left, right) =>
        (order.get(left.entryId) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(right.entryId) ?? Number.MAX_SAFE_INTEGER),
    );
    setProjectSearchSources(loaded);
    setProjectSearchFailedFiles(failed);
    setProjectSearchLoading(false);
  }

  async function openProjectSearchResult(result: ProjectSearchResult) {
    const entry = entries.find((item) => item.id === result.entryId);
    if (!entry) return;
    setProjectSearchOpen(false);
    setMobilePanel('editor');
    await openEntry(entry);
    setNavigation((current) => ({
      line: result.line,
      token: (current?.token ?? 0) + 1,
      selections: [
        {
          startLine: result.line,
          startColumn: result.column,
          endLine: result.line,
          endColumn: result.endColumn,
        },
      ],
    }));
  }

  function updateEditHistory(entryId: string, history: EditHistoryResponse) {
    editHistoriesRef.current = { ...editHistoriesRef.current, [entryId]: history };
    setEditHistories(editHistoriesRef.current);
  }

  async function loadEditHistory(entryId: string, force = false) {
    if (!force && editHistoriesRef.current[entryId]) return editHistoriesRef.current[entryId];
    const history = await api<EditHistoryResponse>(
      `/api/v1/projects/${projectId}/entries/${entryId}/edit-history`,
    );
    updateEditHistory(entryId, history);
    return history;
  }

  async function loadMoreEditHistory(entryId: string) {
    const current = editHistoriesRef.current[entryId];
    if (!current?.nextCursor) return;
    const page = await api<EditHistoryResponse>(
      `/api/v1/projects/${projectId}/entries/${entryId}/edit-history?cursor=${current.nextCursor}`,
    );
    const known = new Set(current.nodes.map((node) => node.id));
    const merged = {
      ...current,
      nodes: [...current.nodes, ...page.nodes.filter((node) => !known.has(node.id))],
      nextCursor: page.nextCursor,
    };
    updateEditHistory(entryId, merged);
  }

  async function saveFile(
    entryId: string,
    value: string,
    baseVersion: number,
    metadata: SaveMetadata,
  ) {
    if (entryId.startsWith('proposal:')) {
      return { version: 0, content: value, merged: false, unchanged: true };
    }
    if (!historyCommitsEnabled) {
      const result = await api<{
        entry: ProjectEntry;
        content: string;
        merged: boolean;
        unchanged: boolean;
      }>(`/api/v1/projects/${projectId}/entries/${entryId}/content`, {
        method: 'PUT',
        body: JSON.stringify({ baseVersion, content: value }),
      });
      setContents((state) => ({
        ...state,
        [entryId]: { content: state[entryId]?.content ?? value, version: result.entry.version },
      }));
      queryClient.setQueryData<ProjectPayload>(queryKeys.project(projectId), (old) =>
        old
          ? {
              ...old,
              project: {
                ...old.project,
                sourceRevision: old.project.sourceRevision + (result.unchanged ? 0 : 1),
                updatedAt: new Date().toISOString(),
              },
              entries: old.entries.map((item) =>
                item.id === entryId ? { ...item, version: result.entry.version } : item,
              ),
            }
          : old,
      );
      if (autoCompileEnabled && !result.unchanged && !manualCompile.current)
        noteAutoCompileActivity({
          target: 'accepted',
          revision: (payload?.project.sourceRevision ?? 0) + 1,
        });
      return {
        version: result.entry.version,
        content: result.content,
        merged: result.merged,
        unchanged: result.unchanged,
      };
    }
    const outboxKey = `edit-history-outbox:${projectId}:${entryId}`;
    const stored = await get<HistoryOutboxMutation | HistoryOutboxMutation[]>(outboxKey);
    const queue = Array.isArray(stored) ? stored : stored ? [stored] : [];
    const last = queue.at(-1);
    if (last?.content !== value)
      queue.push({
        content: value,
        clientMutationId: crypto.randomUUID(),
        baseVersion,
        expectedHeadId: editHistoriesRef.current[entryId]?.currentNodeId ?? null,
        metadata,
        queuedAt: Date.now(),
      });
    await set(outboxKey, queue);

    let history = editHistoriesRef.current[entryId] ?? (await loadEditHistory(entryId));
    let finalResult:
      | { node: EditHistoryNode; content: string; merged: boolean; version: number }
      | undefined;
    let changedCommits = 0;
    while (queue.length) {
      const mutation = queue[0]!;
      mutation.baseVersion = history.version;
      mutation.expectedHeadId = history.currentNodeId;
      await set(outboxKey, queue);
      const result = await api<{
        node: EditHistoryNode;
        content: string;
        merged: boolean;
        version: number;
      }>(`/api/v1/projects/${projectId}/entries/${entryId}/edit-history/commit`, {
        method: 'POST',
        headers: mutation.queuedAt
          ? { 'x-editor-outbox-age-ms': String(Math.max(0, Date.now() - mutation.queuedAt)) }
          : {},
        body: JSON.stringify({
          baseVersion: mutation.baseVersion,
          expectedHeadId: mutation.expectedHeadId,
          clientMutationId: mutation.clientMutationId,
          content: mutation.content,
          summary: mutation.metadata.recoveredDraft
            ? 'Recovered offline draft'
            : summarizeEdit(history.content, mutation.content),
          selectionBefore: mutation.metadata.selectionBefore,
          selectionAfter: mutation.metadata.selectionAfter,
        }),
      });
      const unchanged =
        result.node.id === history.currentNodeId && result.content === history.content;
      if (!unchanged) changedCommits += 1;
      const nodes = history.nodes
        .map((node) => ({
          ...node,
          current: false,
          preferredChildId:
            node.id === result.node.parentId ? result.node.id : node.preferredChildId,
        }))
        .filter((node) => node.id !== result.node.id);
      history = {
        nodes: [{ ...result.node, current: true }, ...nodes],
        currentNodeId: result.node.id,
        content: result.content,
        version: result.version,
        nextCursor: history.nextCursor,
      };
      updateEditHistory(entryId, history);
      finalResult = result;
      queue.shift();
      if (queue.length) await set(outboxKey, queue);
      else await del(outboxKey);
    }
    if (!finalResult) throw new Error('No pending edit was available to save');
    setContents((state) => ({
      ...state,
      [entryId]: {
        content: state[entryId]?.content ?? value,
        version: finalResult.version,
      },
    }));
    queryClient.setQueryData<ProjectPayload>(queryKeys.project(projectId), (old) =>
      old
        ? {
            ...old,
            project: {
              ...old.project,
              sourceRevision: old.project.sourceRevision + changedCommits,
              updatedAt: new Date().toISOString(),
            },
            entries: old.entries.map((entry) =>
              entry.id === entryId ? { ...entry, version: finalResult.version } : entry,
            ),
          }
        : old,
    );
    if (autoCompileEnabled && changedCommits > 0 && !manualCompile.current)
      noteAutoCompileActivity({
        target: 'accepted',
        revision: (payload?.project.sourceRevision ?? 0) + changedCommits,
      });
    return {
      version: finalResult.version,
      content: finalResult.content,
      merged: finalResult.merged,
      unchanged: changedCommits === 0,
    };
  }

  async function checkoutEditHistory(targetNodeId: string) {
    if (!selected || selected.kind !== 'file') return;
    await saveCurrentRef.current?.();
    const history = await loadEditHistory(selected.id, true);
    if (targetNodeId === history.currentNodeId) return;
    try {
      const result = await api<{
        node: EditHistoryNode;
        content: string;
        version: number;
        merged: boolean;
      }>(`/api/v1/projects/${projectId}/entries/${selected.id}/edit-history/checkout`, {
        method: 'POST',
        body: JSON.stringify({
          baseVersion: history.version,
          expectedHeadId: history.currentNodeId,
          targetNodeId,
        }),
      });
      setContents((state) => ({
        ...state,
        [selected.id]: { content: result.content, version: result.version },
      }));
      await del(`draft:${projectId}:${selected.id}`);
      const refreshed = await loadEditHistory(selected.id, true);
      const selection = result.node.selectionAfter;
      const primarySelection = selection?.at(-1);
      if (primarySelection)
        setNavigation((old) => ({
          line: primarySelection.endLine,
          token: (old?.token ?? 0) + 1,
          ...(selection ? { selections: selection } : {}),
        }));
      updateEditHistory(selected.id, refreshed);
    } catch (error) {
      setToast({
        id: Date.now(),
        tone: 'error',
        message: error instanceof Error ? error.message : 'Unable to navigate edit history',
      });
    }
  }

  async function navigateEditHistory(direction: 'undo' | 'redo') {
    if (!selected || selected.kind !== 'file') return;
    await saveCurrentRef.current?.();
    const history = await loadEditHistory(selected.id, true);
    const current = history.nodes.find((node) => node.id === history.currentNodeId);
    const targetId = direction === 'undo' ? current?.parentId : current?.preferredChildId;
    if (targetId) await checkoutEditHistory(targetId);
  }

  const compile = useMutation({
    mutationFn: async ({
      trigger,
      target,
    }: {
      trigger: 'manual' | 'auto';
      target: AutoCompileTarget;
    }) => {
      if (trigger === 'manual') {
        if (autoCompileTimer.current) clearTimeout(autoCompileTimer.current);
        autoCompileTarget.current = null;
        manualCompile.current = true;
        try {
          if (target.target === 'proposal') await agentProposal.flushPending();
          else await saveCurrentRef.current?.();
        } finally {
          manualCompile.current = false;
        }
      }
      if (target.target === 'proposal') {
        const cached = queryClient.getQueryData<{ proposal: typeof activeProposal }>(
          queryKeys.agentProposal(projectId),
        )?.proposal;
        if (!cached || cached.id !== target.proposalId)
          throw new Error('Proposal is no longer active');
        return api<{ proposal: typeof cached }>(
          `/api/v1/projects/${projectId}/proposals/${cached.id}/compile`,
          {
            method: 'POST',
            body: JSON.stringify({
              expectedProposalRevision: cached.revision,
              idempotencyKey: crypto.randomUUID(),
            }),
          },
        ).then(() => ({ job: null }));
      }
      return api<{ job: CompileWithArtifact }>(`/api/v1/projects/${projectId}/compilations`, {
        method: 'POST',
        body: JSON.stringify({ trigger }),
      });
    },
    onSuccess: (data, variables) => {
      if (variables.trigger === 'auto') {
        const requestedKey = autoCompileTargetKey(variables.target);
        const covered =
          variables.target.target === 'proposal' ||
          (data.job?.target === 'accepted' && data.job.sourceRevision >= variables.target.revision);
        if (covered) {
          autoCompileAttempted.current = requestedKey;
        }
        if (
          covered &&
          autoCompileTarget.current &&
          requestedKey === autoCompileTargetKey(autoCompileTarget.current)
        )
          autoCompileTarget.current = null;
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.compiles(projectId) });
    },
    onError: (error, variables) => {
      if (variables.trigger === 'auto') {
        autoCompileAttempted.current = autoCompileTargetKey(variables.target);
        autoCompileTarget.current = null;
      }
      setToast({ id: Date.now(), tone: 'error', message: error.message });
    },
    onSettled: () => {
      autoCompileRequestPending.current = false;
    },
  });

  function currentCompileTarget(): AutoCompileTarget {
    if (previewTarget === 'proposal' && activeProposal)
      return {
        target: 'proposal',
        proposalId: activeProposal.id,
        revision: activeProposal.revision,
      };
    return { target: 'accepted', revision: payload?.project.sourceRevision ?? 0 };
  }

  function requestManualCompile() {
    compile.mutate({ trigger: 'manual', target: currentCompileTarget() });
  }

  async function setAutoCompile(enabled: boolean) {
    const previous = autoCompileEnabled;
    setAutoCompileOverride(enabled);
    queryClient.setQueryData<ProjectPayload>(queryKeys.project(projectId), (current) =>
      current ? { ...current, project: { ...current.project, autoCompile: enabled } } : current,
    );
    try {
      await updateProject(projectId, { autoCompile: enabled }, queryClient);
      setAutoCompileOverride(null);
    } catch (cause) {
      queryClient.setQueryData<ProjectPayload>(queryKeys.project(projectId), (current) =>
        current ? { ...current, project: { ...current.project, autoCompile: previous } } : current,
      );
      setAutoCompileOverride(null);
      setToast({
        id: Date.now(),
        tone: 'error',
        message: cause instanceof Error ? cause.message : 'Unable to update Auto compile',
      });
    }
  }

  function noteAutoCompileActivity(target = autoCompileTarget.current) {
    if (!autoCompileEnabled || !target) return;
    const previous = autoCompileTarget.current;
    if (!previous || autoCompileTargetKey(previous) !== autoCompileTargetKey(target))
      autoCompileAttempted.current = null;
    autoCompileTarget.current = target;
    autoCompileActivityAt.current = Date.now();
    armAutoCompile();
  }

  function armAutoCompile(minimumDelay = AUTO_COMPILE_IDLE_MS) {
    if (autoCompileTimer.current) clearTimeout(autoCompileTimer.current);
    if (!autoCompileTarget.current || !autoCompileEnabled) return;
    const remaining = Math.max(
      minimumDelay,
      AUTO_COMPILE_IDLE_MS - (Date.now() - autoCompileActivityAt.current),
    );
    autoCompileTimer.current = setTimeout(runAutoCompile, remaining);
  }

  function runAutoCompile() {
    autoCompileTimer.current = null;
    const target = autoCompileTarget.current;
    if (!target || !autoCompileEnabled || autoCompileRequestPending.current) return;
    const jobs =
      queryClient.getQueryData<{ jobs: CompileWithArtifact[] }>(queryKeys.compiles(projectId))
        ?.jobs ?? [];
    const decision = decideAutoCompile(target, jobs, autoCompileAttempted.current);
    if (decision === 'covered') {
      autoCompileTarget.current = null;
      return;
    }
    if (decision === 'wait') return;
    autoCompileRequestPending.current = true;
    compile.mutate({ trigger: 'auto', target });
  }

  useEffect(() => {
    if (!payload || !autoCompileEnabled) {
      if (autoCompileTimer.current) clearTimeout(autoCompileTimer.current);
      autoCompileTarget.current = null;
      return;
    }
    const target = selectAutoCompileTarget({
      preferredTarget: previewTarget,
      acceptedRevision: payload.project.sourceRevision,
      acceptedCompiledRevision: acceptedCompile?.sourceRevision ?? null,
      proposal: activeProposal
        ? {
            id: activeProposal.id,
            revision: activeProposal.revision,
            compiledRevision: proposalCompile?.proposalRevision ?? null,
          }
        : null,
    });
    if (target) noteAutoCompileActivity(target);
    else {
      if (autoCompileTimer.current) clearTimeout(autoCompileTimer.current);
      autoCompileTarget.current = null;
    }
  }, [
    acceptedCompile?.sourceRevision,
    activeProposal?.id,
    activeProposal?.revision,
    autoCompileEnabled,
    payload?.project.sourceRevision,
    previewTarget,
    proposalCompile?.proposalRevision,
  ]);

  useEffect(() => {
    if (!autoCompileTarget.current) return;
    const hasActive = compileQuery.data?.jobs.some(
      (job) => job.status === 'queued' || job.status === 'running',
    );
    if (!hasActive) armAutoCompile(0);
  }, [compileQuery.data?.jobs]);

  const mutateEntry = useMutation({
    mutationFn: ({ id, method, body }: { id?: string; method: string; body?: unknown }) =>
      api<{ entry: ProjectEntry } | undefined>(
        `/api/v1/projects/${projectId}/entries${id ? `/${id}` : ''}`,
        { method, ...(body ? { body: JSON.stringify(body) } : {}) },
      ),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.project(projectId) });
      if (data?.entry.kind === 'file') setTimeout(() => void openEntry(data.entry), 100);
    },
    onError: (error) => setToast({ id: Date.now(), tone: 'error', message: error.message }),
  });

  async function createEntry(kind: 'file' | 'folder') {
    setEntryDialogError(null);
    setEntryDialog({
      mode: kind === 'file' ? 'create-file' : 'create-folder',
      value: kind === 'file' ? 'chapter.tex' : 'chapters',
      parentId: selected?.kind === 'folder' ? selected.id : (selected?.parentId ?? null),
    });
  }
  function renameEntry() {
    if (!selected) return;
    setEntryDialogError(null);
    setEntryDialog({
      mode: 'rename',
      entryId: selected.id,
      value: selected.name,
      parentId: selected.parentId,
    });
  }
  function duplicateEntry() {
    if (!selected) return;
    mutateEntry.mutate({ id: `${selected.id}/duplicate`, method: 'POST' });
  }
  function deleteEntry() {
    if (!selected) return;
    setEntryDialogError(null);
    setEntryDialog({
      mode: 'delete',
      entryId: selected.id,
      value: selected.name,
      parentId: selected.parentId,
    });
  }

  function moveEntry() {
    if (!selected) return;
    setEntryDialogError(null);
    setEntryDialog({
      mode: 'move',
      entryId: selected.id,
      value: selected.name,
      parentId: selected.parentId,
    });
  }

  async function submitEntryDialog() {
    if (!entryDialog) return;
    const name = entryDialog.value.trim();
    if (
      entryDialog.mode !== 'delete' &&
      entryDialog.mode !== 'move' &&
      (!name || name === '.' || name === '..' || /[\\/\0]/.test(name))
    ) {
      setEntryDialogError('Enter a valid name without slashes.');
      return;
    }
    setEntryDialogPending(true);
    setEntryDialogError(null);
    try {
      if (entryDialog.mode === 'create-file' || entryDialog.mode === 'create-folder') {
        const kind = entryDialog.mode === 'create-file' ? 'file' : 'folder';
        await mutateEntry.mutateAsync({
          method: 'POST',
          body: {
            parentId: entryDialog.parentId,
            name,
            kind,
            ...(kind === 'file' ? { content: '' } : {}),
          },
        });
      } else if (entryDialog.mode === 'rename') {
        await mutateEntry.mutateAsync({
          id: entryDialog.entryId!,
          method: 'PATCH',
          body: { name },
        });
      } else if (entryDialog.mode === 'move') {
        await mutateEntry.mutateAsync({
          id: entryDialog.entryId!,
          method: 'PATCH',
          body: { parentId: entryDialog.parentId },
        });
      } else {
        const ids = descendantIds(entryDialog.entryId!, entries);
        await mutateEntry.mutateAsync({ id: entryDialog.entryId!, method: 'DELETE' });
        for (const id of ids) disposeEditorEntry(projectId, id);
        setOpenTabs((tabs) => tabs.filter((id) => !ids.has(id)));
        setContents((state) => omitKeys(state, ids));
        editHistoriesRef.current = omitKeys(editHistoriesRef.current, ids);
        setEditHistories(editHistoriesRef.current);
        if (selectedId && ids.has(selectedId)) setSelectedId(null);
      }
      setEntryDialog(null);
    } catch (error) {
      setEntryDialogError(error instanceof Error ? error.message : 'The operation failed.');
    } finally {
      setEntryDialogPending(false);
    }
  }

  async function uploadFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const presigned = await api<{ objectKey: string; url: string }>(
        `/api/v1/projects/${projectId}/uploads/presign`,
        {
          method: 'POST',
          body: JSON.stringify({
            name: file.name,
            contentType: file.type || 'application/octet-stream',
            size: file.size,
            parentId: selected?.kind === 'folder' ? selected.id : (selected?.parentId ?? null),
          }),
        },
      );
      const uploaded = await fetch(presigned.url, {
        method: 'PUT',
        body: file,
        headers: { 'content-type': file.type || 'application/octet-stream' },
      });
      if (!uploaded.ok) throw new Error('Object upload failed');
      const result = await api<{ entry: ProjectEntry }>(
        `/api/v1/projects/${projectId}/uploads/finalize`,
        {
          method: 'POST',
          body: JSON.stringify({
            objectKey: presigned.objectKey,
            name: file.name,
            contentType: file.type || 'application/octet-stream',
            parentId: selected?.kind === 'folder' ? selected.id : (selected?.parentId ?? null),
          }),
        },
      );
      await queryClient.invalidateQueries({ queryKey: queryKeys.project(projectId) });
      await openEntry(result.entry);
      setToast({ id: Date.now(), tone: 'success', message: `${file.name} uploaded` });
    } catch (error) {
      setToast({
        id: Date.now(),
        tone: 'error',
        message: error instanceof Error ? error.message : 'Upload failed',
      });
    } finally {
      event.target.value = '';
    }
  }

  async function forwardSearch(selection?: SourceSelection) {
    const syncPath = selected ? paths.get(selected.id) : proposalOpenPath;
    const syncContent = selected
      ? currentContent
      : activeEditorId
        ? contents[activeEditorId]
        : null;
    if (!successfulCompile || !syncPath) return;
    const syncText =
      agentProposal.fileModel?.path === syncPath
        ? agentProposal.fileModel.buffer
        : (syncContent?.content ?? '');
    const currentLine = syncText.split('\n')[cursor.line - 1] ?? '';
    const sourceSelection = selection ?? {
      start: cursor,
      end: cursor,
      text: '',
      before: currentLine.slice(0, Math.max(0, cursor.column - 1)),
      after: currentLine.slice(Math.max(0, cursor.column - 1)),
    };
    syncRequestRef.current?.controller.abort();
    const request = {
      id: (syncRequestRef.current?.id ?? 0) + 1,
      controller: new AbortController(),
    };
    syncRequestRef.current = request;
    try {
      const result = await api<PdfSyncResult>(
        `/api/v1/projects/${projectId}/compilations/${successfulCompile.id}/synctex/forward`,
        {
          method: 'POST',
          signal: request.controller.signal,
          body: JSON.stringify({
            path: syncPath,
            selection: sourceSelection,
            entryVersion: syncContent?.version ?? selected?.version ?? 0,
            source:
              successfulCompile.target === 'proposal'
                ? {
                    target: 'proposal',
                    proposalId: successfulCompile.proposalId,
                    proposalRevision: successfulCompile.proposalRevision,
                  }
                : { target: 'accepted' },
            ...(pdfPageHint ? { pageHint: pdfPageHint } : {}),
          }),
        },
      );
      if (syncRequestRef.current?.id !== request.id) return;
      setForward({ compilationId: successfulCompile.id, result });
      setPreviewVisible(true);
      setMobilePanel('preview');
    } catch (error) {
      if (request.controller.signal.aborted) return;
      setToast({
        id: Date.now(),
        tone: 'error',
        message: error instanceof Error ? error.message : 'No PDF location found',
      });
    }
  }
  async function inverseSearch(page: number, x: number, y: number) {
    if (!successfulCompile) return;
    try {
      const result = await api<{ path: string; line: number }>(
        `/api/v1/projects/${projectId}/compilations/${successfulCompile.id}/synctex/inverse`,
        {
          method: 'POST',
          body: JSON.stringify({
            page,
            x,
            y,
            source:
              successfulCompile.target === 'proposal'
                ? {
                    target: 'proposal',
                    proposalId: successfulCompile.proposalId,
                    proposalRevision: successfulCompile.proposalRevision,
                  }
                : { target: 'accepted' },
          }),
        },
      );
      const target = entries.find(
        (entry) =>
          paths.get(entry.id) === result.path || result.path.endsWith(`/${paths.get(entry.id)}`),
      );
      if (target) {
        await openEntry(target);
        setNavigation((old) => ({ line: result.line, token: (old?.token ?? 0) + 1 }));
        setMobilePanel('editor');
      } else if (agentProposal.virtualFiles.some((file) => file.path === result.path)) {
        openProposalPath(result.path);
        setNavigation((old) => ({ line: result.line, token: (old?.token ?? 0) + 1 }));
        setMobilePanel('editor');
      }
    } catch (error) {
      setToast({
        id: Date.now(),
        tone: 'error',
        message: error instanceof Error ? error.message : 'No source location found',
      });
    }
  }

  function startResize(kind: 'tree' | 'editor', event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const target = event.currentTarget;
    const pointerId = event.pointerId;
    target.setPointerCapture(pointerId);
    const startX = event.clientX;
    const start = kind === 'tree' ? treeWidth : editorWidth;
    const previewMin = 240;
    const editorMin = 280;
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      const treeBudget = filesVisible ? treeWidth + 5 : 0;
      const next = Math.max(
        kind === 'tree' ? 160 : editorMin,
        Math.min(
          kind === 'tree'
            ? 420
            : Math.max(editorMin, window.innerWidth - treeBudget - previewMin - 5),
          start + moveEvent.clientX - startX,
        ),
      );
      if (kind === 'tree') setTreeWidth(next);
      else setEditorWidth(next);
    };
    const stop = (stopEvent: PointerEvent) => {
      if (stopEvent.pointerId !== pointerId) return;
      target.releasePointerCapture(pointerId);
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', stop);
      target.removeEventListener('pointercancel', stop);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', stop);
    target.addEventListener('pointercancel', stop);
  }

  if (sessionPending || !session?.user || projectQuery.isPending || !payload)
    return (
      <main className="screen-center">
        <span className="spinner" />
        <p>Opening workspace…</p>
      </main>
    );
  if (projectQuery.isError)
    return (
      <main className="screen-center">
        <CircleAlert size={42} />
        <h2>Unable to open project</h2>
        <p>{projectQuery.error.message}</p>
        <Button onClick={() => void projectQuery.refetch()}>Try again</Button>
      </main>
    );
  const currentContent = selected ? contents[selected.id] : null;
  const virtualFile = agentProposal.virtualFiles.find(
    (file) => `proposal:${file.changeId}` === selectedId,
  );
  const virtualEntry: ProjectEntry | null =
    !selected && virtualFile
      ? {
          id: `proposal:${virtualFile.changeId}`,
          projectId,
          parentId: null,
          name: virtualFile.name,
          kind: 'file',
          mimeType: 'text/plain',
          size: 0,
          version: 0,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        }
      : null;
  const activeEditorEntry = entries.find((entry) => entry.id === activeEditorId) ?? virtualEntry;
  const activeEditorContent = activeEditorId
    ? contents[activeEditorId]
    : virtualEntry
      ? { content: '', version: 0 }
      : undefined;
  const editorIsVisible = Boolean(
    activeEditorEntry &&
      activeEditorContent &&
      (selected?.id === activeEditorEntry.id || virtualEntry?.id === activeEditorEntry.id),
  );
  const previewUrl = successfulCompile
    ? appPath(`/api/v1/projects/${projectId}/compilations/${successfulCompile.id}/pdf`)
    : null;

  return (
    <main className="workspace">
      <header className="workspace-toolbar">
        <Link to="/projects" search={{}} className="icon-button" aria-label="Back to projects">
          <ArrowLeft size={17} />
        </Link>
        <div className="project-title">
          <Code2 size={17} />
          <span>{payload.project.name}</span>
          {payload.project.isTemplate && <span className="badge">Template</span>}
          {successfulCompile &&
            successfulCompile.sourceRevision < payload.project.sourceRevision && (
              <span className="badge badge-warning">PDF out of date</span>
            )}
        </div>
        <label className="badge">
          <input
            type="checkbox"
            checked={autoCompileEnabled}
            onChange={(event) => void setAutoCompile(event.target.checked)}
          />{' '}
          Auto
        </label>
        {activeCompile ? (
          <Button
            className="compile-button running"
            onClick={() =>
              void api(`/api/v1/projects/${projectId}/compilations/${activeCompile.id}`, {
                method: 'DELETE',
              })
            }
          >
            <LoaderCircle className="spin" size={16} />{' '}
            {activeCompile.status === 'queued' ? 'Queued' : 'Compiling'} <CircleStop size={15} />
          </Button>
        ) : (
          <Button className="compile-button" onClick={requestManualCompile}>
            <Play size={15} /> Compile
          </Button>
        )}
        <div className="workspace-toolbar-extras">
          <IconButton
            label="Forward search"
            disabled={!successfulCompile || !selectedPath}
            onClick={() => void forwardSearch()}
          >
            <Target size={17} />
          </IconButton>
          <IconButton
            label={`Search project${shortcuts['workspace.projectSearch'] ? ` (${displayShortcut(shortcuts['workspace.projectSearch'])})` : ''}`}
            onClick={() => void openProjectSearch()}
          >
            <FileSearch size={17} />
          </IconButton>
          <IconButton
            label={`Command palette${shortcuts['workspace.commandPalette'] ? ` (${displayShortcut(shortcuts['workspace.commandPalette'])})` : ''}`}
            onClick={() => {
              setPaletteQuery('');
              setPaletteOpen(true);
            }}
          >
            <Command size={17} />
          </IconButton>
          <IconButton label="Version history" onClick={() => setHistoryOpen(true)}>
            <History size={17} />
          </IconButton>
          <ProjectSettingsControl
            ref={projectSettingsRef}
            project={payload.project}
            entries={entries}
            onSaved={() => void projectQuery.refetch()}
            onOpenProfileSettings={() => setAccountSettings('account')}
          />
          <AppearanceMenu />
        </div>
      </header>
      <nav className="mobile-switcher" aria-label="Workspace panes">
        {(['files', 'editor', 'preview'] as const).map((panel) => (
          <button
            key={panel}
            className={mobilePanel === panel ? 'active' : ''}
            onClick={() => setMobilePanel(panel)}
          >
            {panel[0]!.toUpperCase() + panel.slice(1)}
          </button>
        ))}
        <AppearanceMenu />
      </nav>
      <div
        className="workspace-main"
        style={{
          // Hidden panels use display:none and drop out of grid placement, so the
          // template must only list columns for panes that still participate.
          // (Keeping `0 0` placeholders shoved the editor into a zero-width column.)
          gridTemplateColumns: buildWorkspaceColumns(
            filesVisible,
            previewVisible,
            treeWidth,
            editorWidth,
          ),
        }}
      >
        <section
          className={classNames(
            'panel file-panel',
            !filesVisible && !touchLayout && 'panel-hidden',
            mobilePanel === 'files' && 'mobile-active',
          )}
        >
          <div className="panel-header">
            <span>Files</span>
            {!touchLayout && (
              <IconButton label="Hide file tree" onClick={() => setFilesVisible(false)}>
                <ChevronLeft size={15} />
              </IconButton>
            )}
            <IconButton label="New file" onClick={() => void createEntry('file')}>
              <FilePlus2 size={15} />
            </IconButton>
            <IconButton label="New folder" onClick={() => void createEntry('folder')}>
              <FolderPlus size={15} />
            </IconButton>
            <input ref={uploadRef} hidden type="file" onChange={uploadFile} />
            <IconButton label="Upload file" onClick={() => uploadRef.current?.click()}>
              <Upload size={15} />
            </IconButton>
          </div>
          <div className="file-tree">
            <FileTree
              entries={entries}
              proposalChanges={activeProposal?.changes ?? []}
              selectedId={selectedId}
              onSelect={(entry) => void openEntry(entry)}
              onMove={(entryId, parentId) =>
                mutateEntry.mutate({ id: entryId, method: 'PATCH', body: { parentId } })
              }
            />
            {activeProposal?.changes
              .filter((change) => !change.entryId && change.decision !== 'rejected')
              .map((change) => (
                <button
                  type="button"
                  className="tree-row proposal-added"
                  key={change.id}
                  onClick={() => {
                    if (change.entryKind === 'file' && change.targetPath)
                      openProposalPath(change.targetPath);
                  }}
                >
                  {change.entryKind === 'folder' ? <Folder size={15} /> : <File size={15} />}
                  <span>{change.targetPath}</span>
                  <span className="badge proposal-tree-badge">added</span>
                </button>
              ))}
          </div>
          {selected && (
            <div className="file-actions">
              <Button variant="ghost" onClick={renameEntry}>
                <Pencil size={14} /> Rename
              </Button>
              <Button variant="ghost" onClick={duplicateEntry}>
                <Copy size={14} /> Duplicate
              </Button>
              <Button variant="ghost" onClick={moveEntry}>
                <FolderInput size={14} /> Move
              </Button>
              <Button variant="ghost" onClick={deleteEntry}>
                <Trash2 size={14} /> Delete
              </Button>
            </div>
          )}
          {virtualFile && activeProposal && canDiscardDraftChange(activeProposal.status) && (
            <div className="file-actions">
              <Button
                variant="ghost"
                disabled={agentProposal.busy}
                onClick={() => void agentProposal.discardChange(virtualFile.changeId)}
              >
                <Trash2 size={14} /> Discard proposed file
              </Button>
            </div>
          )}
        </section>
        <div
          className={classNames('resizer', !filesVisible && !touchLayout && 'panel-hidden')}
          onPointerDown={(event) => startResize('tree', event)}
        />
        <section
          className={classNames('panel editor-panel', mobilePanel === 'editor' && 'mobile-active')}
        >
          <div className="tab-bar">
            {!filesVisible && !touchLayout && (
              <IconButton
                className="file-tree-reveal"
                label="Show file tree"
                onClick={() => setFilesVisible(true)}
              >
                <ChevronRight size={15} />
              </IconButton>
            )}
            {openTabs.map((id) => {
              const proposalFile = agentProposal.virtualFiles.find(
                (file) => `proposal:${file.changeId}` === id,
              );
              const entry =
                entries.find((item) => item.id === id) ??
                (proposalFile
                  ? {
                      id,
                      projectId,
                      parentId: null,
                      name: proposalFile.name,
                      kind: 'file' as const,
                      mimeType: 'text/plain',
                      size: 0,
                      version: 0,
                      createdAt: new Date(0).toISOString(),
                      updatedAt: new Date(0).toISOString(),
                    }
                  : null);
              if (!entry) return null;
              return (
                <button
                  key={id}
                  className={classNames('editor-tab', id === selectedId && 'active')}
                  onClick={() => {
                    if (entry.id.startsWith('proposal:') && proposalFile)
                      openProposalPath(proposalFile.path);
                    else void openEntry(entry);
                  }}
                >
                  <File size={13} />
                  <span>{entry.name}</span>
                  {saveStates[id] && saveStates[id] !== 'saved' && (
                    <span
                      className={`tab-save-state tab-save-state-${saveStates[id]}`}
                      aria-label={saveStates[id]}
                    />
                  )}
                  <X
                    size={13}
                    onClick={(event) => {
                      event.stopPropagation();
                      closeTab(id);
                    }}
                  />
                </button>
              );
            })}
            {!previewVisible && !touchLayout && (
              <IconButton
                className="preview-reveal"
                label="Show PDF preview"
                onClick={() => setPreviewVisible(true)}
              >
                <ChevronLeft size={15} />
              </IconButton>
            )}
            {selected?.kind === 'file' && isTextFile(selected.name, selected.mimeType) && (
              <IconButton
                className="edit-history-button"
                label="Undo history"
                onClick={() => {
                  void loadEditHistory(selected.id, true);
                  setEditHistoryOpen(true);
                }}
              >
                <History size={15} />
              </IconButton>
            )}
          </div>
          <div className="editor-workspace-stage">
            {activeEditorEntry && activeEditorContent && (
              <div
                className={classNames(
                  'workspace-editor-controller',
                  !editorIsVisible && 'workspace-editor-controller-hidden',
                )}
                aria-hidden={!editorIsVisible}
              >
                <EditorPane
                  projectId={projectId}
                  entry={{ ...activeEditorEntry, version: activeEditorContent.version }}
                  path={
                    paths.get(activeEditorEntry.id) ?? proposalOpenPath ?? activeEditorEntry.name
                  }
                  content={activeEditorContent.content}
                  proposalModel={agentProposal.overlayBlocked ? null : agentProposal.fileModel}
                  lspEnabled={!activeEditorEntry.id.startsWith('proposal:')}
                  proposalStatus={activeProposal?.status ?? 'draft'}
                  selectedHunkId={agentProposal.selectedHunkId}
                  onSelectHunk={agentProposal.setSelectedHunkId}
                  onProposalEdit={(edit) => {
                    setPreviewTarget('proposal');
                    void agentProposal.persistEdit(edit);
                  }}
                  onDecideHunk={(hunkId, decision) => void agentProposal.decide(hunkId, decision)}
                  proposalDock={
                    activeProposal ? (
                      <ProposalEditorDock
                        status={activeProposal.status}
                        currentAdded={agentProposal.totals.added}
                        currentDeleted={agentProposal.totals.deleted}
                        items={agentProposal.items}
                        selectedId={agentProposal.selectedHunkId}
                        expanded={agentProposal.dockExpanded}
                        busy={agentProposal.busy || agentProposal.overlayBlocked}
                        previewTarget={previewTarget}
                        compileStatus={latestProposalCompile?.status ?? null}
                        error={agentProposal.error}
                        onToggle={() => agentProposal.setDockExpanded((value) => !value)}
                        onSelect={(item) => {
                          agentProposal.selectItem(item);
                          openProposalPath(item.path);
                        }}
                        onDecide={(itemId, decision) => void agentProposal.decide(itemId, decision)}
                        onAcceptAll={() => void agentProposal.acceptAll()}
                        onRejectAll={() => void agentProposal.rejectAll()}
                        onPreviewTarget={setPreviewTarget}
                        onFinish={() => void agentProposal.finish()}
                      />
                    ) : null
                  }
                  onChange={(entryId, content) => {
                    setPreviewTarget('accepted');
                    setContents((state) => ({
                      ...state,
                      [entryId]: { ...state[entryId]!, content },
                    }));
                    if (autoCompileTarget.current) noteAutoCompileActivity();
                  }}
                  onSave={saveFile}
                  onConflict={(entryId, local, server) =>
                    setConflictState({ entryId, local, server })
                  }
                  onCursor={(line, column) => {
                    setCursor({ line, column });
                    if (autoCompileTarget.current) noteAutoCompileActivity();
                  }}
                  onLanguageStatus={setLspStatus}
                  onSaveState={(entryId, state) =>
                    setSaveStates((value) => ({ ...value, [entryId]: state }))
                  }
                  onSourceLocate={(selection) => void forwardSearch(selection)}
                  shortcuts={shortcuts}
                  keymap={shortcutQuery.data?.keymap ?? 'linux'}
                  onWorkspaceShortcut={runShortcut}
                  onHistoryAction={(direction) => void navigateEditHistory(direction)}
                  onRegisterSave={(save) => {
                    saveCurrentRef.current = save;
                  }}
                  onRegisterFocus={(focus) => {
                    focusEditorRef.current = focus;
                  }}
                  onRegisterShortcutRunner={(run) => {
                    editorShortcutRef.current = run;
                  }}
                  onRegisterViewport={(capture) => {
                    captureViewportRef.current = capture;
                  }}
                  revealLine={editorIsVisible ? (navigation?.line ?? null) : null}
                  navigationToken={navigation?.token ?? 0}
                  navigationSelections={editorIsVisible ? (navigation?.selections ?? null) : null}
                  viewportSnapshot={viewportRestore?.snapshot ?? null}
                  viewportToken={viewportRestore?.token ?? 0}
                  fontSize={appearance.editorFontSize}
                  touchLayout={touchLayout}
                />
              </div>
            )}
            {!editorIsVisible &&
              (!selected ? (
                <div className="editor-empty editor-workspace-overlay">
                  <Code2 size={42} />
                  <p>Select a file to begin.</p>
                </div>
              ) : selected.kind === 'folder' ? (
                <div className="editor-empty editor-workspace-overlay">
                  <FolderOpen size={42} />
                  <p>{selected.name}</p>
                </div>
              ) : !isTextFile(selected.name, selected.mimeType) ? (
                <div className="editor-workspace-overlay">
                  <BinaryPreview entry={selected} projectId={projectId} />
                </div>
              ) : (
                <div className="editor-empty editor-workspace-overlay">
                  <span className="spinner" />
                  <p>Loading {selected.name}…</p>
                </div>
              ))}
          </div>
        </section>
        <div
          className={classNames('resizer', !previewVisible && !touchLayout && 'panel-hidden')}
          onPointerDown={(event) => startResize('editor', event)}
        />
        <section
          className={classNames(
            'panel preview-panel',
            !previewVisible && !touchLayout && 'panel-hidden',
            mobilePanel === 'preview' && 'mobile-active',
          )}
        >
          {previewUrl ? (
            <PdfViewer
              url={previewUrl}
              downloadUrl={appPath(
                `/api/v1/projects/${projectId}/compilations/${successfulCompile!.id}/download`,
              )}
              openUrl={appPath(`/projects/${projectId}/pdf/${successfulCompile!.id}`)}
              storageKey={projectId}
              forwardLocation={currentPdfSyncResult(forward, successfulCompile!.id)}
              onInverse={(page, x, y) => void inverseSearch(page, x, y)}
              onCollapse={() => {
                setPreviewVisible(false);
                setMobilePanel('editor');
                focusEditorRef.current?.();
              }}
              onOpenExternal={() => {
                setPreviewVisible(false);
                setMobilePanel('editor');
                window.setTimeout(() => focusEditorRef.current?.());
              }}
              onPageChange={setPdfPageHint}
            />
          ) : (
            <div className="pdf-empty">
              <FileImage size={44} />
              <h3>No PDF yet</h3>
              <p>Compile the project to render a preview.</p>
              <Button variant="primary" onClick={requestManualCompile}>
                <Play size={15} /> Compile
              </Button>
            </div>
          )}
          {problemsOpen && (
            <ProblemsPanel
              job={latestCompile}
              activeTab={bottomTab}
              onTab={setBottomTab}
              onDiagnostic={(diagnostic) => {
                const target = entries.find(
                  (entry) =>
                    paths.get(entry.id) === diagnostic.file ||
                    diagnostic.file?.endsWith(`/${paths.get(entry.id)}`),
                );
                if (target) {
                  void openEntry(target);
                  setNavigation((old) => ({
                    line: diagnostic.line!,
                    token: (old?.token ?? 0) + 1,
                  }));
                }
              }}
            />
          )}
        </section>
      </div>
      <footer className="statusbar">
        <span className={lspStatus === 'ready' ? 'status-ok' : ''}>
          {lspStatus === 'ready'
            ? 'TexLab ready'
            : lspStatus === 'failed'
              ? 'TexLab failed'
              : lspStatus === 'reconnecting'
                ? 'TexLab reconnecting'
                : 'TexLab connecting'}
        </span>
        {selectedId && saveStates[selectedId] && saveStates[selectedId] !== 'saved' && (
          <span className={`save-status save-status-${saveStates[selectedId]}`}>
            {saveStates[selectedId]}
          </span>
        )}
        {successfulCompile && successfulCompile.sourceRevision < payload.project.sourceRevision && (
          <span className="save-status save-status-stale">PDF out of date</span>
        )}
        <span>
          Ln {cursor.line}, Col {cursor.column}
        </span>
        <span>{payload.project.compiler}</span>
        <span className="right">Revision {payload.project.sourceRevision}</span>
        <button
          className="icon-button"
          onClick={() => setProblemsOpen((value) => !value)}
          aria-label="Toggle Problems panel"
        >
          {problemsOpen ? <PanelBottomClose size={14} /> : <PanelBottomOpen size={14} />}
        </button>
      </footer>
      <HistoryDialog
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        projectId={projectId}
        onRestored={() => {
          void projectQuery.refetch();
          setContents({});
          setSelectedId(null);
          setOpenTabs([]);
        }}
      />
      <EditHistoryDialog
        open={editHistoryOpen}
        onOpenChange={setEditHistoryOpen}
        projectId={projectId}
        entry={selected?.kind === 'file' ? selected : null}
        history={selected ? editHistories[selected.id] : undefined}
        onCheckout={(nodeId) => void checkoutEditHistory(nodeId)}
        onLoadMore={() => (selected ? loadMoreEditHistory(selected.id) : undefined)}
      />
      <AccountSettingsDialog
        open={accountSettings !== null}
        onOpenChange={(open) => {
          if (!open) setAccountSettings(null);
        }}
        initialSection={accountSettings ?? 'account'}
      />
      <Dialog
        open={Boolean(entryDialog)}
        onOpenChange={(open) => {
          if (!open && !entryDialogPending) setEntryDialog(null);
        }}
        title={
          entryDialog?.mode === 'create-file'
            ? 'Create file'
            : entryDialog?.mode === 'create-folder'
              ? 'Create folder'
              : entryDialog?.mode === 'rename'
                ? 'Rename entry'
                : entryDialog?.mode === 'move'
                  ? 'Move entry'
                  : 'Delete entry'
        }
        {...(entryDialog?.mode === 'delete'
          ? {
              description: `Delete “${entryDialog.value}”? Project checkpoints remain available for recovery.`,
            }
          : entryDialog?.mode === 'move'
            ? { description: 'Choose a destination folder. This works without dragging.' }
            : {})}
      >
        {entryDialog && entryDialog.mode !== 'delete' && entryDialog.mode !== 'move' && (
          <label className="field">
            <span>Name</span>
            <input
              autoFocus
              className="input"
              value={entryDialog.value}
              disabled={entryDialogPending}
              onChange={(event) =>
                setEntryDialog((state) => state && { ...state, value: event.target.value })
              }
              onKeyDown={(event) => {
                if (event.key === 'Enter') void submitEntryDialog();
              }}
            />
          </label>
        )}
        {entryDialog?.mode === 'move' && (
          <label className="field">
            <span>Destination</span>
            <select
              className="input"
              value={entryDialog.parentId ?? ''}
              disabled={entryDialogPending}
              onChange={(event) =>
                setEntryDialog(
                  (state) => state && { ...state, parentId: event.target.value || null },
                )
              }
            >
              <option value="">Project root</option>
              {entries
                .filter(
                  (entry) =>
                    entry.kind === 'folder' &&
                    entry.id !== entryDialog.entryId &&
                    !descendantIds(entryDialog.entryId!, entries).has(entry.id),
                )
                .map((folder) => (
                  <option key={folder.id} value={folder.id}>
                    {paths.get(folder.id)}
                  </option>
                ))}
            </select>
          </label>
        )}
        {entryDialogError && (
          <p className="form-error" role="alert">
            {entryDialogError}
          </p>
        )}
        <div className="dialog-actions">
          <Button disabled={entryDialogPending} onClick={() => setEntryDialog(null)}>
            Cancel
          </Button>
          <Button
            variant={entryDialog?.mode === 'delete' ? 'danger' : 'primary'}
            disabled={entryDialogPending}
            onClick={() => void submitEntryDialog()}
          >
            {entryDialogPending && <LoaderCircle className="spin" size={15} />}
            {entryDialog?.mode === 'delete'
              ? 'Delete'
              : entryDialog?.mode === 'move'
                ? 'Move'
                : 'Save'}
          </Button>
        </div>
      </Dialog>
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        query={paletteQuery}
        onQuery={setPaletteQuery}
        commands={[
          ...shortcutRegistry.map((item) => ({
            label:
              item.id === 'workspace.files'
                ? filesVisible
                  ? 'Hide file tree'
                  : 'Show file tree'
                : item.id === 'workspace.togglePreview'
                  ? previewVisible
                    ? 'Hide PDF preview'
                    : 'Show PDF preview'
                  : item.id === 'workspace.problems'
                    ? problemsOpen
                      ? 'Hide Problems and Logs'
                      : 'Show Problems and Logs'
                    : item.label,
            ...(shortcuts[item.id] ? { shortcut: displayShortcut(shortcuts[item.id]) } : {}),
            run: () => runShortcut(item.id),
          })),
          ...entries
            .filter((entry) => entry.kind === 'file')
            .map((entry) => ({
              label: `Open ${paths.get(entry.id)}`,
              run: () => void openEntry(entry),
            })),
        ]}
      />
      <ProjectSearchDialog
        open={projectSearchOpen}
        onOpenChange={(open) => {
          setProjectSearchOpen(open);
          if (!open) projectSearchRequestRef.current += 1;
        }}
        query={projectSearchQuery}
        onQuery={setProjectSearchQuery}
        sources={projectSearchSources}
        loading={projectSearchLoading}
        failedFiles={projectSearchFailedFiles}
        onSelect={(result) => void openProjectSearchResult(result)}
      />
      <Dialog
        open={Boolean(conflictState)}
        onOpenChange={(open) => !open && setConflictState(null)}
        title="Resolve editing conflict"
        description="Overlapping edits could not be merged safely. Choose which content should become current."
        wide
      >
        {conflictState && (
          <>
            <div className="history-diff" style={{ height: 380 }}>
              <DiffEditor
                original={conflictState.server.content}
                modified={conflictState.local}
                language="latex"
                theme="hate-of-nature"
                options={{ readOnly: true, automaticLayout: true }}
              />
            </div>
            <div className="dialog-actions">
              <Button
                onClick={() => {
                  setContents((state) => ({
                    ...state,
                    [conflictState.entryId]: conflictState.server,
                  }));
                  void del(`draft:${projectId}:${conflictState.entryId}`);
                  void del(`edit-history-outbox:${projectId}:${conflictState.entryId}`);
                  void loadEditHistory(conflictState.entryId, true);
                  setConflictState(null);
                }}
              >
                Use server version
              </Button>
              <Button
                variant="primary"
                onClick={async () => {
                  await del(`edit-history-outbox:${projectId}:${conflictState.entryId}`);
                  await loadEditHistory(conflictState.entryId, true);
                  const result = await saveFile(
                    conflictState.entryId,
                    conflictState.local,
                    conflictState.server.version,
                    { selectionBefore: null, selectionAfter: null },
                  );
                  setContents((state) => ({
                    ...state,
                    [conflictState.entryId]: {
                      content: result.content,
                      version: result.version,
                    },
                  }));
                  void del(`draft:${projectId}:${conflictState.entryId}`);
                  setConflictState(null);
                }}
              >
                Keep my version
              </Button>
            </div>
          </>
        )}
      </Dialog>
      {toast && <Toast toast={toast} dismiss={() => setToast(null)} />}
    </main>
  );
}

type PaletteCommand = { label: string; shortcut?: string | undefined; run: () => void };

function CommandPalette({
  open,
  onOpenChange,
  query,
  onQuery,
  commands,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  query: string;
  onQuery: (value: string) => void;
  commands: PaletteCommand[];
}) {
  const [active, setActive] = useState(0);
  const filtered = commands
    .filter((command) => command.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    .slice(0, 14);
  useEffect(() => setActive(0), [query, open]);
  const execute = (command: PaletteCommand | undefined) => {
    if (!command) return;
    onOpenChange(false);
    command.run();
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Command palette"
      description="Run a workspace action or switch files."
    >
      <div className="command-palette">
        <label className="searchbox">
          <Command size={16} />
          <span className="sr-only">Search commands</span>
          <input
            autoFocus
            className="input"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActive((value) => Math.min(filtered.length - 1, value + 1));
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActive((value) => Math.max(0, value - 1));
              }
              if (event.key === 'Enter') {
                event.preventDefault();
                execute(filtered[active]);
              }
            }}
            placeholder="Type a command or file name…"
          />
        </label>
        <div className="command-results" role="listbox" aria-label="Commands">
          {filtered.length ? (
            filtered.map((command, index) => (
              <button
                key={`${command.label}-${index}`}
                role="option"
                aria-selected={active === index}
                className={active === index ? 'active' : ''}
                onMouseEnter={() => setActive(index)}
                onClick={() => execute(command)}
              >
                <span>{command.label}</span>
                {command.shortcut && <kbd>{command.shortcut}</kbd>}
              </button>
            ))
          ) : (
            <p className="hint">No matching commands.</p>
          )}
        </div>
      </div>
    </Dialog>
  );
}

function FileTree({
  entries,
  proposalChanges,
  selectedId,
  onSelect,
  onMove,
}: {
  entries: ProjectEntry[];
  proposalChanges: AgentProposalChange[];
  selectedId: string | null;
  onSelect: (entry: ProjectEntry) => void;
  onMove: (id: string, parentId: string | null) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(entries.filter((entry) => entry.kind === 'folder').map((entry) => entry.id)),
  );
  const proposalByEntry = new Map(
    proposalChanges.filter((change) => change.entryId).map((change) => [change.entryId, change]),
  );
  const children = (parentId: string | null) =>
    entries
      .filter((entry) => entry.parentId === parentId)
      .sort((a, b) =>
        a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'folder' ? -1 : 1,
      );
  const render = (parentId: string | null, depth = 0): React.ReactNode =>
    children(parentId).map((entry) => (
      <div key={entry.id}>
        <button
          type="button"
          role="treeitem"
          data-entry-id={entry.id}
          data-parent-id={entry.parentId ?? undefined}
          aria-level={depth + 1}
          aria-selected={selectedId === entry.id}
          aria-expanded={entry.kind === 'folder' ? expanded.has(entry.id) : undefined}
          tabIndex={
            selectedId === entry.id ||
            (!selectedId && depth === 0 && children(null)[0]?.id === entry.id)
              ? 0
              : -1
          }
          className={classNames(
            'tree-row',
            selectedId === entry.id && 'selected',
            proposalByEntry.get(entry.id)?.operation === 'delete' && 'proposal-deleted',
          )}
          style={{ paddingLeft: 7 + depth * 14 }}
          draggable
          onDragStart={(event) => event.dataTransfer.setData('text/entry-id', entry.id)}
          onDragOver={(event) => {
            if (entry.kind === 'folder') event.preventDefault();
          }}
          onDrop={(event) => {
            event.preventDefault();
            const id = event.dataTransfer.getData('text/entry-id');
            if (id && id !== entry.id && entry.kind === 'folder') onMove(id, entry.id);
          }}
          onClick={() => {
            onSelect(entry);
            if (entry.kind === 'folder')
              setExpanded((old) => {
                const next = new Set(old);
                if (next.has(entry.id)) next.delete(entry.id);
                else next.add(entry.id);
                return next;
              });
          }}
          onKeyDown={(event) => {
            const root = event.currentTarget.closest('[role="tree"]');
            const rows = root
              ? Array.from(root.querySelectorAll<HTMLElement>('[role="treeitem"]'))
              : [];
            const index = rows.indexOf(event.currentTarget);
            const focusAt = (next: number) =>
              rows[Math.max(0, Math.min(rows.length - 1, next))]?.focus();
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              focusAt(index + 1);
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              focusAt(index - 1);
            } else if (event.key === 'Home') {
              event.preventDefault();
              focusAt(0);
            } else if (event.key === 'End') {
              event.preventDefault();
              focusAt(rows.length - 1);
            } else if (event.key === 'ArrowRight' && entry.kind === 'folder') {
              event.preventDefault();
              if (!expanded.has(entry.id)) setExpanded((old) => new Set(old).add(entry.id));
              else
                window.setTimeout(() =>
                  root?.querySelector<HTMLElement>(`[data-parent-id="${entry.id}"]`)?.focus(),
                );
            } else if (event.key === 'ArrowLeft') {
              event.preventDefault();
              if (entry.kind === 'folder' && expanded.has(entry.id))
                setExpanded((old) => {
                  const next = new Set(old);
                  next.delete(entry.id);
                  return next;
                });
              else if (entry.parentId)
                root?.querySelector<HTMLElement>(`[data-entry-id="${entry.parentId}"]`)?.focus();
            }
          }}
        >
          {entry.kind === 'folder' ? (
            <>
              {expanded.has(entry.id) ? (
                <ChevronDown className="chevron" size={13} />
              ) : (
                <ChevronRight className="chevron" size={13} />
              )}
              {expanded.has(entry.id) ? <FolderOpen size={15} /> : <Folder size={15} />}
            </>
          ) : (
            <>
              <span style={{ width: 13 }} />
              {entry.mimeType?.startsWith('image/') ? <FileImage size={15} /> : <File size={15} />}
            </>
          )}
          <span>{entry.name}</span>
          {proposalByEntry.get(entry.id) && (
            <span className="badge proposal-tree-badge">
              {proposalByEntry.get(entry.id)?.operation.replace('_file', '').replace('_', ' ')}
            </span>
          )}
        </button>
        {entry.kind === 'folder' && expanded.has(entry.id) && render(entry.id, depth + 1)}
      </div>
    ));
  return (
    <div
      role="tree"
      aria-label="Project files"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        const id = event.dataTransfer.getData('text/entry-id');
        if (id) onMove(id, null);
      }}
    >
      {render(null)}
    </div>
  );
}

function EditHistoryDialog({
  open,
  onOpenChange,
  projectId,
  entry,
  history,
  onCheckout,
  onLoadMore,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  entry: ProjectEntry | null;
  history: EditHistoryResponse | undefined;
  onCheckout: (nodeId: string) => void;
  onLoadMore: () => Promise<void> | undefined;
}) {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [loadMorePending, setLoadMorePending] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  useEffect(() => {
    if (open) setSelectedNodeId(history?.currentNodeId ?? null);
  }, [history?.currentNodeId, open]);
  const preview = useQuery({
    queryKey: ['edit-history-preview', entry?.id, selectedNodeId],
    queryFn: () =>
      api<{ content: string }>(
        `/api/v1/projects/${projectId}/entries/${entry!.id}/edit-history/${selectedNodeId}/content`,
      ),
    enabled: open && Boolean(entry && selectedNodeId && selectedNodeId !== history?.currentNodeId),
  });
  const selectedNode = history?.nodes.find((node) => node.id === selectedNodeId);
  const previewContent =
    selectedNodeId === history?.currentNodeId ? history?.content : preview.data?.content;
  const nodeMap = new Map(history?.nodes.map((node) => [node.id, node]) ?? []);
  const depth = (node: EditHistoryNode) => {
    let count = 0;
    let parent = node.parentId ? nodeMap.get(node.parentId) : undefined;
    while (parent && count < 12) {
      count += 1;
      parent = parent.parentId ? nodeMap.get(parent.parentId) : undefined;
    }
    return count;
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Undo history${entry ? ` — ${entry.name}` : ''}`}
      description="Every edit branch remains selectable. Undo and redo follow the highlighted preferred branch."
      wide
    >
      {!history ? (
        <div className="dialog-loading">
          <span className="spinner" /> Loading edit history…
        </div>
      ) : (
        <div className="history-layout edit-history-layout">
          <div className="history-list" role="tree" aria-label="Edit history branches">
            {history.nodes.map((node) => (
              <button
                key={node.id}
                role="treeitem"
                aria-level={depth(node) + 1}
                aria-current={node.id === history.currentNodeId ? 'true' : undefined}
                className={classNames('history-item', selectedNodeId === node.id && 'active')}
                style={{ paddingLeft: 10 + depth(node) * 14 }}
                onClick={() => setSelectedNodeId(node.id)}
              >
                <span>{node.summary}</span>
                <small>
                  {node.id === history.currentNodeId ? 'Current · ' : ''}
                  {formatRelative(node.createdAt)}
                </small>
              </button>
            ))}
            {history.nextCursor && (
              <Button
                disabled={loadMorePending}
                onClick={async () => {
                  setLoadMorePending(true);
                  setLoadMoreError(null);
                  try {
                    await onLoadMore();
                  } catch (error) {
                    setLoadMoreError(
                      error instanceof Error ? error.message : 'Unable to load more',
                    );
                  } finally {
                    setLoadMorePending(false);
                  }
                }}
              >
                {loadMorePending && <LoaderCircle className="spin" size={14} />} Load older edits
              </Button>
            )}
            {loadMoreError && (
              <p className="form-error" role="alert">
                {loadMoreError}
              </p>
            )}
          </div>
          <div className="history-diff">
            {preview.isPending ? (
              <div className="dialog-loading">
                <span className="spinner" /> Loading preview…
              </div>
            ) : preview.isError ? (
              <div className="empty-state compact">
                <CircleAlert size={24} />
                <p>{preview.error.message}</p>
                <Button onClick={() => void preview.refetch()}>Retry</Button>
              </div>
            ) : previewContent !== undefined ? (
              <DiffEditor
                original={history.content}
                modified={previewContent}
                language="latex"
                theme="hate-of-nature"
                options={{ readOnly: true, automaticLayout: true }}
              />
            ) : null}
          </div>
        </div>
      )}
      <div className="dialog-actions">
        <Button onClick={() => onOpenChange(false)}>Close</Button>
        <Button
          variant="primary"
          disabled={!selectedNode || selectedNode.id === history?.currentNodeId}
          onClick={() => selectedNode && onCheckout(selectedNode.id)}
        >
          Check out selected state
        </Button>
      </div>
    </Dialog>
  );
}

function BinaryPreview({ entry, projectId }: { entry: ProjectEntry; projectId: string }) {
  const url = appPath(`/api/v1/projects/${projectId}/entries/${entry.id}/content`);
  return (
    <div className="editor-empty">
      {entry.mimeType?.startsWith('image/') ? (
        <img
          src={url}
          alt={entry.name}
          style={{ maxWidth: '85%', maxHeight: '80%', objectFit: 'contain' }}
        />
      ) : (
        <File size={46} />
      )}
      <p>
        {entry.name} · {formatBytes(entry.size)}
      </p>
      <a className="button" href={url} download={entry.name}>
        Download file
      </a>
    </div>
  );
}

function ProblemsPanel({
  job,
  activeTab,
  onTab,
  onDiagnostic,
}: {
  job: CompileWithArtifact | null;
  activeTab: 'problems' | 'logs';
  onTab: (tab: 'problems' | 'logs') => void;
  onDiagnostic: (diagnostic: Diagnostic) => void;
}) {
  return (
    <div className="problems-panel">
      <div className="problems-tabs">
        <button
          className={activeTab === 'problems' ? 'active' : ''}
          onClick={() => onTab('problems')}
        >
          Problems ({job?.diagnostics.length ?? 0})
        </button>
        <button className={activeTab === 'logs' ? 'active' : ''} onClick={() => onTab('logs')}>
          Compiler log
        </button>
      </div>
      {activeTab === 'logs' ? (
        <pre className="compile-log">{job?.log || 'Compile the project to see its log.'}</pre>
      ) : job?.diagnostics.length ? (
        job.diagnostics.map((diagnostic, index) => (
          <div
            key={index}
            className={`diagnostic diagnostic-${diagnostic.severity}`}
            onClick={() => onDiagnostic(diagnostic)}
          >
            <CircleAlert size={14} />
            <span>{diagnostic.message}</span>
            <small>
              {diagnostic.file ?? 'main document'}
              {diagnostic.line ? `:${diagnostic.line}` : ''}
            </small>
          </div>
        ))
      ) : (
        <p className="hint" style={{ padding: 12 }}>
          No compiler problems.
        </p>
      )}
    </div>
  );
}

function HistoryDialog({
  open,
  onOpenChange,
  projectId,
  onRestored,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  onRestored: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [restorePending, setRestorePending] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreConfirm, setRestoreConfirm] = useState(false);
  const list = useQuery({
    queryKey: queryKeys.checkpoints(projectId),
    queryFn: () => api<{ checkpoints: Checkpoint[] }>(`/api/v1/projects/${projectId}/checkpoints`),
    enabled: open,
  });
  const files = useQuery({
    queryKey: ['checkpoint-files', selected],
    queryFn: () =>
      api<{ files: Array<{ path: string }> }>(
        `/api/v1/projects/${projectId}/checkpoints/${selected}/files`,
      ),
    enabled: Boolean(selected),
  });
  const diff = useQuery({
    queryKey: ['checkpoint-file', selected, path],
    queryFn: () =>
      api<{ historical: string; current: string | null }>(
        `/api/v1/projects/${projectId}/checkpoints/${selected}/file?path=${encodeURIComponent(path!)}`,
      ),
    enabled: Boolean(selected && path),
  });
  useEffect(() => {
    if (open && list.data?.checkpoints[0] && !selected) setSelected(list.data.checkpoints[0].id);
  }, [open, list.data]);
  useEffect(() => {
    if (files.data?.files[0]) setPath(files.data.files[0].path);
  }, [files.data]);
  return (
    <>
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        title="Version history"
        description="Automatic and compile checkpoints are retained for 30 days."
        wide
      >
        <div className="history-layout">
          <div className="history-list">
            {list.isPending ? (
              <div className="dialog-loading">
                <span className="spinner" /> Loading…
              </div>
            ) : list.isError ? (
              <div className="empty-state compact">
                <CircleAlert size={20} />
                <p>{list.error.message}</p>
                <Button onClick={() => void list.refetch()}>Retry</Button>
              </div>
            ) : list.data?.checkpoints.length ? (
              list.data.checkpoints.map((checkpoint) => (
                <button
                  key={checkpoint.id}
                  className={classNames('history-item', selected === checkpoint.id && 'active')}
                  onClick={() => setSelected(checkpoint.id)}
                >
                  {checkpoint.reason}
                  <small>
                    {formatRelative(checkpoint.createdAt)} · rev {checkpoint.sourceRevision}
                  </small>
                </button>
              ))
            ) : (
              <p className="hint">No checkpoints yet.</p>
            )}
          </div>
          <div className="history-list">
            {files.data?.files.map((file) => (
              <button
                key={file.path}
                className={classNames('history-item', path === file.path && 'active')}
                onClick={() => setPath(file.path)}
              >
                {file.path}
              </button>
            ))}
          </div>
          <div className="history-diff">
            {diff.data ? (
              <DiffEditor
                original={diff.data.historical}
                modified={diff.data.current ?? ''}
                language="latex"
                theme="hate-of-nature"
                options={{ readOnly: true, automaticLayout: true }}
              />
            ) : diff.isError ? (
              <div className="empty-state compact">
                <CircleAlert size={20} />
                <p>{diff.error.message}</p>
                <Button onClick={() => void diff.refetch()}>Retry</Button>
              </div>
            ) : (
              <div className="editor-empty">Select a checkpoint file.</div>
            )}
          </div>
        </div>
        <div className="dialog-actions">
          <Button variant="primary" disabled={!selected} onClick={() => setRestoreConfirm(true)}>
            Restore checkpoint
          </Button>
        </div>
      </Dialog>
      <Dialog
        open={restoreConfirm}
        onOpenChange={(next) => !restorePending && setRestoreConfirm(next)}
        title="Restore checkpoint?"
        description="Current files will be replaced. The checkpoint remains immutable and recreated files begin new edit histories."
      >
        {restoreError && (
          <p className="form-error" role="alert">
            {restoreError}
          </p>
        )}
        <div className="dialog-actions">
          <Button disabled={restorePending} onClick={() => setRestoreConfirm(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={restorePending || !selected}
            onClick={async () => {
              if (!selected) return;
              setRestorePending(true);
              setRestoreError(null);
              try {
                await api(`/api/v1/projects/${projectId}/checkpoints/${selected}/restore`, {
                  method: 'POST',
                });
                onRestored();
                setRestoreConfirm(false);
                onOpenChange(false);
              } catch (error) {
                setRestoreError(error instanceof Error ? error.message : 'Restore failed');
              } finally {
                setRestorePending(false);
              }
            }}
          >
            {restorePending && <LoaderCircle className="spin" size={15} />} Restore
          </Button>
        </div>
      </Dialog>
    </>
  );
}

async function updateProject(
  id: string,
  input: Partial<Project>,
  queryClient: ReturnType<typeof useQueryClient>,
) {
  await api(`/api/v1/projects/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
  await queryClient.invalidateQueries({ queryKey: queryKeys.project(id) });
}
function buildPaths(entries: ProjectEntry[]) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const cache = new Map<string, string>();
  const visit = (entry: ProjectEntry): string => {
    const value = cache.get(entry.id);
    if (value) return value;
    const path = entry.parentId ? `${visit(byId.get(entry.parentId)!)}/${entry.name}` : entry.name;
    cache.set(entry.id, path);
    return path;
  };
  for (const entry of entries) visit(entry);
  return cache;
}
function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

type WorkspacePreferences = {
  openTabs: string[];
  selectedId: string | null;
  problemsOpen: boolean;
  mobilePanel: 'files' | 'editor' | 'preview';
  filesVisible: boolean;
  previewVisible: boolean;
  treeWidth: number;
  editorWidth: number;
};

/** Grid columns for panes that are actually laid out (hidden panes are display:none). */
function buildWorkspaceColumns(
  filesVisible: boolean,
  previewVisible: boolean,
  treeWidth: number,
  editorWidth: number,
) {
  const columns: string[] = [];
  if (filesVisible) {
    columns.push(`minmax(0, ${treeWidth}px)`, '5px');
  }
  if (previewVisible) {
    columns.push(`minmax(0, ${editorWidth}px)`, '5px', 'minmax(0, 1fr)');
  } else {
    columns.push('minmax(0, 1fr)');
  }
  return columns.join(' ');
}

function summarizeEdit(before: string, after: string) {
  const beforeLines = before.split('\n').length;
  const afterLines = after.split('\n').length;
  const lineDelta = afterLines - beforeLines;
  if (lineDelta > 0) return `Added ${lineDelta} line${lineDelta === 1 ? '' : 's'}`;
  if (lineDelta < 0) return `Removed ${Math.abs(lineDelta)} line${lineDelta === -1 ? '' : 's'}`;
  const charDelta = after.length - before.length;
  if (charDelta > 0) return `Inserted ${charDelta} character${charDelta === 1 ? '' : 's'}`;
  if (charDelta < 0)
    return `Deleted ${Math.abs(charDelta)} character${charDelta === -1 ? '' : 's'}`;
  return 'Edited text';
}

function descendantIds(entryId: string, entries: ProjectEntry[]) {
  const result = new Set([entryId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of entries) {
      if (entry.parentId && result.has(entry.parentId) && !result.has(entry.id)) {
        result.add(entry.id);
        changed = true;
      }
    }
  }
  return result;
}

function omitKeys<T>(value: Record<string, T>, keys: Set<string>) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.has(key)));
}

function readWorkspacePreferences(projectId: string): WorkspacePreferences {
  const viewport = typeof window === 'undefined' ? 1440 : window.innerWidth;
  const defaults: WorkspacePreferences = {
    openTabs: [],
    selectedId: null,
    problemsOpen: true,
    mobilePanel: 'editor',
    filesVisible: true,
    previewVisible: true,
    treeWidth: viewport < 1100 ? 200 : 240,
    // Keep editor + preview both usable on iPad-class widths without a fake 1280 viewport.
    editorWidth: viewport < 1100 ? Math.max(300, Math.floor(viewport * 0.42)) : 620,
  };
  try {
    const value = JSON.parse(localStorage.getItem(`workspace:${projectId}`) ?? 'null') as Partial<
      typeof defaults
    > | null;
    const merged: WorkspacePreferences = value
      ? {
          ...defaults,
          ...value,
          openTabs: Array.isArray(value.openTabs) ? value.openTabs : defaults.openTabs,
          mobilePanel:
            value.mobilePanel === 'files' || value.mobilePanel === 'preview'
              ? value.mobilePanel
              : 'editor',
          filesVisible: value.filesVisible ?? defaults.filesVisible,
          previewVisible: value.previewVisible ?? defaults.previewVisible,
          problemsOpen: value.problemsOpen ?? defaults.problemsOpen,
          selectedId: value.selectedId ?? defaults.selectedId,
          treeWidth: value.treeWidth ?? defaults.treeWidth,
          editorWidth: value.editorWidth ?? defaults.editorWidth,
        }
      : defaults;
    return {
      ...merged,
      treeWidth: Math.min(420, Math.max(160, merged.treeWidth)),
      editorWidth: Math.min(Math.max(280, viewport - 200), Math.max(280, merged.editorWidth)),
    };
  } catch {
    return defaults;
  }
}
