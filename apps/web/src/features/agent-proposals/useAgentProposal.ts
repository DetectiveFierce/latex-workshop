import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  activeAgentProposalResponseSchema,
  agentProposalEventSchema,
  agentProposalFileResponseSchema,
  agentProposalResponseSchema,
  type AgentProposal,
  type AgentProposalChange,
  type CompileJob,
} from '@latex-workshop/contracts';
import { ApiClientError, api, appPath, queryKeys } from '../../lib/api';
import type { SaveState } from '../editor/EditorPane';
import {
  buildProposalFileModel,
  countsForChanges,
  overlayHunksFor,
  reviewableItems,
  shouldBlockProposalOverlay,
  type ProposalEdit,
  type ProposalFileModel,
  type ReviewableHunk,
} from './proposalDiffModel';
import { isActiveProposalStatus } from './proposalActiveState';
import { preserveFullyAcceptedProposalCompile } from './proposalPdfHandoff';

export type ProposalVirtualFile = {
  changeId: string;
  path: string;
  name: string;
};

export function useAgentProposal({
  projectId,
  openPath,
  saveState,
  flushEditor,
  onAcceptedHeadChanged,
}: {
  projectId: string;
  openPath: string | null;
  saveState?: SaveState | undefined;
  flushEditor: () => Promise<void>;
  onAcceptedHeadChanged: () => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [selectedHunkId, setSelectedHunkId] = useState<string | null>(null);
  const [dockExpanded, setDockExpanded] = useState(false);
  const flushRef = useRef(flushEditor);
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingFiles = useRef(new Map<string, string>());
  const persistRunning = useRef<Promise<void> | null>(null);
  const overlayActivePathRef = useRef<string | null>(null);
  const mutationInFlightRef = useRef(false);
  flushRef.current = flushEditor;

  const query = useQuery({
    queryKey: queryKeys.agentProposal(projectId),
    queryFn: async () =>
      activeAgentProposalResponseSchema.parse(
        await api<unknown>(`/api/v1/projects/${projectId}/proposals/active`),
      ),
    refetchInterval: 15_000,
  });
  const proposal = query.data?.proposal ?? null;
  useEffect(() => {
    pendingFiles.current.clear();
  }, [proposal?.id]);

  const fileChange = useMemo(
    () => (proposal && openPath ? changeForPath(proposal.changes, openPath) : null),
    [openPath, proposal],
  );
  const overlayQuery = useQuery({
    queryKey: queryKeys.agentProposalFile(projectId, proposal?.id, openPath),
    queryFn: async () => {
      const proposalId = proposal?.id;
      if (!proposalId || !openPath) throw new Error('Proposal overlay path is missing');
      return agentProposalFileResponseSchema.parse(
        await api<unknown>(
          `/api/v1/projects/${projectId}/proposals/${proposalId}/files?path=${encodeURIComponent(openPath)}`,
        ),
      );
    },
    enabled: Boolean(
      proposal &&
        openPath &&
        fileChange &&
        (fileChange.operation === 'create_file' ||
          fileChange.operation === 'replace_file' ||
          fileChange.operation === 'delete') &&
        fileChange.entryKind === 'file',
    ),
    retry: (count, error) =>
      error instanceof ApiClientError && (error.status === 404 || error.status === 400)
        ? false
        : count < 2,
  });

  useEffect(() => {
    const source = new EventSource(appPath(`/api/v1/projects/${projectId}/proposal-events`), {
      withCredentials: true,
    });
    const refresh = (event: MessageEvent<string>) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        parsed = null;
      }
      if (!agentProposalEventSchema.safeParse(parsed).success) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.agentProposal(projectId) });
        return;
      }
      if (!mutationInFlightRef.current)
        void queryClient.invalidateQueries({ queryKey: queryKeys.agentProposal(projectId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agentProposalFile(projectId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.project(projectId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.compiles(projectId) });
    };
    source.addEventListener('proposal', refresh as EventListener);
    source.addEventListener('error', () => void query.refetch());
    return () => source.close();
  }, [projectId, queryClient]);

  const overlayBlocked =
    Boolean(proposal && openPath && fileChange) &&
    shouldBlockProposalOverlay({
      saveState,
      overlayAlreadyActive: overlayActivePathRef.current === openPath,
    });
  useEffect(() => {
    if (overlayBlocked && saveState === 'dirty') void flushRef.current();
  }, [overlayBlocked, saveState]);

  const fileModel = useMemo((): ProposalFileModel | null => {
    if (!proposal || !openPath || overlayBlocked || !overlayQuery.data || !fileChange) return null;
    return buildProposalFileModel({
      path: openPath,
      baseText: overlayQuery.data.baseText,
      hunks: overlayHunksFor(
        proposal.status,
        fileChange,
        overlayQuery.data.baseText,
        overlayQuery.data.proposedText,
      ),
    });
  }, [fileChange, openPath, overlayBlocked, overlayQuery.data, proposal]);
  useEffect(() => {
    overlayActivePathRef.current = fileModel?.path ?? null;
  }, [fileModel]);
  useEffect(
    () => () => {
      if (persistTimer.current) clearTimeout(persistTimer.current);
      void startPersistDrain();
    },
    [],
  );

  const items = useMemo(() => (proposal ? reviewableItems(proposal.changes) : []), [proposal]);
  const totals = useMemo(() => countsForChanges(proposal?.changes ?? []), [proposal]);

  async function mutate(
    path: string,
    body: Record<string, unknown>,
    afterAccept = false,
    discardPendingEdits = false,
    method = 'POST',
  ) {
    if (!proposal) return;
    if (!discardPendingEdits && !(await flushPendingFiles())) return;
    const cached = activeAgentProposalResponseSchema.safeParse(
      queryClient.getQueryData(queryKeys.agentProposal(projectId)),
    );
    const current = cached.success ? cached.data.proposal : proposal;
    if (!current) return;
    setBusy(true);
    mutationInFlightRef.current = true;
    setError('');
    try {
      if (afterAccept) await flushRef.current();
      const result = agentProposalResponseSchema.parse(
        await api<unknown>(`/api/v1/projects/${projectId}/proposals/${current.id}/${path}`, {
          method,
          body: JSON.stringify({ ...body, expectedProposalRevision: current.revision }),
        }),
      );
      if (afterAccept) {
        queryClient.setQueryData<{ jobs: CompileJob[] }>(queryKeys.compiles(projectId), (cached) =>
          cached
            ? { jobs: preserveFullyAcceptedProposalCompile(cached.jobs, result.proposal) }
            : cached,
        );
      }
      queryClient.setQueryData(queryKeys.agentProposal(projectId), {
        proposal: isActiveProposalStatus(result.proposal.status) ? result.proposal : null,
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.agentProposalFile(projectId) });
      if (afterAccept) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.project(projectId) });
        await queryClient.invalidateQueries({ queryKey: queryKeys.compiles(projectId) });
        await onAcceptedHeadChanged();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to update this proposal');
      await query.refetch();
    } finally {
      mutationInFlightRef.current = false;
      setBusy(false);
    }
  }

  async function persistEdit(edit: ProposalEdit) {
    if (!proposal || !openPath || edit.kind === 'ignore') return;
    pendingFiles.current.set(openPath, edit.nextBuffer);
    if (persistTimer.current) clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      persistTimer.current = null;
      void startPersistDrain();
    }, 400);
  }

  function startPersistDrain(): Promise<void> {
    if (persistRunning.current) return persistRunning.current;
    const run = (async () => {
      while (pendingFiles.current.size) {
        const queued = pendingFiles.current.entries().next().value;
        if (!queued) break;
        const [path, content] = queued;
        pendingFiles.current.delete(path);
        if (!(await persistFileNow(path, content))) {
          if (!pendingFiles.current.has(path)) pendingFiles.current.set(path, content);
          break;
        }
      }
    })();
    persistRunning.current = run;
    void run.finally(() => {
      if (persistRunning.current === run) persistRunning.current = null;
    });
    return run;
  }

  async function flushPendingFiles(): Promise<boolean> {
    if (persistTimer.current) {
      clearTimeout(persistTimer.current);
      persistTimer.current = null;
    }
    await startPersistDrain();
    return pendingFiles.current.size === 0;
  }

  async function persistFileNow(path: string, content: string): Promise<boolean> {
    const cached = activeAgentProposalResponseSchema.safeParse(
      queryClient.getQueryData(queryKeys.agentProposal(projectId)),
    );
    const current = cached.success ? cached.data.proposal : proposal;
    if (!current) return false;
    setError('');
    try {
      const result = agentProposalResponseSchema.parse(
        await api<unknown>(`/api/v1/projects/${projectId}/proposals/${current.id}/files`, {
          method: 'PUT',
          body: JSON.stringify({
            expectedProposalRevision: current.revision,
            path,
            content,
          }),
        }),
      );
      queryClient.setQueryData(queryKeys.agentProposal(projectId), result);
      await queryClient.invalidateQueries({ queryKey: queryKeys.agentProposalFile(projectId) });
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to revise this proposal file');
      await query.refetch();
      return false;
    }
  }

  const virtualFiles: ProposalVirtualFile[] = useMemo(
    () =>
      (proposal?.changes ?? [])
        .filter(
          (change) =>
            !change.entryId &&
            change.decision !== 'rejected' &&
            (change.operation === 'create_file' || change.operation === 'delete') &&
            (change.targetPath || change.basePath),
        )
        .map((change) => {
          const path = change.targetPath ?? change.basePath ?? '';
          return { changeId: change.id, path, name: path.split('/').at(-1) ?? path };
        }),
    [proposal],
  );

  return {
    proposal,
    busy,
    error,
    overlayBlocked,
    fileModel,
    selectedHunkId,
    setSelectedHunkId,
    dockExpanded,
    setDockExpanded,
    items,
    totals,
    currentCounts: {
      added: fileModel?.addedLineCount ?? 0,
      deleted: fileModel?.deletedLineCount ?? 0,
    },
    virtualFiles,
    persistEdit,
    flushPending: async () => {
      await flushRef.current();
      return flushPendingFiles();
    },
    decide: (itemId: string, decision: 'accepted' | 'rejected') =>
      mutate('decisions', { expectedProposalRevision: proposal?.revision, itemId, decision }, true),
    finish: async () => {
      await flushRef.current();
      await mutate('finish', {
        expectedProposalRevision: proposal?.revision,
        idempotencyKey: crypto.randomUUID(),
      });
    },
    acceptAll: () =>
      mutate(
        'accept-remaining',
        { expectedProposalRevision: proposal?.revision, decision: 'accepted' },
        true,
      ),
    rejectAll: () =>
      mutate(
        'reject-remaining',
        { expectedProposalRevision: proposal?.revision, decision: 'rejected' },
        true,
        true,
      ),
    discardChange: (changeId: string) =>
      mutate(
        `changes/${changeId}`,
        { expectedProposalRevision: proposal?.revision },
        false,
        true,
        'DELETE',
      ),
    selectItem: (item: ReviewableHunk) => {
      setSelectedHunkId(item.id);
      setDockExpanded(true);
    },
  };
}

export function changeForPath(changes: readonly AgentProposalChange[], path: string) {
  return changes.find((change) => change.targetPath === path || change.basePath === path) ?? null;
}

export function compileStatusFor(
  proposal: AgentProposal | null,
  jobs: CompileJob[] | undefined,
): CompileJob['status'] | null {
  if (!proposal) return null;
  return (
    jobs?.find((job) => job.target === 'proposal' && job.proposalId === proposal.id)?.status ?? null
  );
}
