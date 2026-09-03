import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  ArchiveRestore,
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  Copy,
  Download,
  FileCode2,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  GripVertical,
  Grid2X2,
  Import,
  Images,
  List,
  Menu,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Settings,
  Star,
  Tags,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type {
  LibraryFolder,
  LibraryProject,
  LibraryResponse,
  CompileJob,
  Project,
  ProjectTag,
  TagColor,
} from '@latex-workshop/contracts';
import { AppearanceMenu } from '../components/AppearanceMenu';
import { Button, IconButton } from '../components/Button';
import { Dialog } from '../components/Dialog';
import { Logo } from '../components/Logo';
import { ProjectThumbnail } from '../components/ProjectThumbnail';
import { Toast, type ToastState } from '../components/Toast';
import { AccountSettingsDialog } from './AccountPage';
import { api, appPath, queryKeys, uploadForm } from '../lib/api';
import { authClient } from '../lib/auth';
import { classNames, formatRelative } from '../lib/utils';

type View = 'all' | 'recent' | 'favorites' | 'folder' | 'tag' | 'trash';
type Sort = 'updated-desc' | 'updated-asc' | 'created-desc' | 'name-asc' | 'name-desc';
type Layout = 'grid' | 'list';
type ImportProgressState = {
  fileName: string;
  kind: 'Overleaf export' | 'project ZIP';
  phase: 'uploading' | 'processing' | 'complete' | 'error';
  percent: number;
  message?: string;
};
type ThumbnailProgressState = {
  completed: number;
  failed: number;
  total: number;
};
type RouteUpdate = Partial<{
  view: View | undefined;
  folder: string | undefined;
  tag: string | undefined;
  q: string | undefined;
  sort: Sort | undefined;
}>;
type Modal =
  | { type: 'create-project' }
  | { type: 'folder'; folder?: LibraryFolder; parentId: string | null }
  | { type: 'move-projects'; projectIds: string[] }
  | { type: 'move-folder'; folder: LibraryFolder }
  | { type: 'rename-project'; project: LibraryProject }
  | { type: 'tags'; projectIds: string[] }
  | { type: 'tag'; tag?: ProjectTag }
  | {
      type: 'confirm';
      title: string;
      description: string;
      confirmLabel: string;
      danger?: boolean;
      run: () => Promise<void>;
    };

const tagColors: TagColor[] = [
  'slate',
  'green',
  'cyan',
  'blue',
  'amber',
  'orange',
  'magenta',
  'red',
];

export function DashboardPage() {
  const navigate = useNavigate();
  const routeSearch = useSearch({ from: '/projects' });
  const queryClient = useQueryClient();
  const { data: session, isPending: sessionPending } = authClient.useSession();
  const view: View = routeSearch.view ?? 'all';
  const trash = view === 'trash';
  const sort: Sort = routeSearch.sort ?? 'updated-desc';
  const query = routeSearch.q ?? '';
  const [layout, setLayout] = useState<Layout>(() =>
    localStorage.getItem('library-layout') === 'list' ? 'list' : 'grid',
  );
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => readExpandedFolders());
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [lastSelected, setLastSelected] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal | null>(null);
  const [accountSettingsOpen, setAccountSettingsOpen] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<ImportProgressState | null>(null);
  const [dragLabel, setDragLabel] = useState<string | null>(null);
  const [thumbnailGeneration, setThumbnailGeneration] = useState(0);
  const [thumbnailProgress, setThumbnailProgress] = useState<ThumbnailProgressState | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const overleafImportRef = useRef<HTMLInputElement>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
    useSensor(KeyboardSensor),
  );

  useEffect(() => {
    if (!sessionPending && !session?.user) void navigate({ to: '/auth' });
  }, [session, sessionPending, navigate]);
  useEffect(() => localStorage.setItem('library-layout', layout), [layout]);
  useEffect(() => {
    if (expanded.size === 0) return;
    localStorage.setItem('library-expanded-folders', JSON.stringify([...expanded]));
  }, [expanded]);
  useEffect(() => {
    setSelection(new Set());
    setLastSelected(null);
    setSidebarOpen(false);
  }, [view, routeSearch.folder, routeSearch.tag]);

  const library = useQuery({
    queryKey: queryKeys.library(trash),
    queryFn: () => api<LibraryResponse>(`/api/v1/library?trash=${trash}`),
    enabled: Boolean(session?.user),
  });
  const data = library.data;
  const activeFolders = useMemo(
    () => (data?.folders ?? []).filter((folder) => !folder.trashedAt),
    [data?.folders],
  );
  const trashedFolders = useMemo(
    () => (data?.folders ?? []).filter((folder) => folder.trashedAt),
    [data?.folders],
  );
  const folderPath = useMemo(() => buildFolderPaths(data?.folders ?? []), [data?.folders]);
  const currentFolder = activeFolders.find((folder) => folder.id === routeSearch.folder) ?? null;
  const currentTag = data?.tags.find((tag) => tag.id === routeSearch.tag) ?? null;

  useEffect(() => {
    if (!activeFolders.length) return;
    setExpanded((current) => {
      const next = new Set(current);
      let changed = false;
      if (current.size === 0 && !localStorage.getItem('library-expanded-folders')) {
        for (const folder of activeFolders) next.add(folder.id);
        changed = true;
      }
      if (currentFolder) {
        const byId = new Map(activeFolders.map((folder) => [folder.id, folder]));
        let cursor: LibraryFolder | undefined = currentFolder;
        while (cursor) {
          if (!next.has(cursor.id)) {
            next.add(cursor.id);
            changed = true;
          }
          cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
        }
      }
      return changed ? next : current;
    });
  }, [activeFolders, currentFolder]);
  useEffect(() => {
    if (!currentFolder) return;
    document
      .querySelector(`[data-folder-id="${currentFolder.id}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [currentFolder]);

  const displayedProjects = useMemo(() => {
    let result = [...(data?.projects ?? [])];
    if (view === 'trash') result = result.filter((project) => !project.trashedByFolderId);
    const normalized = query.trim().toLocaleLowerCase();
    if (normalized) {
      result = result.filter((project) =>
        [
          project.name,
          folderPath.get(project.folderId ?? '') ?? '',
          ...project.tags.map((tag) => tag.name),
        ]
          .join(' ')
          .toLocaleLowerCase()
          .includes(normalized),
      );
    } else if (view === 'all') {
      result = result.filter((project) => !project.folderId);
    } else if (view === 'recent') {
      return result
        .filter((project) => project.lastOpenedAt)
        .sort(
          (left, right) =>
            new Date(right.lastOpenedAt!).getTime() - new Date(left.lastOpenedAt!).getTime(),
        )
        .slice(0, 20);
    } else if (view === 'favorites') {
      result = result.filter((project) => project.favorite);
    } else if (view === 'folder') {
      result = result.filter((project) => project.folderId === currentFolder?.id);
    } else if (view === 'tag') {
      result = result.filter((project) => project.tags.some((tag) => tag.id === currentTag?.id));
    }
    return result.sort((left, right) => compareProjects(left, right, sort));
  }, [data?.projects, query, view, currentFolder?.id, currentTag?.id, folderPath, sort]);

  const displayedFolders = useMemo(() => {
    if (!data) return [];
    if (query) {
      const normalized = query.trim().toLocaleLowerCase();
      return (trash ? trashedFolders : activeFolders).filter((folder) =>
        (folderPath.get(folder.id) ?? folder.name).toLocaleLowerCase().includes(normalized),
      );
    }
    if (view === 'all') return activeFolders.filter((folder) => !folder.parentId);
    if (view === 'folder')
      return activeFolders.filter((folder) => folder.parentId === currentFolder?.id);
    if (view === 'trash') {
      const trashedIds = new Set(trashedFolders.map((folder) => folder.id));
      return trashedFolders.filter(
        (folder) => !folder.parentId || !trashedIds.has(folder.parentId),
      );
    }
    return [];
  }, [query, data, trash, view, activeFolders, currentFolder?.id, trashedFolders, folderPath]);
  const thumbnailProjects = trash
    ? []
    : (data?.projects ?? []).filter((project) => project.mainFileId);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['library'] });
  const action = useMutation({
    mutationFn: (input: Record<string, unknown>) =>
      api<{ updated: number }>('/api/v1/library/projects/actions', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onMutate: (input) => {
      void queryClient.cancelQueries({ queryKey: queryKeys.library(trash) });
      const previous = queryClient.getQueryData<LibraryResponse>(queryKeys.library(trash));
      if (previous) {
        const ids = new Set(input.projectIds as string[]);
        queryClient.setQueryData<LibraryResponse>(queryKeys.library(trash), {
          ...previous,
          projects: previous.projects
            .map((project) => {
              if (!ids.has(project.id)) return project;
              if (input.action === 'move')
                return { ...project, folderId: (input.folderId as string | null) ?? null };
              if (input.action === 'favorite')
                return { ...project, favorite: Boolean(input.value) };
              if (input.action === 'add-tags') {
                const tags = previous.tags.filter((tag) =>
                  (input.tagIds as string[]).includes(tag.id),
                );
                return {
                  ...project,
                  tags: [
                    ...project.tags,
                    ...tags.filter((tag) => !project.tags.some((old) => old.id === tag.id)),
                  ],
                };
              }
              if (input.action === 'remove-tags')
                return {
                  ...project,
                  tags: project.tags.filter((tag) => !(input.tagIds as string[]).includes(tag.id)),
                };
              return project;
            })
            .filter((project) =>
              ['trash', 'restore', 'delete'].includes(String(input.action))
                ? !ids.has(project.id)
                : true,
            ),
        });
      }
      return { previous };
    },
    onError: (error, _input, context) => {
      if (context?.previous) queryClient.setQueryData(queryKeys.library(trash), context.previous);
      setToast({ id: Date.now(), tone: 'error', message: error.message });
    },
    onSuccess: (_result, input) => {
      void refresh();
      setSelection(new Set());
      setToast({
        id: Date.now(),
        tone: 'success',
        message: actionMessage(String(input.action), (input.projectIds as string[]).length),
      });
    },
  });
  const tagAssignment = useMutation({
    mutationFn: (input: { projectIds: string[]; tagId: string; value: boolean }) =>
      api<{ updated: number }>('/api/v1/library/projects/actions', {
        method: 'POST',
        body: JSON.stringify({
          action: input.value ? 'add-tags' : 'remove-tags',
          projectIds: input.projectIds,
          tagIds: [input.tagId],
        }),
      }),
    onMutate: (input) => {
      void queryClient.cancelQueries({ queryKey: queryKeys.library(trash) });
      queryClient.setQueryData<LibraryResponse>(queryKeys.library(trash), (current) => {
        if (!current) return current;
        const ids = new Set(input.projectIds);
        const tag = current.tags.find((item) => item.id === input.tagId);
        return {
          ...current,
          projects: current.projects.map((project) => {
            if (!ids.has(project.id)) return project;
            if (!input.value)
              return {
                ...project,
                tags: project.tags.filter((item) => item.id !== input.tagId),
              };
            if (!tag || project.tags.some((item) => item.id === input.tagId)) return project;
            return { ...project, tags: [...project.tags, tag] };
          }),
        };
      });
    },
    onError: (error) => {
      void refresh();
      setToast({ id: Date.now(), tone: 'error', message: error.message });
    },
    onSettled: () => void refresh(),
  });
  const folderMutation = useMutation({
    mutationFn: (operation: {
      method: 'POST' | 'PATCH' | 'DELETE';
      path: string;
      body?: unknown;
    }) =>
      api(operation.path, {
        method: operation.method,
        ...(operation.body ? { body: JSON.stringify(operation.body) } : {}),
      }),
    onSuccess: () => {
      setModal(null);
      void refresh();
    },
    onError: (error) => setToast({ id: Date.now(), tone: 'error', message: error.message }),
  });
  const projectMutation = useMutation({
    mutationFn: (operation: { path: string; method?: string; body?: unknown }) =>
      api<{ project: Project }>(operation.path, {
        method: operation.method ?? 'POST',
        ...(operation.body ? { body: JSON.stringify(operation.body) } : {}),
      }),
    onSuccess: () => {
      setModal(null);
      void refresh();
    },
    onError: (error) => setToast({ id: Date.now(), tone: 'error', message: error.message }),
  });
  const tagMutation = useMutation({
    mutationFn: (operation: { path: string; method: string; body?: unknown }) =>
      api(operation.path, {
        method: operation.method,
        ...(operation.body ? { body: JSON.stringify(operation.body) } : {}),
      }),
    onSuccess: () => {
      setModal(null);
      void refresh();
    },
    onError: (error) => setToast({ id: Date.now(), tone: 'error', message: error.message }),
  });

  function setRoute(next: RouteUpdate) {
    void navigate({
      to: '/projects',
      search: (old) => {
        const result = { ...old };
        for (const [key, value] of Object.entries(next)) {
          if (value === undefined) delete result[key as keyof typeof result];
          else Object.assign(result, { [key]: value });
        }
        if (next.view && next.view !== 'folder') delete result.folder;
        if (next.view && next.view !== 'tag') delete result.tag;
        return result;
      },
    });
  }

  function openView(nextView: View, id?: string) {
    setRoute({
      view: nextView,
      folder: nextView === 'folder' ? id : undefined,
      tag: nextView === 'tag' ? id : undefined,
      q: undefined,
    });
  }

  function toggleSelection(projectId: string, shiftKey: boolean) {
    const orderedIds = displayedProjects.map((project) => project.id);
    setSelection((current) => {
      const next = new Set(current);
      if (shiftKey && lastSelected) {
        const start = orderedIds.indexOf(lastSelected);
        const end = orderedIds.indexOf(projectId);
        if (start >= 0 && end >= 0)
          orderedIds
            .slice(Math.min(start, end), Math.max(start, end) + 1)
            .forEach((id) => next.add(id));
      } else if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
    setLastSelected(projectId);
  }

  function onDragStart(event: DragStartEvent) {
    const type = event.active.data.current?.type;
    const id = event.active.data.current?.id as string;
    if (type === 'project') {
      const count = selection.has(id) ? selection.size : 1;
      setDragLabel(count === 1 ? 'Move project' : `Move ${count} projects`);
    } else setDragLabel('Move folder');
  }

  function onDragEnd(event: DragEndEvent) {
    setDragLabel(null);
    const folderId = event.over?.data.current?.folderId as string | null | undefined;
    if (folderId === undefined) return;
    const type = event.active.data.current?.type;
    const id = event.active.data.current?.id as string;
    if (type === 'project') {
      const projectIds = selection.has(id) ? [...selection] : [id];
      action.mutate({ action: 'move', projectIds, folderId });
    } else if (type === 'folder' && id !== folderId) {
      folderMutation.mutate({
        method: 'PATCH',
        path: `/api/v1/library/folders/${id}`,
        body: { parentId: folderId },
      });
    }
  }

  async function importZip(event: ChangeEvent<HTMLInputElement>, overleaf: boolean) {
    const file = event.target.files?.[0];
    if (!file) return;
    const form = new FormData();
    form.append('file', file);
    const destination = view === 'folder' && currentFolder ? `?folderId=${currentFolder.id}` : '';
    setImporting(true);
    setImportProgress({
      fileName: file.name,
      kind: overleaf ? 'Overleaf export' : 'project ZIP',
      phase: 'uploading',
      percent: 0,
    });
    try {
      const result = await uploadForm<{ projects?: Project[]; project?: Project }>(
        `/api/v1/projects/import${overleaf ? '/overleaf' : ''}${destination}`,
        form,
        (percent) =>
          setImportProgress((current) =>
            current
              ? percent === null
                ? { ...current, phase: 'processing', percent: 100 }
                : { ...current, phase: 'uploading', percent }
              : current,
          ),
      );
      await refresh();
      const count = result.projects?.length ?? (result.project ? 1 : 0);
      setImportProgress((current) =>
        current
          ? {
              ...current,
              phase: 'complete',
              percent: 100,
              message: `${count} ${count === 1 ? 'project' : 'projects'} imported`,
            }
          : current,
      );
    } catch (error) {
      setImportProgress((current) =>
        current
          ? {
              ...current,
              phase: 'error',
              message: error instanceof Error ? error.message : 'Import failed',
            }
          : current,
      );
    } finally {
      setImporting(false);
      event.target.value = '';
    }
  }

  async function generateAllThumbnails() {
    if (!thumbnailProjects.length || thumbnailProgress) return;
    const total = thumbnailProjects.length;
    let completed = 0;
    let failed = 0;
    setThumbnailProgress({ completed, failed, total });
    for (const project of thumbnailProjects) {
      try {
        const { job } = await api<{ job: CompileJob }>(
          `/api/v1/projects/${project.id}/compilations`,
          {
            method: 'POST',
            body: JSON.stringify({ trigger: 'manual' }),
          },
        );
        const result = await waitForCompilation(project.id, job);
        if (result.status === 'succeeded') {
          completed += 1;
          queryClient.setQueryData<LibraryResponse>(queryKeys.library(false), (current) =>
            current
              ? {
                  ...current,
                  projects: current.projects.map((item) =>
                    item.id === project.id ? { ...item, previewJobId: result.id } : item,
                  ),
                }
              : current,
          );
          setThumbnailGeneration((generation) => generation + 1);
        } else failed += 1;
      } catch {
        failed += 1;
      }
      setThumbnailProgress({ completed, failed, total });
    }
    await refresh();
    setThumbnailProgress(null);
    setToast({
      id: Date.now(),
      tone: failed ? 'error' : 'success',
      message: failed
        ? `Generated ${completed} of ${total} thumbnails; ${failed} failed.`
        : `Generated ${completed} ${completed === 1 ? 'thumbnail' : 'thumbnails'}.`,
    });
  }

  if (sessionPending || !session?.user)
    return (
      <main className="screen-center">
        <span className="spinner" />
        <p>Loading projects…</p>
      </main>
    );

  const heading = query
    ? `Search results for “${query}”`
    : view === 'folder'
      ? (currentFolder?.name ?? 'Folder')
      : view === 'tag'
        ? (currentTag?.name ?? 'Tag')
        : view === 'favorites'
          ? 'Favorites'
          : view === 'recent'
            ? 'Recent'
            : view === 'trash'
              ? 'Trash'
              : 'Library';

  return (
    <DndContext
      sensors={sensors}
      onDragStart={onDragStart}
      onDragOver={(event) => {
        const folderId = event.over?.data.current?.folderId as string | undefined;
        if (folderId) setExpanded((old) => new Set(old).add(folderId));
      }}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDragLabel(null)}
    >
      <div className="library-shell">
        <header className="app-header">
          <IconButton
            label="Open library navigation"
            className="library-menu-button"
            onClick={() => setSidebarOpen(true)}
          >
            <Menu size={18} />
          </IconButton>
          <Logo />
          <div className="app-header-actions">
            <AppearanceMenu />
            <span className="hint">{session.user.email}</span>
            <LibrarySettingsMenu
              generating={thumbnailProgress}
              projectCount={thumbnailProjects.length}
              onGenerate={() => void generateAllThumbnails()}
              onAccountSettings={() => setAccountSettingsOpen(true)}
            />
          </div>
        </header>

        <aside className={classNames('library-sidebar', sidebarOpen && 'open')}>
          <div className="library-sidebar-mobile-header">
            <span>Library</span>
            <IconButton label="Close navigation" onClick={() => setSidebarOpen(false)}>
              <X size={18} />
            </IconButton>
          </div>
          <nav aria-label="Project library">
            <SidebarItem
              icon={<Clock3 size={16} />}
              active={view === 'recent'}
              label="Recent"
              onClick={() => openView('recent')}
            />
            <SidebarItem
              icon={<Star size={16} />}
              active={view === 'favorites'}
              label="Favorites"
              onClick={() => openView('favorites')}
            />
            <RootDropItem active={view === 'all'} onClick={() => openView('all')} />
          </nav>
          <div className="sidebar-section-heading">
            <span>Folders</span>
            <IconButton
              label="New folder"
              onClick={() => setModal({ type: 'folder', parentId: null })}
            >
              <Plus size={14} />
            </IconButton>
          </div>
          <div className="sidebar-tree">
            {activeFolders
              .filter((folder) => !folder.parentId)
              .map((folder) => (
                <FolderTreeRow
                  key={folder.id}
                  folder={folder}
                  folders={activeFolders}
                  activeId={currentFolder?.id ?? null}
                  expanded={expanded}
                  onExpanded={setExpanded}
                  onOpen={(id) => openView('folder', id)}
                  onRename={(target) =>
                    setModal({
                      type: 'folder',
                      folder: target,
                      parentId: target.parentId,
                    })
                  }
                  onMove={(target) => setModal({ type: 'move-folder', folder: target })}
                  onCreate={(target) => setModal({ type: 'folder', parentId: target.id })}
                  onTrash={(target) => confirmFolderTrash(target)}
                />
              ))}
            {!activeFolders.length && <p className="sidebar-empty">No folders yet</p>}
          </div>
          <div className="sidebar-section-heading">
            <span>Tags</span>
            <IconButton label="New tag" onClick={() => setModal({ type: 'tag' })}>
              <Plus size={14} />
            </IconButton>
          </div>
          <div className="sidebar-tags">
            {data?.tags.map((tag) => (
              <div
                key={tag.id}
                className={classNames('sidebar-tag-row', currentTag?.id === tag.id && 'active')}
              >
                <button onClick={() => openView('tag', tag.id)}>
                  <span className={`tag-dot tag-${tag.color}`} />
                  <span>{tag.name}</span>
                </button>
                <ItemMenu label={`${tag.name} tag actions`}>
                  <DropdownItem
                    icon={<Pencil size={14} />}
                    onSelect={() => setModal({ type: 'tag', tag })}
                  >
                    Rename or recolor
                  </DropdownItem>
                  <DropdownItem
                    danger
                    icon={<Trash2 size={14} />}
                    onSelect={() =>
                      setModal({
                        type: 'confirm',
                        title: `Delete “${tag.name}”?`,
                        description:
                          'The tag will be removed from every project. Projects will not be deleted.',
                        confirmLabel: 'Delete tag',
                        danger: true,
                        run: async () => {
                          await tagMutation.mutateAsync({
                            path: `/api/v1/library/tags/${tag.id}`,
                            method: 'DELETE',
                          });
                        },
                      })
                    }
                  >
                    Delete tag
                  </DropdownItem>
                </ItemMenu>
              </div>
            ))}
            {!data?.tags.length && <p className="sidebar-empty">No tags yet</p>}
          </div>
          <nav className="sidebar-trash">
            <SidebarItem
              icon={<Trash2 size={16} />}
              active={view === 'trash'}
              label="Trash"
              onClick={() => openView('trash')}
            />
          </nav>
        </aside>
        {sidebarOpen && (
          <button
            className="sidebar-scrim"
            aria-label="Close navigation"
            onClick={() => setSidebarOpen(false)}
          />
        )}

        <main className="library-main">
          <div className="library-heading-row">
            <div className="library-heading">
              {view === 'folder' && currentFolder && (
                <Breadcrumbs folder={currentFolder} folders={activeFolders} onOpen={openView} />
              )}
              <h1>{heading}</h1>
              <p>
                {displayedProjects.length} {displayedProjects.length === 1 ? 'project' : 'projects'}
              </p>
            </div>
            {!trash && (
              <CreateMenu
                importing={importing}
                onProject={() => setModal({ type: 'create-project' })}
                onFolder={() => setModal({ type: 'folder', parentId: currentFolder?.id ?? null })}
                onImport={() => importRef.current?.click()}
                onOverleaf={() => overleafImportRef.current?.click()}
              />
            )}
          </div>
          <input
            ref={importRef}
            hidden
            type="file"
            accept=".zip,application/zip"
            onChange={(event) => void importZip(event, false)}
          />
          <input
            ref={overleafImportRef}
            hidden
            type="file"
            accept=".zip,application/zip"
            onChange={(event) => void importZip(event, true)}
          />

          <div className="library-toolbar">
            <label className="searchbox library-search">
              <Search size={16} />
              <span className="sr-only">Search projects</span>
              <input
                className="input"
                placeholder="Search projects, folders, or tags"
                value={query}
                onChange={(event) => setRoute({ q: event.target.value || undefined })}
              />
            </label>
            <select
              className="select library-sort"
              aria-label="Sort projects"
              value={sort}
              onChange={(event) => setRoute({ sort: event.target.value as Sort })}
              disabled={view === 'recent' && !query}
            >
              <option value="updated-desc">Recently modified</option>
              <option value="updated-asc">Least recently modified</option>
              <option value="created-desc">Recently created</option>
              <option value="name-asc">Name A–Z</option>
              <option value="name-desc">Name Z–A</option>
            </select>
            <div className="view-toggle" aria-label="Project layout">
              <IconButton
                label="Grid view"
                aria-pressed={layout === 'grid'}
                onClick={() => setLayout('grid')}
              >
                <Grid2X2 size={16} />
              </IconButton>
              <IconButton
                label="List view"
                aria-pressed={layout === 'list'}
                onClick={() => setLayout('list')}
              >
                <List size={17} />
              </IconButton>
            </div>
          </div>

          {selection.size > 0 && !trash && (
            <BulkBar
              count={selection.size}
              allSelected={selection.size === displayedProjects.length}
              onSelectAll={() =>
                setSelection(new Set(displayedProjects.map((project) => project.id)))
              }
              onClear={() => setSelection(new Set())}
              onMove={() => setModal({ type: 'move-projects', projectIds: [...selection] })}
              onTags={() => setModal({ type: 'tags', projectIds: [...selection] })}
              onFavorite={() =>
                action.mutate({
                  action: 'favorite',
                  projectIds: [...selection],
                  value: true,
                })
              }
              onTrash={() => confirmProjectTrash([...selection])}
            />
          )}

          {library.isPending ? (
            <LibrarySkeleton layout={layout} />
          ) : library.isError ? (
            <LibraryEmpty
              icon={<FileCode2 size={38} />}
              title="Couldn’t load the library"
              description={library.error.message}
              action={<Button onClick={() => void library.refetch()}>Try again</Button>}
            />
          ) : displayedFolders.length || displayedProjects.length ? (
            <>
              {displayedFolders.length > 0 && (
                <section
                  className="folder-collection"
                  aria-label={trash ? 'Trashed folders' : 'Folders'}
                >
                  {displayedFolders.map((folder) => (
                    <FolderTile
                      key={folder.id}
                      folder={folder}
                      trash={trash}
                      onOpen={() => !trash && openView('folder', folder.id)}
                      onRename={() =>
                        setModal({
                          type: 'folder',
                          folder,
                          parentId: folder.parentId,
                        })
                      }
                      onMove={() => setModal({ type: 'move-folder', folder })}
                      onCreate={() => setModal({ type: 'folder', parentId: folder.id })}
                      onTrash={() => confirmFolderTrash(folder)}
                      onRestore={() =>
                        folderMutation.mutate({
                          method: 'POST',
                          path: `/api/v1/library/folders/${folder.id}/restore`,
                        })
                      }
                      onDelete={() => confirmFolderDelete(folder)}
                    />
                  ))}
                </section>
              )}
              {displayedProjects.length > 0 && (
                <section
                  className={layout === 'grid' ? 'library-project-grid' : 'project-list'}
                  aria-label="Projects"
                >
                  {layout === 'list' && <ProjectListHeader />}
                  {displayedProjects.map((project) => (
                    <ProjectItem
                      key={project.id}
                      project={project}
                      layout={layout}
                      trash={trash}
                      selected={selection.has(project.id)}
                      location={folderPath.get(project.folderId ?? '') ?? 'Library root'}
                      thumbnailGeneration={thumbnailGeneration}
                      onSelect={(shift) => toggleSelection(project.id, shift)}
                      onFavorite={() =>
                        action.mutate({
                          action: 'favorite',
                          projectIds: [project.id],
                          value: !project.favorite,
                        })
                      }
                      onRename={() => setModal({ type: 'rename-project', project })}
                      onDuplicate={() =>
                        projectMutation.mutate({
                          path: `/api/v1/projects/${project.id}/duplicate`,
                        })
                      }
                      onMove={() => setModal({ type: 'move-projects', projectIds: [project.id] })}
                      onTags={() => setModal({ type: 'tags', projectIds: [project.id] })}
                      onTrash={() => confirmProjectTrash([project.id])}
                      onRestore={() =>
                        action.mutate({ action: 'restore', projectIds: [project.id] })
                      }
                      onDelete={() => confirmProjectDelete([project.id])}
                    />
                  ))}
                </section>
              )}
            </>
          ) : (
            <LibraryEmpty
              icon={
                trash ? (
                  <Trash2 size={38} />
                ) : query ? (
                  <Search size={38} />
                ) : (
                  <FolderOpen size={38} />
                )
              }
              title={
                trash
                  ? 'Trash is empty'
                  : query
                    ? 'No matching projects'
                    : view === 'favorites'
                      ? 'No favorites yet'
                      : view === 'recent'
                        ? 'No recently opened projects'
                        : 'Nothing here yet'
              }
              description={
                trash
                  ? 'Deleted projects and folders will appear here.'
                  : query
                    ? 'Try a different name, folder, or tag.'
                    : 'Create a project or move one here to get started.'
              }
              action={
                !trash && !query ? (
                  <Button variant="primary" onClick={() => setModal({ type: 'create-project' })}>
                    New project
                  </Button>
                ) : undefined
              }
            />
          )}
        </main>
        <DragOverlay>
          {dragLabel ? (
            <div className="drag-overlay">
              <GripVertical size={15} />
              {dragLabel}
            </div>
          ) : null}
        </DragOverlay>
      </div>

      {modal?.type === 'create-project' && (
        <ProjectCreateDialog
          destination={currentFolder}
          pending={projectMutation.isPending}
          onClose={() => setModal(null)}
          onCreate={async (name) => {
            const { project } = await projectMutation.mutateAsync({
              path: '/api/v1/projects',
              body: { name, folderId: currentFolder?.id ?? null },
            });
            setModal(null);
            await navigate({ to: '/projects/$projectId', params: { projectId: project.id } });
          }}
        />
      )}
      {modal?.type === 'folder' && (
        <FolderEditDialog
          folder={modal.folder}
          parentId={modal.parentId}
          pending={folderMutation.isPending}
          onClose={() => setModal(null)}
          onSave={(name) =>
            folderMutation.mutate({
              method: modal.folder ? 'PATCH' : 'POST',
              path: modal.folder
                ? `/api/v1/library/folders/${modal.folder.id}`
                : '/api/v1/library/folders',
              body: modal.folder ? { name } : { name, parentId: modal.parentId },
            })
          }
        />
      )}
      {modal?.type === 'move-projects' && (
        <MoveDialog
          title={
            modal.projectIds.length === 1
              ? 'Move project'
              : `Move ${modal.projectIds.length} projects`
          }
          folders={activeFolders}
          pending={false}
          onClose={() => setModal(null)}
          onMove={(folderId) => {
            setSelection(new Set());
            action.mutate({ action: 'move', projectIds: modal.projectIds, folderId });
            setModal(null);
          }}
        />
      )}
      {modal?.type === 'move-folder' && (
        <MoveDialog
          title={`Move “${modal.folder.name}”`}
          folders={activeFolders.filter(
            (folder) =>
              folder.id !== modal.folder.id &&
              !isDescendant(folder.id, modal.folder.id, activeFolders),
          )}
          pending={folderMutation.isPending}
          onClose={() => setModal(null)}
          onMove={(parentId) =>
            folderMutation.mutate({
              method: 'PATCH',
              path: `/api/v1/library/folders/${modal.folder.id}`,
              body: { parentId },
            })
          }
        />
      )}
      {modal?.type === 'rename-project' && (
        <RenameProjectDialog
          project={modal.project}
          pending={projectMutation.isPending}
          onClose={() => setModal(null)}
          onSave={(name) =>
            projectMutation.mutate({
              path: `/api/v1/projects/${modal.project.id}`,
              method: 'PATCH',
              body: { name },
            })
          }
        />
      )}
      {modal?.type === 'tags' && data && (
        <TagAssignmentDialog
          projectIds={modal.projectIds}
          projects={data.projects}
          tags={data.tags}
          onClose={() => setModal(null)}
          onToggle={(tagId, value) =>
            tagAssignment.mutate({ projectIds: modal.projectIds, tagId, value })
          }
          onCreateTag={() => setModal({ type: 'tag' })}
        />
      )}
      {modal?.type === 'tag' && (
        <TagEditDialog
          tag={modal.tag}
          pending={tagMutation.isPending}
          onClose={() => setModal(null)}
          onSave={(name, color) =>
            tagMutation.mutate({
              path: modal.tag ? `/api/v1/library/tags/${modal.tag.id}` : '/api/v1/library/tags',
              method: modal.tag ? 'PATCH' : 'POST',
              body: { name, color },
            })
          }
        />
      )}
      {modal?.type === 'confirm' && (
        <ConfirmDialog
          modal={modal}
          pending={folderMutation.isPending || tagMutation.isPending || action.isPending}
          onClose={() => setModal(null)}
        />
      )}
      {importProgress && (
        <ImportProgress state={importProgress} onDismiss={() => setImportProgress(null)} />
      )}
      <AccountSettingsDialog open={accountSettingsOpen} onOpenChange={setAccountSettingsOpen} />
      {toast && <Toast toast={toast} dismiss={() => setToast(null)} />}
    </DndContext>
  );

  function confirmProjectTrash(projectIds: string[]) {
    setModal({
      type: 'confirm',
      title:
        projectIds.length === 1
          ? 'Move project to trash?'
          : `Move ${projectIds.length} projects to trash?`,
      description: 'You can restore them from Trash before they are permanently removed.',
      confirmLabel: 'Move to trash',
      danger: true,
      run: async () => {
        await action.mutateAsync({ action: 'trash', projectIds });
      },
    });
  }

  function confirmProjectDelete(projectIds: string[]) {
    setModal({
      type: 'confirm',
      title:
        projectIds.length === 1
          ? 'Delete project forever?'
          : `Delete ${projectIds.length} projects forever?`,
      description: 'Source files, history, and compiled artifacts will be permanently deleted.',
      confirmLabel: 'Delete forever',
      danger: true,
      run: async () => {
        await action.mutateAsync({ action: 'delete', projectIds });
      },
    });
  }

  function confirmFolderTrash(folder: LibraryFolder) {
    setModal({
      type: 'confirm',
      title: `Move “${folder.name}” to trash?`,
      description:
        'Its subfolders and active projects will move to Trash together and can be restored as a unit.',
      confirmLabel: 'Move to trash',
      danger: true,
      run: async () => {
        await folderMutation.mutateAsync({
          method: 'DELETE',
          path: `/api/v1/library/folders/${folder.id}`,
        });
      },
    });
  }

  function confirmFolderDelete(folder: LibraryFolder) {
    setModal({
      type: 'confirm',
      title: `Delete “${folder.name}” forever?`,
      description:
        'The folder tree and every remaining project inside it will be permanently deleted.',
      confirmLabel: 'Delete forever',
      danger: true,
      run: async () => {
        await folderMutation.mutateAsync({
          method: 'DELETE',
          path: `/api/v1/library/folders/${folder.id}?permanent=true`,
        });
      },
    });
  }
}

function ImportProgress({
  state,
  onDismiss,
}: {
  state: ImportProgressState;
  onDismiss: () => void;
}) {
  const pending = state.phase === 'uploading' || state.phase === 'processing';
  const status =
    state.phase === 'uploading'
      ? `Uploading… ${state.percent}%`
      : state.phase === 'processing'
        ? 'Creating projects…'
        : state.phase === 'complete'
          ? (state.message ?? 'Import complete')
          : (state.message ?? 'Import failed');
  return (
    <aside
      className={`import-progress import-progress-${state.phase}`}
      aria-live="polite"
      aria-label={`${state.kind} import`}
    >
      <div className="import-progress-heading">
        <div>
          <strong>{state.kind}</strong>
          <span title={state.fileName}>{state.fileName}</span>
        </div>
        {!pending && (
          <button type="button" onClick={onDismiss} aria-label="Dismiss import status">
            <X size={16} />
          </button>
        )}
      </div>
      <progress
        aria-label={status}
        max={100}
        {...(state.phase === 'processing' ? {} : { value: state.percent })}
      />
      <p>{status}</p>
    </aside>
  );
}

function SidebarItem({
  icon,
  active,
  label,
  onClick,
}: {
  icon: ReactNode;
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button className={classNames('sidebar-item', active && 'active')} onClick={onClick}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

function RootDropItem({ active, onClick }: { active: boolean; onClick: () => void }) {
  const { setNodeRef, isOver } = useDroppable({
    id: 'folder:root',
    data: { folderId: null },
  });
  return (
    <button
      ref={setNodeRef}
      className={classNames('sidebar-item', active && 'active', isOver && 'drop-target')}
      onClick={onClick}
    >
      <FolderOpen size={16} />
      <span>Library</span>
    </button>
  );
}

function FolderTreeRow(props: {
  folder: LibraryFolder;
  folders: LibraryFolder[];
  activeId: string | null;
  expanded: Set<string>;
  onExpanded: (value: Set<string>) => void;
  onOpen: (id: string) => void;
  onRename: (folder: LibraryFolder) => void;
  onMove: (folder: LibraryFolder) => void;
  onCreate: (folder: LibraryFolder) => void;
  onTrash: (folder: LibraryFolder) => void;
  depth?: number;
}) {
  const {
    folder,
    folders,
    activeId,
    expanded,
    onExpanded,
    onOpen,
    onRename,
    onMove,
    onCreate,
    onTrash,
    depth = 0,
  } = props;
  const children = folders.filter((candidate) => candidate.parentId === folder.id);
  const isOpen = expanded.has(folder.id);
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    transform,
    isDragging,
  } = useDraggable({
    id: `folder:${folder.id}`,
    data: { type: 'folder', id: folder.id },
  });
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `folder-drop:${folder.id}`,
    data: { folderId: folder.id },
  });
  const setRef = (node: HTMLDivElement | null) => {
    setDragRef(node);
    setDropRef(node);
  };
  return (
    <div className="folder-tree-node">
      <div
        ref={setRef}
        data-folder-id={folder.id}
        className={classNames(
          'folder-tree-row',
          activeId === folder.id && 'active',
          isOver && 'drop-target',
          isDragging && 'dragging',
        )}
        style={{
          transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
        }}
      >
        <div className="folder-tree-lead" style={{ paddingLeft: 2 + depth * 16 }}>
          <button
            className="tree-expander"
            aria-label={
              children.length
                ? isOpen
                  ? `Collapse ${folder.name}`
                  : `Expand ${folder.name}`
                : undefined
            }
            onClick={() => {
              const next = new Set(expanded);
              if (next.has(folder.id)) next.delete(folder.id);
              else next.add(folder.id);
              onExpanded(next);
            }}
            disabled={!children.length}
          >
            {children.length ? (
              isOpen ? (
                <ChevronDown size={13} />
              ) : (
                <ChevronRight size={13} />
              )
            ) : (
              <span />
            )}
          </button>
          <button
            className="folder-tree-link"
            title={folder.name}
            aria-current={activeId === folder.id ? 'page' : undefined}
            onClick={() => onOpen(folder.id)}
          >
            {isOpen && children.length ? <FolderOpen size={15} /> : <Folder size={15} />}
            <span>{folder.name}</span>
          </button>
        </div>
        <div className="folder-tree-actions">
          <button
            className="tree-drag-handle"
            aria-label={`Move ${folder.name}`}
            {...listeners}
            {...attributes}
          >
            <GripVertical size={13} />
          </button>
          <ItemMenu label={`${folder.name} folder actions`}>
            <DropdownItem icon={<FolderPlus size={14} />} onSelect={() => onCreate(folder)}>
              New subfolder
            </DropdownItem>
            <DropdownItem icon={<Pencil size={14} />} onSelect={() => onRename(folder)}>
              Rename
            </DropdownItem>
            <DropdownItem icon={<FolderInput size={14} />} onSelect={() => onMove(folder)}>
              Move
            </DropdownItem>
            <DropdownItem danger icon={<Trash2 size={14} />} onSelect={() => onTrash(folder)}>
              Move to trash
            </DropdownItem>
          </ItemMenu>
        </div>
      </div>
      {isOpen && children.length > 0 && (
        <div className="folder-tree-children">
          {children.map((child) => (
            <FolderTreeRow key={child.id} {...props} folder={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

function FolderTile({
  folder,
  trash,
  onOpen,
  onRename,
  onMove,
  onCreate,
  onTrash,
  onRestore,
  onDelete,
}: {
  folder: LibraryFolder;
  trash: boolean;
  onOpen: () => void;
  onRename: () => void;
  onMove: () => void;
  onCreate: () => void;
  onTrash: () => void;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    transform,
    isDragging,
  } = useDraggable({
    id: `folder-tile:${folder.id}`,
    data: { type: 'folder', id: folder.id },
    disabled: trash,
  });
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `folder-tile-drop:${folder.id}`,
    data: { folderId: folder.id },
    disabled: trash,
  });
  const setRef = (node: HTMLDivElement | null) => {
    setDragRef(node);
    setDropRef(node);
  };
  return (
    <article
      ref={setRef}
      className={classNames('folder-tile', isOver && 'drop-target', isDragging && 'dragging')}
      style={{
        transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
      }}
    >
      <button className="folder-tile-open" title={folder.name} onClick={onOpen} disabled={trash}>
        <Folder size={20} />
        <span>{folder.name}</span>
      </button>
      {!trash && (
        <button
          className="folder-drag-handle"
          aria-label={`Move ${folder.name}`}
          {...listeners}
          {...attributes}
        >
          <GripVertical size={14} />
        </button>
      )}
      <ItemMenu label={`${folder.name} folder actions`}>
        {trash ? (
          <>
            <DropdownItem icon={<ArchiveRestore size={14} />} onSelect={onRestore}>
              Restore folder
            </DropdownItem>
            <DropdownItem danger icon={<Trash2 size={14} />} onSelect={onDelete}>
              Delete forever
            </DropdownItem>
          </>
        ) : (
          <>
            <DropdownItem icon={<FolderPlus size={14} />} onSelect={onCreate}>
              New subfolder
            </DropdownItem>
            <DropdownItem icon={<Pencil size={14} />} onSelect={onRename}>
              Rename
            </DropdownItem>
            <DropdownItem icon={<FolderInput size={14} />} onSelect={onMove}>
              Move
            </DropdownItem>
            <DropdownItem danger icon={<Trash2 size={14} />} onSelect={onTrash}>
              Move to trash
            </DropdownItem>
          </>
        )}
      </ItemMenu>
    </article>
  );
}

function ProjectItem(props: {
  project: LibraryProject;
  layout: Layout;
  trash: boolean;
  selected: boolean;
  location: string;
  thumbnailGeneration: number;
  onSelect: (shift: boolean) => void;
  onFavorite: () => void;
  onRename: () => void;
  onDuplicate: () => void;
  onMove: () => void;
  onTags: () => void;
  onTrash: () => void;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const { project, layout, trash, selected, location } = props;
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `project:${project.id}`,
    data: { type: 'project', id: project.id },
    disabled: trash,
  });
  const visibleTags = layout === 'grid' ? 3 : 4;
  return (
    <article
      ref={setNodeRef}
      className={classNames(
        layout === 'grid' ? 'library-project-card' : 'project-list-row',
        selected && 'selected',
        isDragging && 'dragging',
      )}
      style={{
        transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
      }}
    >
      {layout === 'grid' && (
        <ProjectThumbnail
          projectId={project.id}
          jobId={project.previewJobId}
          generate={props.thumbnailGeneration}
        />
      )}
      <div className="project-select-cell">
        <input
          type="checkbox"
          aria-label={`Select ${project.name}`}
          checked={selected}
          onChange={() => undefined}
          onClick={(event) => {
            event.stopPropagation();
            props.onSelect(event.shiftKey);
          }}
        />
      </div>
      {!trash && (
        <button
          className={classNames('project-favorite', project.favorite && 'active')}
          aria-label={
            project.favorite
              ? `Remove ${project.name} from favorites`
              : `Add ${project.name} to favorites`
          }
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            props.onFavorite();
          }}
        >
          <Star size={15} fill={project.favorite ? 'currentColor' : 'none'} />
        </button>
      )}
      <Link
        to="/projects/$projectId"
        params={{ projectId: project.id }}
        className="project-primary"
      >
        {layout === 'list' && <FileCode2 size={17} />}
        <div>
          <h2>{project.name}</h2>
          {layout === 'grid' && <p>Updated {formatRelative(project.updatedAt)}</p>}
        </div>
      </Link>
      <div className="project-tags-cell">
        {project.tags.slice(0, visibleTags).map((tag) => (
          <span key={tag.id} className={`project-tag tag-${tag.color}`}>
            <span className="tag-dot" />
            {tag.name}
          </span>
        ))}
        {project.tags.length > visibleTags && (
          <span className="tag-more">+{project.tags.length - visibleTags}</span>
        )}
      </div>
      {layout === 'list' && (
        <>
          <span className="project-location" title={location}>
            {location}
          </span>
          <span className="project-updated">{formatRelative(project.updatedAt)}</span>
        </>
      )}
      <span className="project-compiler">{formatCompiler(project.compiler)}</span>
      {!trash && (
        <button
          className="project-drag-handle"
          aria-label={`Move ${project.name}`}
          {...listeners}
          {...attributes}
        >
          <GripVertical size={15} />
        </button>
      )}
      <span className="project-item-menu">
        <ItemMenu label={`${project.name} actions`}>
          {trash ? (
            <>
              <DropdownItem icon={<ArchiveRestore size={14} />} onSelect={props.onRestore}>
                Restore
              </DropdownItem>
              <DropdownItem danger icon={<Trash2 size={14} />} onSelect={props.onDelete}>
                Delete forever
              </DropdownItem>
            </>
          ) : (
            <>
              <DropdownItem icon={<Star size={14} />} onSelect={props.onFavorite}>
                {project.favorite ? 'Remove from favorites' : 'Add to favorites'}
              </DropdownItem>
              <DropdownItem icon={<Pencil size={14} />} onSelect={props.onRename}>
                Rename
              </DropdownItem>
              <DropdownItem icon={<Copy size={14} />} onSelect={props.onDuplicate}>
                Duplicate
              </DropdownItem>
              <DropdownItem icon={<FolderInput size={14} />} onSelect={props.onMove}>
                Move
              </DropdownItem>
              <DropdownItem icon={<Tags size={14} />} onSelect={props.onTags}>
                Manage tags
              </DropdownItem>
              <DropdownMenu.Item className="dropdown-item" asChild>
                <a href={appPath(`/api/v1/projects/${project.id}/export`)} download>
                  <Download size={14} /> Export ZIP
                </a>
              </DropdownMenu.Item>
              <DropdownItem danger icon={<Trash2 size={14} />} onSelect={props.onTrash}>
                Move to trash
              </DropdownItem>
            </>
          )}
        </ItemMenu>
      </span>
    </article>
  );
}

function ProjectListHeader() {
  return (
    <div className="project-list-header" aria-hidden="true">
      <span />
      <span>Project</span>
      <span>Tags</span>
      <span>Location</span>
      <span>Modified</span>
      <span>Compiler</span>
      <span />
    </div>
  );
}

function Breadcrumbs({
  folder,
  folders,
  onOpen,
}: {
  folder: LibraryFolder;
  folders: LibraryFolder[];
  onOpen: (view: View, id?: string) => void;
}) {
  const byId = new Map(folders.map((item) => [item.id, item]));
  const trail: LibraryFolder[] = [];
  let cursor: LibraryFolder | undefined = folder;
  while (cursor) {
    trail.unshift(cursor);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  return (
    <nav className="library-breadcrumbs" aria-label="Folder path">
      <button onClick={() => onOpen('all')}>Library</button>
      {trail.map((item) => (
        <span key={item.id}>
          <ChevronRight size={13} />
          <button
            aria-current={item.id === folder.id ? 'page' : undefined}
            onClick={() => onOpen('folder', item.id)}
          >
            {item.name}
          </button>
        </span>
      ))}
    </nav>
  );
}

function ItemMenu({ label, children }: { label: string; children: ReactNode }) {
  return (
    <DropdownMenu.Root modal>
      <DropdownMenu.Trigger asChild>
        <IconButton label={label}>
          <MoreHorizontal size={17} />
        </IconButton>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="dropdown"
          align="end"
          side="bottom"
          sideOffset={6}
          collisionPadding={10}
        >
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function LibrarySettingsMenu({
  generating,
  projectCount,
  onGenerate,
  onAccountSettings,
}: {
  generating: ThumbnailProgressState | null;
  projectCount: number;
  onGenerate: () => void;
  onAccountSettings: () => void;
}) {
  const processed = generating ? generating.completed + generating.failed : 0;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <IconButton label="Library settings">
          <Settings size={18} />
        </IconButton>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="dropdown" align="end" sideOffset={6}>
          <DropdownMenu.Item className="dropdown-item" onSelect={onAccountSettings}>
            <Settings size={15} />
            Account settings
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="dropdown-separator" />
          <DropdownMenu.Item
            className="dropdown-item"
            disabled={Boolean(generating) || projectCount === 0}
            onSelect={onGenerate}
          >
            <Images size={15} />
            {generating
              ? `Generating thumbnails (${processed}/${generating.total})…`
              : 'Generate all thumbnails'}
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function DropdownItem({
  icon,
  children,
  danger,
  onSelect,
}: {
  icon: ReactNode;
  children: ReactNode;
  danger?: boolean;
  onSelect: () => void;
}) {
  return (
    <DropdownMenu.Item
      className={classNames('dropdown-item', danger && 'dropdown-danger')}
      onSelect={onSelect}
    >
      {icon}
      {children}
    </DropdownMenu.Item>
  );
}

function CreateMenu({
  importing,
  onProject,
  onFolder,
  onImport,
  onOverleaf,
}: {
  importing: boolean;
  onProject: () => void;
  onFolder: () => void;
  onImport: () => void;
  onOverleaf: () => void;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button variant="primary" disabled={importing}>
          <Plus size={16} /> {importing ? 'Importing…' : 'New'} <ChevronDown size={14} />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="dropdown" align="end" sideOffset={6}>
          <DropdownItem icon={<FileCode2 size={15} />} onSelect={onProject}>
            New project
          </DropdownItem>
          <DropdownItem icon={<FolderPlus size={15} />} onSelect={onFolder}>
            New folder
          </DropdownItem>
          <DropdownMenu.Separator className="dropdown-separator" />
          <DropdownItem icon={<Upload size={15} />} onSelect={onImport}>
            Import project ZIP
          </DropdownItem>
          <DropdownItem icon={<Import size={15} />} onSelect={onOverleaf}>
            Import Overleaf export
          </DropdownItem>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function BulkBar({
  count,
  allSelected,
  onSelectAll,
  onClear,
  onMove,
  onTags,
  onFavorite,
  onTrash,
}: {
  count: number;
  allSelected: boolean;
  onSelectAll: () => void;
  onClear: () => void;
  onMove: () => void;
  onTags: () => void;
  onFavorite: () => void;
  onTrash: () => void;
}) {
  return (
    <div className="bulk-bar" role="toolbar" aria-label="Selected project actions">
      <strong>{count} selected</strong>
      {!allSelected && (
        <Button variant="ghost" onClick={onSelectAll}>
          Select all
        </Button>
      )}
      <Button variant="ghost" onClick={onMove}>
        <FolderInput size={15} /> Move
      </Button>
      <Button variant="ghost" onClick={onTags}>
        <Tags size={15} /> Tags
      </Button>
      <Button variant="ghost" onClick={onFavorite}>
        <Star size={15} /> Favorite
      </Button>
      <Button variant="ghost" onClick={onTrash}>
        <Trash2 size={15} /> Trash
      </Button>
      <IconButton label="Clear selection" onClick={onClear}>
        <X size={16} />
      </IconButton>
    </div>
  );
}

function ProjectCreateDialog({
  destination,
  pending,
  onClose,
  onCreate,
}: {
  destination: LibraryFolder | null;
  pending: boolean;
  onClose: () => void;
  onCreate: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState('Untitled project');
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="Create project"
      description={
        destination
          ? `The project will be created in ${destination.name}.`
          : 'The project will be created in the library root.'
      }
    >
      <form
        className="dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          void onCreate(name);
        }}
      >
        <label className="field">
          Project name
          <input
            autoFocus
            className="input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={120}
            required
          />
        </label>
        <div className="dialog-actions">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={pending}>
            {pending ? 'Creating…' : 'Create project'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function FolderEditDialog({
  folder,
  parentId,
  pending,
  onClose,
  onSave,
}: {
  folder: LibraryFolder | undefined;
  parentId: string | null;
  pending: boolean;
  onClose: () => void;
  onSave: (name: string) => void;
}) {
  const [name, setName] = useState(folder?.name ?? 'New folder');
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={folder ? 'Rename folder' : 'Create folder'}
      {...(!folder && parentId
        ? { description: 'The folder will be nested in the current location.' }
        : {})}
    >
      <form
        className="dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          onSave(name);
        }}
      >
        <label className="field">
          Folder name
          <input
            autoFocus
            className="input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={120}
            required
          />
        </label>
        <div className="dialog-actions">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={pending}>
            {folder ? 'Save name' : 'Create folder'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function RenameProjectDialog({
  project,
  pending,
  onClose,
  onSave,
}: {
  project: LibraryProject;
  pending: boolean;
  onClose: () => void;
  onSave: (name: string) => void;
}) {
  const [name, setName] = useState(project.name);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} title="Rename project">
      <form
        className="dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          onSave(name);
        }}
      >
        <label className="field">
          Project name
          <input
            autoFocus
            className="input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={120}
            required
          />
        </label>
        <div className="dialog-actions">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={pending}>
            Save name
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function MoveDialog({
  title,
  folders,
  pending,
  onClose,
  onMove,
}: {
  title: string;
  folders: LibraryFolder[];
  pending: boolean;
  onClose: () => void;
  onMove: (folderId: string | null) => void;
}) {
  const [folderId, setFolderId] = useState<string | null>(null);
  const paths = buildFolderPaths(folders);
  const destination = folderId ? (paths.get(folderId) ?? 'Library root') : 'Library root';
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={title}
      description="Select a destination folder."
    >
      <form
        className="dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          onMove(folderId);
        }}
      >
        <div className="field">
          <span id="move-destination-label">Destination</span>
          <FolderPicker
            folders={folders}
            value={folderId}
            labelledBy="move-destination-label"
            onChange={setFolderId}
            onConfirm={onMove}
          />
        </div>
        <p className="folder-picker-destination">
          Move to <strong>{destination}</strong>
        </p>
        <div className="dialog-actions">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={pending}>
            Move
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function FolderPicker({
  folders,
  value,
  labelledBy,
  onChange,
  onConfirm,
}: {
  folders: LibraryFolder[];
  value: string | null;
  labelledBy: string;
  onChange: (folderId: string | null) => void;
  onConfirm: (folderId: string | null) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(folders.map((folder) => folder.id)),
  );
  const roots = folders.filter(
    (folder) => !folder.parentId || !folders.some((item) => item.id === folder.parentId),
  );
  return (
    <div
      className="folder-picker"
      role="tree"
      aria-label="Destination"
      aria-labelledby={labelledBy}
    >
      <FolderPickerRow
        label="Library root"
        icon={<FolderOpen size={15} />}
        selected={value === null}
        depth={0}
        onSelect={() => onChange(null)}
        onConfirm={() => onConfirm(null)}
      />
      {roots.map((folder) => (
        <FolderPickerNode
          key={folder.id}
          folder={folder}
          folders={folders}
          value={value}
          expanded={expanded}
          depth={1}
          onExpanded={setExpanded}
          onChange={onChange}
          onConfirm={onConfirm}
        />
      ))}
      {!folders.length && (
        <p className="folder-picker-empty">No folders yet. Items will move to Library root.</p>
      )}
    </div>
  );
}

function FolderPickerNode({
  folder,
  folders,
  value,
  expanded,
  depth,
  onExpanded,
  onChange,
  onConfirm,
}: {
  folder: LibraryFolder;
  folders: LibraryFolder[];
  value: string | null;
  expanded: Set<string>;
  depth: number;
  onExpanded: (value: Set<string>) => void;
  onChange: (folderId: string | null) => void;
  onConfirm: (folderId: string | null) => void;
}) {
  const children = folders.filter((candidate) => candidate.parentId === folder.id);
  const isOpen = expanded.has(folder.id);
  return (
    <div className="folder-picker-node">
      <FolderPickerRow
        label={folder.name}
        icon={isOpen && children.length ? <FolderOpen size={15} /> : <Folder size={15} />}
        selected={value === folder.id}
        depth={depth}
        expandable={children.length > 0}
        expanded={isOpen}
        onToggle={() => {
          const next = new Set(expanded);
          if (next.has(folder.id)) next.delete(folder.id);
          else next.add(folder.id);
          onExpanded(next);
        }}
        onSelect={() => onChange(folder.id)}
        onConfirm={() => onConfirm(folder.id)}
      />
      {isOpen &&
        children.map((child) => (
          <FolderPickerNode
            key={child.id}
            folder={child}
            folders={folders}
            value={value}
            expanded={expanded}
            depth={depth + 1}
            onExpanded={onExpanded}
            onChange={onChange}
            onConfirm={onConfirm}
          />
        ))}
    </div>
  );
}

function FolderPickerRow({
  label,
  icon,
  selected,
  depth,
  expandable = false,
  expanded = false,
  onToggle,
  onSelect,
  onConfirm,
}: {
  label: string;
  icon: ReactNode;
  selected: boolean;
  depth: number;
  expandable?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  onSelect: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className={classNames('folder-picker-row', selected && 'selected')}
      role="treeitem"
      tabIndex={selected ? 0 : -1}
      aria-label={label}
      aria-selected={selected}
      aria-expanded={expandable ? expanded : undefined}
      aria-level={Math.max(depth, 1)}
      style={{ paddingLeft: 4 + depth * 16 }}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect();
        }
        if (event.key === 'ArrowRight' && expandable && !expanded) {
          event.preventDefault();
          onToggle?.();
        }
        if (event.key === 'ArrowLeft' && expandable && expanded) {
          event.preventDefault();
          onToggle?.();
        }
      }}
      onDoubleClick={(event) => {
        event.preventDefault();
        onConfirm();
      }}
    >
      <button
        type="button"
        className="tree-expander"
        tabIndex={-1}
        disabled={!expandable}
        onClick={(event) => {
          event.stopPropagation();
          onToggle?.();
        }}
      >
        {expandable ? expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} /> : <span />}
      </button>
      {icon}
      <span>{label}</span>
      {selected && <Check className="picker-check" size={14} />}
    </div>
  );
}

function TagEditDialog({
  tag,
  pending,
  onClose,
  onSave,
}: {
  tag: ProjectTag | undefined;
  pending: boolean;
  onClose: () => void;
  onSave: (name: string, color: TagColor) => void;
}) {
  const [name, setName] = useState(tag?.name ?? 'New tag');
  const [color, setColor] = useState<TagColor>(tag?.color ?? 'green');
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={tag ? 'Edit tag' : 'Create tag'}
    >
      <form
        className="dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          onSave(name, color);
        }}
      >
        <label className="field">
          Tag name
          <input
            autoFocus
            className="input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={40}
            required
          />
        </label>
        <fieldset className="tag-color-picker">
          <legend>Color</legend>
          {tagColors.map((value) => (
            <button
              key={value}
              type="button"
              className={classNames(`tag-color-option tag-${value}`, color === value && 'active')}
              aria-label={value}
              aria-pressed={color === value}
              onClick={() => setColor(value)}
            >
              {color === value && <Check size={14} />}
            </button>
          ))}
        </fieldset>
        <div className="dialog-actions">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={pending}>
            {tag ? 'Save tag' : 'Create tag'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function TagAssignmentDialog({
  projectIds,
  projects,
  tags,
  onClose,
  onToggle,
  onCreateTag,
}: {
  projectIds: string[];
  projects: LibraryProject[];
  tags: ProjectTag[];
  onClose: () => void;
  onToggle: (tagId: string, value: boolean) => void;
  onCreateTag: () => void;
}) {
  const selectedProjects = projects.filter((project) => projectIds.includes(project.id));
  const stateFor = (tagId: string) => {
    const count = selectedProjects.filter((project) =>
      project.tags.some((tag) => tag.id === tagId),
    ).length;
    return count === 0 ? 'none' : count === selectedProjects.length ? 'all' : 'some';
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="Manage tags"
      description={
        projectIds.length === 1
          ? 'Changes save automatically.'
          : `Changes save automatically for ${projectIds.length} projects.`
      }
    >
      <div className="tag-assignment-list">
        {tags.map((tag) => {
          const state = stateFor(tag.id);
          return (
            <label key={tag.id} className="tag-assignment-row">
              <input
                type="checkbox"
                checked={state === 'all'}
                ref={(node) => {
                  if (node) node.indeterminate = state === 'some';
                }}
                onChange={() => onToggle(tag.id, state !== 'all')}
              />
              <span className={`tag-dot tag-${tag.color}`} />
              <span>{tag.name}</span>
              {state === 'some' && <small>Some</small>}
            </label>
          );
        })}
        {!tags.length && <p className="hint">Create a tag before assigning one.</p>}
      </div>
      <div className="dialog-split-actions">
        <Button variant="ghost" onClick={onCreateTag}>
          <Plus size={14} /> New tag
        </Button>
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      </div>
    </Dialog>
  );
}

function ConfirmDialog({
  modal,
  pending,
  onClose,
}: {
  modal: Extract<Modal, { type: 'confirm' }>;
  pending: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={modal.title}
      description={modal.description}
    >
      <div className="dialog-actions">
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant={modal.danger ? 'danger' : 'primary'}
          disabled={pending}
          onClick={async () => {
            await modal.run();
            onClose();
          }}
        >
          {pending ? 'Working…' : modal.confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}

function LibraryEmpty({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="library-empty">
      {icon}
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </div>
  );
}

function LibrarySkeleton({ layout }: { layout: Layout }) {
  return (
    <div
      className={layout === 'grid' ? 'library-project-grid' : 'project-list'}
      aria-label="Loading projects"
    >
      {Array.from({ length: layout === 'grid' ? 6 : 8 }, (_, index) => (
        <div key={index} className={classNames('library-skeleton', layout === 'list' && 'row')}>
          <span />
          <span />
        </div>
      ))}
    </div>
  );
}

function readExpandedFolders() {
  try {
    const raw = localStorage.getItem('library-expanded-folders');
    if (!raw) return new Set<string>();
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? new Set(parsed.filter((id): id is string => typeof id === 'string'))
      : new Set<string>();
  } catch {
    return new Set<string>();
  }
}

function buildFolderPaths(folders: LibraryFolder[]) {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const paths = new Map<string, string>();
  const visit = (folder: LibraryFolder, seen = new Set<string>()): string => {
    const cached = paths.get(folder.id);
    if (cached) return cached;
    if (seen.has(folder.id)) return folder.name;
    seen.add(folder.id);
    const path =
      folder.parentId && byId.get(folder.parentId)
        ? `${visit(byId.get(folder.parentId)!, seen)} / ${folder.name}`
        : folder.name;
    paths.set(folder.id, path);
    return path;
  };
  folders.forEach((folder) => visit(folder));
  return paths;
}

function isDescendant(candidateId: string, parentId: string, folders: LibraryFolder[]) {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  let cursor = byId.get(candidateId);
  while (cursor?.parentId) {
    if (cursor.parentId === parentId) return true;
    cursor = byId.get(cursor.parentId);
  }
  return false;
}

function compareProjects(left: LibraryProject, right: LibraryProject, sort: Sort) {
  if (sort === 'name-asc') return left.name.localeCompare(right.name);
  if (sort === 'name-desc') return right.name.localeCompare(left.name);
  if (sort === 'created-desc')
    return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
  const delta = new Date(left.updatedAt).getTime() - new Date(right.updatedAt).getTime();
  return sort === 'updated-asc' ? delta : -delta;
}

async function waitForCompilation(projectId: string, initial: CompileJob) {
  let job = initial;
  const deadline = Date.now() + 5 * 60_000;
  while (job.status === 'queued' || job.status === 'running') {
    if (Date.now() >= deadline) throw new Error('Compilation timed out');
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    ({ job } = await api<{ job: CompileJob }>(
      `/api/v1/projects/${projectId}/compilations/${job.id}`,
    ));
  }
  return job;
}

function formatCompiler(compiler: Project['compiler']) {
  if (compiler === 'pdflatex') return 'pdfLaTeX';
  if (compiler === 'xelatex') return 'XeLaTeX';
  return 'LuaLaTeX';
}

function actionMessage(action: string, count: number) {
  const noun = count === 1 ? 'Project' : `${count} projects`;
  if (action === 'move') return `${noun} moved`;
  if (action === 'trash') return `${noun} moved to trash`;
  if (action === 'restore') return `${noun} restored`;
  if (action === 'delete') return `${noun} permanently deleted`;
  if (action === 'favorite') return `${noun} updated`;
  return `${noun} tags updated`;
}
