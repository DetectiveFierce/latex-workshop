import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { gzipSync } from 'node:zlib';
import {
  agentProposalLimits,
  allProposalItemsAccepted,
  buildEntryPaths,
  createFrozenHunks,
  normalizeArchivePath,
  proposalHunkContentHash,
  projectAcceptedHunks,
  type AgentProposal,
} from '@latex-workshop/contracts';
import {
  agentClientPolicies,
  agentProjectGrants,
  agentProposalChanges,
  agentProposalHunks,
  agentProposalMutations,
  agentProposals,
  auditEvents,
  checkpoints,
  compileJobs,
  entries,
  editorHistoryNodes,
  editorHistoryState,
  fileBlobs,
  fileVersions,
  projectMemberships,
  projects,
  type CheckpointManifestEntry,
} from '@latex-workshop/db';
import type { Database, DatabaseTransaction } from '@latex-workshop/db';
import type { AppContext } from './context.js';
import { badRequest, conflict, HttpError, notFound, quotaExceeded } from './errors.js';
import { acceptedCheckpointManifest, getFileWithBlob, requireProject, sha256 } from './domain.js';
import { createHistoryNode, ensureHistoryRoot } from '../routes/edit-history.js';
import {
  assertProposalRevision,
  assertProposalWriteLimits,
  canAgentMutateProposal,
  canAgentReviseProposal,
  canOwnerReviseAddition,
  canOwnerReviseProposalFile,
  canOwnerDiscardDraftChange,
  canOwnerDiscardProposal,
  checkpointContentMatches,
  hasCaseInsensitivePathCollision,
  hunkDecisionAfterReplacement,
  nextProposalByteTotal,
  proposalFileBase,
  shouldResetFrozenProposalReview,
} from './agent-proposal-policy.js';

export { projectAcceptedHunks } from '@latex-workshop/contracts';

type AgentIdentity = { userId: string; clientId: string; clientName: string };

const sourceExtension = /\.(?:tex|bib|sty|cls|bst|bbx|cbx|lbx|def|cfg|clo|fd|md|txt|json|ya?ml)$/i;

export function isAgentEditableSource(name: string, mimeType: string | null): boolean {
  return Boolean(mimeType?.startsWith('text/') || sourceExtension.test(name));
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw badRequest('Only valid UTF-8 source files may be edited by an agent');
  }
}

function deterministicUuid(value: string): string {
  const hash = sha256(value).slice(0, 32).split('');
  hash[12] = '5';
  hash[16] = ['8', '9', 'a', 'b'][Number.parseInt(hash[16] ?? '0', 16) % 4] ?? '8';
  const joined = hash.join('');
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}

export async function requireGrantedProject(
  context: AppContext,
  identity: AgentIdentity,
  projectId: string,
) {
  const [owned] = await context.db
    .select({ project: projects })
    .from(projects)
    .innerJoin(projectMemberships, eq(projectMemberships.projectId, projects.id))
    .where(
      and(
        eq(projects.id, projectId),
        eq(projectMemberships.userId, identity.userId),
        eq(projectMemberships.role, 'owner'),
        isNull(projects.trashedAt),
      ),
    )
    .limit(1);
  if (!owned) throw notFound('Project not found');
  const [policy] = await context.db
    .select({ allProjects: agentClientPolicies.allProjects })
    .from(agentClientPolicies)
    .where(
      and(
        eq(agentClientPolicies.userId, identity.userId),
        eq(agentClientPolicies.clientId, identity.clientId),
      ),
    )
    .limit(1);
  if (policy?.allProjects) return owned.project;
  const [grant] = await context.db
    .select({ projectId: agentProjectGrants.projectId })
    .from(agentProjectGrants)
    .where(
      and(
        eq(agentProjectGrants.userId, identity.userId),
        eq(agentProjectGrants.clientId, identity.clientId),
        eq(agentProjectGrants.projectId, projectId),
      ),
    )
    .limit(1);
  if (!grant) throw notFound('Project not found');
  return owned.project;
}

export async function projectEntries(
  context: AppContext,
  projectId: string,
  database: Database | DatabaseTransaction = context.db,
) {
  const rows = await database
    .select()
    .from(entries)
    .where(eq(entries.projectId, projectId))
    .orderBy(asc(entries.createdAt));
  return { rows, paths: buildEntryPaths(rows) };
}

export async function listGrantedProjects(context: AppContext, identity: AgentIdentity) {
  const [policy] = await context.db
    .select({ allProjects: agentClientPolicies.allProjects })
    .from(agentClientPolicies)
    .where(
      and(
        eq(agentClientPolicies.userId, identity.userId),
        eq(agentClientPolicies.clientId, identity.clientId),
      ),
    )
    .limit(1);
  const rows = policy?.allProjects
    ? await context.db
        .select({ project: projects })
        .from(projects)
        .innerJoin(projectMemberships, eq(projectMemberships.projectId, projects.id))
        .where(
          and(
            eq(projectMemberships.userId, identity.userId),
            eq(projectMemberships.role, 'owner'),
            isNull(projects.trashedAt),
          ),
        )
    : await context.db
        .select({ project: projects })
        .from(agentProjectGrants)
        .innerJoin(projects, eq(projects.id, agentProjectGrants.projectId))
        .innerJoin(
          projectMemberships,
          and(
            eq(projectMemberships.projectId, projects.id),
            eq(projectMemberships.userId, agentProjectGrants.userId),
          ),
        )
        .where(
          and(
            eq(agentProjectGrants.userId, identity.userId),
            eq(agentProjectGrants.clientId, identity.clientId),
            eq(projectMemberships.role, 'owner'),
            isNull(projects.trashedAt),
          ),
        );
  return rows.map(({ project }) => ({
    id: project.id,
    name: project.name,
    sourceRevision: project.sourceRevision,
    compiler: project.compiler,
    isTemplate: project.isTemplate,
  }));
}

export async function getAgentProjectTree(
  context: AppContext,
  identity: AgentIdentity,
  projectId: string,
) {
  const project = await requireGrantedProject(context, identity, projectId);
  const { rows, paths } = await projectEntries(context, projectId);
  const versionIds = rows.flatMap((entry) =>
    entry.currentVersionId ? [entry.currentVersionId] : [],
  );
  const versions = versionIds.length
    ? await context.db
        .select({ id: fileVersions.id, hash: fileVersions.blobHash })
        .from(fileVersions)
        .where(inArray(fileVersions.id, versionIds))
    : [];
  const hashes = new Map(versions.map((version) => [version.id, version.hash]));
  return {
    projectId,
    sourceRevision: project.sourceRevision,
    entries: rows.map((entry) => ({
      path: paths.get(entry.id) ?? entry.name,
      kind: entry.kind,
      editable: entry.kind === 'file' && isAgentEditableSource(entry.name, entry.mimeType),
      mimeType: entry.mimeType,
      size: entry.size,
      version: entry.version,
      hash: entry.currentVersionId ? (hashes.get(entry.currentVersionId) ?? null) : null,
    })),
  };
}

export async function readAgentTextFile(
  context: AppContext,
  identity: AgentIdentity,
  input: { projectId: string; path: string; offset: number; limit: number },
) {
  await requireGrantedProject(context, identity, input.projectId);
  const path = normalizeArchivePath(input.path);
  const { rows, paths } = await projectEntries(context, input.projectId);
  const entry = rows.find((row) => paths.get(row.id) === path);
  if (!entry || entry.kind !== 'file' || !isAgentEditableSource(entry.name, entry.mimeType))
    throw notFound('File not found');
  const file = await getFileWithBlob(context.db, input.projectId, entry.id);
  const bytes = await context.storage.getBuffer(file.blob.objectKey);
  decodeUtf8(bytes);
  if (input.offset > bytes.length) throw badRequest('Read offset is beyond the end of the file');
  if (input.offset < bytes.length && (bytes[input.offset]! & 0xc0) === 0x80)
    throw badRequest('Read offset must begin at a UTF-8 character boundary');
  let end = Math.min(bytes.length, input.offset + input.limit);
  while (end < bytes.length && end > input.offset && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  const page = bytes.subarray(input.offset, end);
  return {
    path,
    content: decodeUtf8(page),
    offset: input.offset,
    nextOffset: end < bytes.length ? end : null,
    version: entry.version,
    hash: file.blob.hash,
  };
}

export async function startAgentProposal(
  context: AppContext,
  identity: AgentIdentity,
  input: { projectId: string; title: string; idempotencyKey: string },
) {
  await requireGrantedProject(context, identity, input.projectId);
  const [active] = await context.db
    .select()
    .from(agentProposals)
    .where(
      and(
        eq(agentProposals.projectId, input.projectId),
        inArray(agentProposals.status, ['draft', 'needs_rebase', 'reviewing']),
      ),
    )
    .limit(1);
  if (active) {
    if (active.clientId === identity.clientId)
      return getAgentProposal(context, identity.userId, active.id);
    throw conflict('This project already has an unresolved agent proposal');
  }
  const proposal = await context.db.transaction(async (tx) => {
    const [created] = await tx
      .insert(agentProposals)
      .values({
        projectId: input.projectId,
        userId: identity.userId,
        clientId: identity.clientId,
        clientName: identity.clientName,
        title: input.title,
      })
      .returning();
    if (!created) throw new Error('Proposal was not created');
    await tx.insert(agentProposalMutations).values({
      proposalId: created.id,
      idempotencyKey: input.idempotencyKey,
      resultingRevision: created.revision,
    });
    return created;
  });
  await context.db.insert(auditEvents).values({
    userId: identity.userId,
    projectId: input.projectId,
    action: 'agent_proposal.started',
    details: { proposalId: proposal.id, clientId: identity.clientId },
  });
  await publishProposal(context, proposal.id, proposal.revision);
  return getAgentProposal(context, identity.userId, proposal.id);
}

async function loadOwnedProposal(context: AppContext, userId: string, proposalId: string) {
  const [proposal] = await context.db
    .select()
    .from(agentProposals)
    .where(and(eq(agentProposals.id, proposalId), eq(agentProposals.userId, userId)))
    .limit(1);
  if (!proposal) throw notFound('Proposal not found');
  return proposal;
}

async function loadAgentOwnedProposal(
  context: AppContext,
  identity: AgentIdentity,
  proposalId: string,
) {
  const proposal = await loadOwnedProposal(context, identity.userId, proposalId);
  if (proposal.clientId !== identity.clientId) throw notFound('Proposal not found');
  return proposal;
}

export async function getAgentClientProposal(
  context: AppContext,
  identity: AgentIdentity,
  proposalId: string,
) {
  const proposal = await loadAgentOwnedProposal(context, identity, proposalId);
  await requireGrantedProject(context, identity, proposal.projectId);
  return getAgentProposal(context, identity.userId, proposalId);
}

export async function getAgentProposalCompile(
  context: AppContext,
  identity: AgentIdentity,
  proposalId: string,
) {
  const proposal = await loadAgentOwnedProposal(context, identity, proposalId);
  await requireGrantedProject(context, identity, proposal.projectId);
  if (!proposal.latestCompileJobId) return null;
  const [job] = await context.db
    .select()
    .from(compileJobs)
    .where(
      and(
        eq(compileJobs.id, proposal.latestCompileJobId),
        eq(compileJobs.projectId, proposal.projectId),
        eq(compileJobs.proposalId, proposal.id),
      ),
    )
    .limit(1);
  if (!job) return null;
  return serializeAgentCompile(job);
}

export async function getAgentProposalPdfArtifact(
  context: AppContext,
  identity: AgentIdentity,
  proposalId: string,
  compileJobId: string,
) {
  const proposal = await loadAgentOwnedProposal(context, identity, proposalId);
  await requireGrantedProject(context, identity, proposal.projectId);
  const [job] = await context.db
    .select({
      id: compileJobs.id,
      projectId: compileJobs.projectId,
      pdfObjectKey: compileJobs.pdfObjectKey,
      status: compileJobs.status,
    })
    .from(compileJobs)
    .where(
      and(
        eq(compileJobs.id, compileJobId),
        eq(compileJobs.projectId, proposal.projectId),
        eq(compileJobs.proposalId, proposal.id),
      ),
    )
    .limit(1);
  if (!job?.pdfObjectKey || job.status !== 'succeeded')
    throw notFound('Compiled proposal PDF not found');
  return { ...job, pdfObjectKey: job.pdfObjectKey };
}

export async function waitForAgentProposalCompile(
  context: AppContext,
  identity: AgentIdentity,
  proposalId: string,
  compileJobId: string,
  signal?: AbortSignal,
) {
  const deadline = Date.now() + context.config.COMPILE_TIMEOUT_MS + 15_000;
  while (true) {
    const job = await getAgentProposalCompile(context, identity, proposalId);
    if (!job || job.id !== compileJobId)
      throw conflict('Proposal compile was replaced before its result became available');
    if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled')
      return job;
    if (signal?.aborted || Date.now() >= deadline) return job;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

export function serializeAgentCompile(job: typeof compileJobs.$inferSelect) {
  return {
    id: job.id,
    projectId: job.projectId,
    checkpointId: job.checkpointId,
    sourceRevision: job.sourceRevision,
    engine: job.engine,
    status: job.status,
    trigger: job.trigger,
    target: job.target,
    proposalId: job.proposalId,
    proposalRevision: job.proposalRevision,
    log: job.log,
    diagnostics: job.diagnostics,
    durationMs: job.durationMs,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}

export async function getAgentProposal(
  context: AppContext,
  userId: string,
  proposalId: string,
): Promise<AgentProposal> {
  const proposal = await loadOwnedProposal(context, userId, proposalId);
  const changes = await context.db
    .select()
    .from(agentProposalChanges)
    .where(eq(agentProposalChanges.proposalId, proposal.id))
    .orderBy(asc(agentProposalChanges.sortOrder));
  const hunks = await context.db
    .select()
    .from(agentProposalHunks)
    .where(eq(agentProposalHunks.proposalId, proposal.id))
    .orderBy(asc(agentProposalHunks.sortOrder));
  return {
    id: proposal.id,
    projectId: proposal.projectId,
    clientId: proposal.clientId,
    clientName: proposal.clientName,
    title: proposal.title,
    status: proposal.status,
    revision: proposal.revision,
    changedEntryCount: changes.length,
    totalBytes: proposal.totalBytes,
    conflicts: proposal.conflictPaths,
    changes: changes.map((change) => ({
      id: change.id,
      operation: change.operation,
      entryId: change.entryId,
      entryKind: change.entryKind,
      basePath: change.basePath,
      targetPath: change.targetPath,
      baseVersion: change.baseVersion,
      baseHash: change.baseHash,
      contentHash: change.contentHash,
      size: change.size,
      decision: change.decision,
      hunks: hunks
        .filter((hunk) => hunk.changeId === change.id)
        .map((hunk) => ({
          id: hunk.id,
          changeId: hunk.changeId,
          baseStart: hunk.baseStart,
          baseEnd: hunk.baseEnd,
          baseText: hunk.baseText,
          replacementText: hunk.replacementText,
          contentHash: hunk.contentHash,
          decision: hunk.decision,
          order: hunk.sortOrder,
        })),
    })),
    compileJobId: proposal.latestCompileJobId,
    createdAt: proposal.createdAt.toISOString(),
    updatedAt: proposal.updatedAt.toISOString(),
  };
}

async function assertDraftMutation(
  db: Database | DatabaseTransaction,
  proposalId: string,
  userId: string,
  expectedRevision: number,
  idempotencyKey: string,
  allowReviewRevision = false,
) {
  await db.execute(
    sql`select ${agentProposals.id} from ${agentProposals} where ${agentProposals.id} = ${proposalId} for update`,
  );
  const [proposal] = await db
    .select()
    .from(agentProposals)
    .where(and(eq(agentProposals.id, proposalId), eq(agentProposals.userId, userId)))
    .limit(1);
  if (!proposal) throw notFound('Proposal not found');
  const [duplicate] = await db
    .select()
    .from(agentProposalMutations)
    .where(
      and(
        eq(agentProposalMutations.proposalId, proposalId),
        eq(agentProposalMutations.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  if (duplicate) return { proposal, duplicate: true } as const;
  const canMutate = allowReviewRevision
    ? canAgentReviseProposal(proposal.status)
    : canAgentMutateProposal(proposal.status);
  if (!canMutate) throw conflict('This proposal is frozen and can no longer be changed');
  assertProposalRevision(proposal.revision, expectedRevision, proposalId);
  return { proposal, duplicate: false } as const;
}

export async function putAgentProposalFile(
  context: AppContext,
  identity: AgentIdentity,
  proposalId: string,
  input: {
    expectedProposalRevision: number;
    idempotencyKey: string;
    path: string;
    content: string;
    baseHash?: string | null | undefined;
  },
) {
  const proposal = await loadAgentOwnedProposal(context, identity, proposalId);
  await requireGrantedProject(context, identity, proposal.projectId);
  if (proposal.revision !== input.expectedProposalRevision)
    return getAgentProposal(context, identity.userId, proposalId);
  const path = normalizeArchivePath(input.path);
  const bytes = Buffer.from(input.content);
  assertProposalWriteLimits({
    fileBytes: bytes.byteLength,
    nextTotalBytes: bytes.byteLength,
    changedEntries: 0,
  });
  assertProposalWriteLimits({
    fileBytes: bytes.byteLength,
    nextTotalBytes: 0,
    changedEntries: 0,
  });
  const { rows, paths } = await projectEntries(context, proposal.projectId);
  const existing = rows.find((row) => paths.get(row.id) === path);
  if (
    existing &&
    (existing.kind !== 'file' || !isAgentEditableSource(existing.name, existing.mimeType))
  )
    throw badRequest('Agents may only replace editable UTF-8 source files');
  const base = existing ? await getFileWithBlob(context.db, proposal.projectId, existing.id) : null;
  if (base) decodeUtf8(await context.storage.getBuffer(base.blob.objectKey));
  if (input.baseHash !== undefined && input.baseHash !== (base?.blob.hash ?? null))
    throw conflict('The file base hash does not match accepted head', {
      hash: base?.blob.hash ?? null,
    });
  const hash = sha256(bytes);
  const objectKey = `proposals/${identity.userId}/${proposal.projectId}/${proposalId}/${hash}`;
  await context.storage.put(objectKey, bytes, 'text/plain; charset=utf-8');
  const revision = await context.db.transaction(async (tx) => {
    const state = await assertDraftMutation(
      tx,
      proposalId,
      identity.userId,
      input.expectedProposalRevision,
      input.idempotencyKey,
      true,
    );
    if (state.duplicate) return state.proposal.revision;
    if (shouldResetFrozenProposalReview(state.proposal.status)) {
      await tx.delete(agentProposalHunks).where(eq(agentProposalHunks.proposalId, proposalId));
      await tx
        .update(agentProposalChanges)
        .set({ decision: 'pending', updatedAt: new Date() })
        .where(eq(agentProposalChanges.proposalId, proposalId));
    }
    const current = await tx
      .select()
      .from(agentProposalChanges)
      .where(
        and(
          eq(agentProposalChanges.proposalId, proposalId),
          eq(agentProposalChanges.targetPath, path),
        ),
      )
      .limit(1);
    const [old] = current;
    let newChangeOrder = 0;
    if (!old) {
      const [count] = await tx
        .select({ value: sql<number>`count(*)::int` })
        .from(agentProposalChanges)
        .where(eq(agentProposalChanges.proposalId, proposalId));
      newChangeOrder = count?.value ?? 0;
    }
    const nextTotal = nextProposalByteTotal(
      state.proposal.totalBytes,
      old?.size ?? 0,
      bytes.byteLength,
    );
    assertProposalWriteLimits({
      fileBytes: bytes.byteLength,
      nextTotalBytes: nextTotal,
      changedEntries: old ? 0 : newChangeOrder + 1,
    });
    if (old) {
      await tx
        .update(agentProposalChanges)
        .set({
          ...proposalFileBase(existing ?? null, path, base?.blob.hash ?? null),
          contentHash: hash,
          contentObjectKey: objectKey,
          size: bytes.byteLength,
          decision: 'pending',
          updatedAt: new Date(),
        })
        .where(eq(agentProposalChanges.id, old.id));
    } else {
      await tx.insert(agentProposalChanges).values({
        proposalId,
        entryId: existing?.id ?? null,
        entryKind: 'file',
        operation: existing ? 'replace_file' : 'create_file',
        basePath: existing ? path : null,
        targetPath: path,
        baseVersion: existing?.version ?? null,
        baseVersionId: existing?.currentVersionId ?? null,
        baseHash: base?.blob.hash ?? null,
        contentHash: hash,
        contentObjectKey: objectKey,
        size: bytes.byteLength,
        sortOrder: newChangeOrder,
      });
    }
    const nextRevision = state.proposal.revision + 1;
    await tx
      .update(agentProposals)
      .set({
        revision: nextRevision,
        totalBytes: nextTotal,
        status: 'draft',
        conflictPaths: [],
        latestCompileJobId: null,
        resolvedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(agentProposals.id, proposalId));
    await tx.insert(agentProposalMutations).values({
      proposalId,
      idempotencyKey: input.idempotencyKey,
      resultingRevision: nextRevision,
    });
    return nextRevision;
  });
  await context.db.insert(auditEvents).values({
    userId: identity.userId,
    projectId: proposal.projectId,
    action: 'agent_proposal.file_updated',
    details: {
      proposalId,
      revision,
      clientId: identity.clientId,
      reopenedReview: shouldResetFrozenProposalReview(proposal.status),
    },
  });
  await publishProposal(context, proposalId, revision);
  return getAgentProposal(context, identity.userId, proposalId);
}

export async function proposeAgentStructure(
  context: AppContext,
  identity: AgentIdentity,
  proposalId: string,
  input: {
    expectedProposalRevision: number;
    idempotencyKey: string;
    changes: Array<
      | { operation: 'create_folder'; targetPath: string }
      | { operation: 'move'; basePath: string; targetPath: string }
      | { operation: 'delete'; basePath: string }
    >;
  },
) {
  const proposal = await loadAgentOwnedProposal(context, identity, proposalId);
  await requireGrantedProject(context, identity, proposal.projectId);
  if (proposal.revision !== input.expectedProposalRevision)
    return getAgentProposal(context, identity.userId, proposalId);
  const tree = await projectEntries(context, proposal.projectId);
  const byPath = new Map(tree.rows.map((entry) => [tree.paths.get(entry.id) ?? entry.name, entry]));
  const byLowerPath = new Map([...byPath].map(([path, entry]) => [path.toLowerCase(), entry]));
  const plannedTargets = new Set<string>();
  const plannedFolders = new Set(
    [...byPath].filter(([, entry]) => entry.kind === 'folder').map(([path]) => path.toLowerCase()),
  );
  const normalized = input.changes.map((item) => {
    const basePath = 'basePath' in item ? normalizeArchivePath(item.basePath) : null;
    const targetPath = 'targetPath' in item ? normalizeArchivePath(item.targetPath) : null;
    const entry = basePath ? byPath.get(basePath) : null;
    if (basePath && !entry) throw notFound('Source entry not found');
    const lowerTargetPath = targetPath?.toLowerCase() ?? null;
    if (
      lowerTargetPath &&
      (hasCaseInsensitivePathCollision(byLowerPath.keys(), lowerTargetPath) ||
        plannedTargets.has(lowerTargetPath))
    )
      throw conflict('A target path already exists', { path: targetPath });
    if (lowerTargetPath) plannedTargets.add(lowerTargetPath);
    if (targetPath) {
      const split = targetPath.lastIndexOf('/');
      const parentPath = split < 0 ? null : targetPath.slice(0, split).toLowerCase();
      if (parentPath && !plannedFolders.has(parentPath))
        throw badRequest('The target parent folder does not exist', { path: targetPath });
      if (item.operation === 'create_folder' || entry?.kind === 'folder')
        plannedFolders.add(targetPath.toLowerCase());
    }
    if (item.operation === 'move' && targetPath?.startsWith(`${basePath}/`))
      throw badRequest('A folder cannot be moved into its descendant');
    if (entry) {
      const subtree = tree.rows.filter((candidate) => {
        const path = tree.paths.get(candidate.id);
        return path === basePath || Boolean(path?.startsWith(`${basePath}/`));
      });
      if (subtree.length > agentProposalLimits.maxChangedEntries)
        throw quotaExceeded('Folder operation affects too many entries');
      if (
        subtree.some(
          (candidate) =>
            candidate.kind === 'file' && !isAgentEditableSource(candidate.name, candidate.mimeType),
        )
      )
        throw badRequest('Folder operations cannot include binary files');
    }
    return {
      operation: item.operation,
      entryId: entry?.id ?? null,
      entryKind: entry?.kind ?? 'folder',
      basePath,
      targetPath,
      baseVersion: entry?.kind === 'file' ? entry.version : null,
      baseVersionId: entry?.kind === 'file' ? entry.currentVersionId : null,
    };
  });
  const revision = await context.db.transaction(async (tx) => {
    const state = await assertDraftMutation(
      tx,
      proposalId,
      identity.userId,
      input.expectedProposalRevision,
      input.idempotencyKey,
      true,
    );
    if (state.duplicate) return state.proposal.revision;
    if (shouldResetFrozenProposalReview(state.proposal.status)) {
      await tx.delete(agentProposalHunks).where(eq(agentProposalHunks.proposalId, proposalId));
      await tx
        .update(agentProposalChanges)
        .set({ decision: 'pending', updatedAt: new Date() })
        .where(eq(agentProposalChanges.proposalId, proposalId));
    }
    const [count] = await tx
      .select({ value: sql<number>`count(*)::int` })
      .from(agentProposalChanges)
      .where(eq(agentProposalChanges.proposalId, proposalId));
    const currentCount = count?.value ?? 0;
    if (currentCount + normalized.length > agentProposalLimits.maxChangedEntries)
      throw quotaExceeded('Proposal has too many changed entries');
    await tx.insert(agentProposalChanges).values(
      normalized.map((item, index) => ({
        proposalId,
        ...item,
        sortOrder: currentCount + index,
      })),
    );
    const nextRevision = state.proposal.revision + 1;
    await tx
      .update(agentProposals)
      .set({
        revision: nextRevision,
        status: 'draft',
        conflictPaths: [],
        latestCompileJobId: null,
        resolvedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(agentProposals.id, proposalId));
    await tx.insert(agentProposalMutations).values({
      proposalId,
      idempotencyKey: input.idempotencyKey,
      resultingRevision: nextRevision,
    });
    return nextRevision;
  });
  await context.db.insert(auditEvents).values({
    userId: identity.userId,
    projectId: proposal.projectId,
    action: 'agent_proposal.structure_updated',
    details: {
      proposalId,
      revision,
      clientId: identity.clientId,
      changeCount: normalized.length,
      reopenedReview: shouldResetFrozenProposalReview(proposal.status),
    },
  });
  await publishProposal(context, proposalId, revision);
  return getAgentProposal(context, identity.userId, proposalId);
}

export async function finishAgentProposal(
  context: AppContext,
  identity: AgentIdentity,
  proposalId: string,
  input: { expectedProposalRevision: number; idempotencyKey: string },
) {
  const proposal = await loadAgentOwnedProposal(context, identity, proposalId);
  await requireGrantedProject(context, identity, proposal.projectId);
  if (proposal.revision !== input.expectedProposalRevision)
    return getAgentProposal(context, identity.userId, proposalId);
  const changes = await context.db
    .select()
    .from(agentProposalChanges)
    .where(eq(agentProposalChanges.proposalId, proposalId))
    .orderBy(asc(agentProposalChanges.sortOrder));
  if (!changes.length) throw badRequest('A proposal must contain at least one change');
  const { rows, paths } = await projectEntries(context, proposal.projectId);
  const conflicts: string[] = [];
  const frozen: Array<ReturnType<typeof createFrozenHunks>[number]> = [];
  for (const change of changes) {
    if (change.operation !== 'create_file' && change.operation !== 'replace_file') {
      if (change.operation === 'create_folder') {
        if (
          change.targetPath &&
          rows.some(
            (entry) =>
              (paths.get(entry.id) ?? entry.name).toLowerCase() ===
              change.targetPath?.toLowerCase(),
          )
        )
          conflicts.push(change.targetPath);
      } else {
        const accepted = change.entryId ? rows.find((entry) => entry.id === change.entryId) : null;
        if (!accepted || paths.get(accepted.id) !== change.basePath)
          conflicts.push(change.basePath ?? 'unknown');
      }
      continue;
    }
    const accepted = change.entryId ? rows.find((entry) => entry.id === change.entryId) : null;
    if (
      change.operation === 'replace_file' &&
      (!accepted ||
        accepted.version !== change.baseVersion ||
        paths.get(accepted.id) !== change.basePath)
    ) {
      conflicts.push(change.basePath ?? 'unknown');
      continue;
    }
    const before = change.entryId
      ? decodeUtf8(
          await context.storage.getBuffer(
            (await getFileWithBlob(context.db, proposal.projectId, change.entryId)).blob.objectKey,
          ),
        )
      : '';
    const after = change.contentObjectKey
      ? decodeUtf8(await context.storage.getBuffer(change.contentObjectKey))
      : '';
    frozen.push(...createFrozenHunks(change.id, before, after));
  }
  if (frozen.length > agentProposalLimits.maxFrozenHunks)
    throw quotaExceeded('Proposal contains too many review hunks');
  const hunkChangeIds = new Set(frozen.map((hunk) => hunk.changeId));
  const noOpTextChangeIds = changes
    .filter(
      (change) =>
        (change.operation === 'create_file' || change.operation === 'replace_file') &&
        !hunkChangeIds.has(change.id),
    )
    .map((change) => change.id);
  const structuralCount = changes.filter(
    (change) =>
      change.operation === 'create_folder' ||
      change.operation === 'move' ||
      change.operation === 'delete',
  ).length;
  const resolvedWithoutReview = !conflicts.length && frozen.length === 0 && structuralCount === 0;
  const revision = await context.db.transaction(async (tx) => {
    const state = await assertDraftMutation(
      tx,
      proposalId,
      identity.userId,
      input.expectedProposalRevision,
      input.idempotencyKey,
    );
    if (state.duplicate) return state.proposal.revision;
    const nextRevision = state.proposal.revision + 1;
    await tx.delete(agentProposalHunks).where(eq(agentProposalHunks.proposalId, proposalId));
    if (frozen.length)
      await tx.insert(agentProposalHunks).values(
        frozen.map((hunk) => ({
          id: hunk.id,
          proposalId,
          changeId: hunk.changeId,
          baseStart: hunk.baseStart,
          baseEnd: hunk.baseEnd,
          baseText: hunk.baseText,
          replacementText: hunk.replacementText,
          contentHash: hunk.contentHash,
          sortOrder: hunk.order,
        })),
      );
    if (noOpTextChangeIds.length)
      await tx
        .update(agentProposalChanges)
        .set({ decision: 'rejected', updatedAt: new Date() })
        .where(inArray(agentProposalChanges.id, noOpTextChangeIds));
    await tx
      .update(agentProposals)
      .set({
        revision: nextRevision,
        status: conflicts.length
          ? 'needs_rebase'
          : resolvedWithoutReview
            ? 'resolved'
            : 'reviewing',
        conflictPaths: conflicts,
        resolvedAt: resolvedWithoutReview ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(agentProposals.id, proposalId));
    await tx.insert(agentProposalMutations).values({
      proposalId,
      idempotencyKey: input.idempotencyKey,
      resultingRevision: nextRevision,
    });
    return nextRevision;
  });
  await context.db.insert(auditEvents).values({
    userId: identity.userId,
    projectId: proposal.projectId,
    action: conflicts.length
      ? 'agent_proposal.rebase_required'
      : resolvedWithoutReview
        ? 'agent_proposal.resolved_no_changes'
        : 'agent_proposal.frozen',
    details: { proposalId, conflictCount: conflicts.length },
  });
  await publishProposal(context, proposalId, revision);
  return getAgentProposal(context, identity.userId, proposalId);
}

export async function requestProposalCompilation(
  context: AppContext,
  identity: AgentIdentity,
  proposalId: string,
  input: { expectedProposalRevision: number; idempotencyKey: string },
) {
  const proposal = await loadAgentOwnedProposal(context, identity, proposalId);
  await requireGrantedProject(context, identity, proposal.projectId);
  if (proposal.revision !== input.expectedProposalRevision)
    return getAgentProposal(context, identity.userId, proposalId);
  const [existing] = await context.db
    .select()
    .from(compileJobs)
    .where(
      and(
        eq(compileJobs.proposalId, proposalId),
        eq(compileJobs.proposalRevision, proposal.revision),
        inArray(compileJobs.status, ['queued', 'running', 'succeeded']),
      ),
    )
    .orderBy(desc(compileJobs.createdAt))
    .limit(1);
  if (existing) {
    if (proposal.latestCompileJobId !== existing.id)
      await context.db
        .update(agentProposals)
        .set({ latestCompileJobId: existing.id, updatedAt: new Date() })
        .where(eq(agentProposals.id, proposalId));
    return getAgentProposal(context, identity.userId, proposalId);
  }
  const project = await requireGrantedProject(context, identity, proposal.projectId);
  if (!project.mainFileId) throw badRequest('Select a main .tex file before compiling');
  const manifest = await createProposalManifest(context, proposal);
  const [checkpoint] = await context.db
    .insert(checkpoints)
    .values({
      projectId: proposal.projectId,
      sourceRevision: project.sourceRevision,
      reason: 'proposal',
      target: 'proposal',
      proposalId,
      proposalRevision: proposal.revision,
      manifest,
    })
    .returning();
  if (!checkpoint) throw new Error('Proposal checkpoint was not created');
  const [job] = await context.db
    .insert(compileJobs)
    .values({
      projectId: proposal.projectId,
      checkpointId: checkpoint.id,
      sourceRevision: project.sourceRevision,
      engine: project.compiler,
      trigger: 'agent',
      target: 'proposal',
      proposalId,
      proposalRevision: proposal.revision,
    })
    .returning();
  if (!job) throw new Error('Proposal compile job was not created');
  await context.db
    .update(agentProposals)
    .set({ latestCompileJobId: job.id, updatedAt: new Date() })
    .where(eq(agentProposals.id, proposalId));
  await context.queue.add(
    'compile',
    { compileJobId: job.id },
    {
      jobId: job.id,
      attempts: 2,
      backoff: { type: 'fixed', delay: 1_000 },
      removeOnComplete: 500,
      removeOnFail: 500,
    },
  );
  await context.db.insert(auditEvents).values({
    userId: identity.userId,
    projectId: proposal.projectId,
    action: 'agent_proposal.compile_requested',
    details: { proposalId, revision: proposal.revision, clientId: identity.clientId },
  });
  await publishProposal(context, proposalId, proposal.revision);
  return getAgentProposal(context, identity.userId, proposalId);
}

async function createProposalManifest(
  context: AppContext,
  proposal: typeof agentProposals.$inferSelect,
): Promise<CheckpointManifestEntry[]> {
  const { rows, paths } = await projectEntries(context, proposal.projectId);
  const files = rows.filter((entry) => entry.kind === 'file' && entry.currentVersionId);
  const versionIds = files.flatMap((entry) =>
    entry.currentVersionId ? [entry.currentVersionId] : [],
  );
  const versions = await context.db
    .select({ version: fileVersions, blob: fileBlobs })
    .from(fileVersions)
    .innerJoin(fileBlobs, eq(fileVersions.blobHash, fileBlobs.hash))
    .where(inArray(fileVersions.id, versionIds));
  const byVersion = new Map(versions.map((row) => [row.version.id, row]));
  const manifest = new Map<string, CheckpointManifestEntry>();
  for (const entry of files) {
    if (!entry.currentVersionId) continue;
    const pair = byVersion.get(entry.currentVersionId);
    const path = paths.get(entry.id);
    if (!pair || !path) throw new Error('Accepted project snapshot is incomplete');
    manifest.set(entry.id, {
      entryId: entry.id,
      path,
      versionId: pair.version.id,
      blobHash: pair.blob.hash,
      objectKey: pair.blob.objectKey,
      size: pair.blob.size,
      mimeType: entry.mimeType,
      source: { kind: 'accepted', versionId: pair.version.id },
    });
  }
  const changes = await context.db
    .select()
    .from(agentProposalChanges)
    .where(eq(agentProposalChanges.proposalId, proposal.id))
    .orderBy(asc(agentProposalChanges.sortOrder));
  for (const change of changes) {
    if (change.decision === 'rejected' || change.decision === 'conflicted') continue;
    if (change.operation === 'delete' && change.basePath) {
      for (const [id, item] of manifest)
        if (item.path === change.basePath || item.path.startsWith(`${change.basePath}/`))
          manifest.delete(id);
      continue;
    }
    if (change.operation === 'move' && change.basePath && change.targetPath) {
      for (const item of manifest.values())
        if (item.path === change.basePath || item.path.startsWith(`${change.basePath}/`))
          item.path = `${change.targetPath}${item.path.slice(change.basePath.length)}`;
      continue;
    }
    if (change.operation !== 'create_file' && change.operation !== 'replace_file') continue;
    const targetPath = change.targetPath;
    if (!targetPath || !change.contentObjectKey || !change.contentHash) continue;
    let content = decodeUtf8(await context.storage.getBuffer(change.contentObjectKey));
    if (proposal.status === 'reviewing') {
      const [baseBlob] = change.baseVersionId
        ? await context.db
            .select({ objectKey: fileBlobs.objectKey })
            .from(fileVersions)
            .innerJoin(fileBlobs, eq(fileVersions.blobHash, fileBlobs.hash))
            .where(eq(fileVersions.id, change.baseVersionId))
            .limit(1)
        : [];
      if (change.baseVersionId && !baseBlob)
        throw conflict('Proposal base content is no longer available');
      const baseContent = baseBlob
        ? decodeUtf8(await context.storage.getBuffer(baseBlob.objectKey))
        : '';
      const hunks = await context.db
        .select()
        .from(agentProposalHunks)
        .where(
          and(
            eq(agentProposalHunks.changeId, change.id),
            inArray(agentProposalHunks.decision, ['pending', 'accepted']),
          ),
        );
      content = projectAcceptedHunks(baseContent, hunks.map(toProjectionHunk));
    }
    const bytes = Buffer.from(content);
    const hash = sha256(bytes);
    const objectKey = `proposals/${proposal.userId}/${proposal.projectId}/${proposal.id}/checkpoints/${hash}`;
    await context.storage.put(objectKey, bytes, 'text/plain; charset=utf-8');
    const existing = change.entryId ? manifest.get(change.entryId) : undefined;
    manifest.set(change.entryId ?? change.id, {
      entryId: change.entryId ?? change.id,
      path: targetPath,
      versionId: null,
      blobHash: hash,
      objectKey,
      size: bytes.byteLength,
      mimeType: existing?.mimeType ?? 'text/plain',
      source: {
        kind: 'proposal',
        proposalId: proposal.id,
        revision: proposal.revision,
        contentHash: hash,
      },
    });
  }
  return [...manifest.values()];
}

export async function decideProposalItem(
  context: AppContext,
  userId: string,
  proposalId: string,
  input: { expectedProposalRevision: number; itemId: string; decision: 'accepted' | 'rejected' },
) {
  const proposal = await loadOwnedProposal(context, userId, proposalId);
  if (proposal.status !== 'reviewing') throw conflict('Proposal is not ready for review');
  if (proposal.revision !== input.expectedProposalRevision)
    throw conflict('Proposal revision is stale', { proposalId, revision: proposal.revision });
  const [hunk] = await context.db
    .select()
    .from(agentProposalHunks)
    .where(
      and(eq(agentProposalHunks.id, input.itemId), eq(agentProposalHunks.proposalId, proposalId)),
    )
    .limit(1);
  if (!hunk) {
    const [structural] = await context.db
      .select()
      .from(agentProposalChanges)
      .where(
        and(
          eq(agentProposalChanges.id, input.itemId),
          eq(agentProposalChanges.proposalId, proposalId),
          inArray(agentProposalChanges.operation, ['create_folder', 'move', 'delete']),
        ),
      )
      .limit(1);
    if (!structural) throw notFound('Proposal item not found');
    if (structural.decision === 'conflicted') {
      if (input.decision !== 'rejected') return getAgentProposal(context, userId, proposalId);
      const [rejected] = await context.db
        .update(agentProposalChanges)
        .set({ decision: 'rejected', updatedAt: new Date() })
        .where(
          and(
            eq(agentProposalChanges.id, structural.id),
            eq(agentProposalChanges.decision, 'conflicted'),
          ),
        )
        .returning();
      if (!rejected) throw conflict('Proposal item changed in another tab');
      const revision = await settleProposal(context, proposalId);
      await publishProposal(context, proposalId, revision);
      return getAgentProposal(context, userId, proposalId);
    }
    if (structural.decision !== 'pending') return getAgentProposal(context, userId, proposalId);
    if (input.decision === 'accepted') {
      try {
        const revision = await acceptStructuralChange(context, proposal, structural);
        await context.db.insert(auditEvents).values({
          userId,
          projectId: proposal.projectId,
          action: 'agent_proposal.structure_accepted',
          details: { proposalId, changeId: structural.id, clientId: proposal.clientId },
        });
        await publishProposal(context, proposalId, revision);
        return getAgentProposal(context, userId, proposalId);
      } catch (error) {
        if (!(error instanceof HttpError) || error.statusCode !== 409) throw error;
        const [conflictedChange] = await context.db
          .update(agentProposalChanges)
          .set({ decision: 'conflicted', updatedAt: new Date() })
          .where(
            and(
              eq(agentProposalChanges.id, structural.id),
              eq(agentProposalChanges.decision, 'pending'),
            ),
          )
          .returning();
        if (!conflictedChange) throw conflict('Proposal item changed in another tab');
        const revision = await settleProposal(context, proposalId);
        await context.db.insert(auditEvents).values({
          userId,
          projectId: proposal.projectId,
          action: 'agent_proposal.structure_conflicted',
          details: { proposalId, changeId: structural.id, clientId: proposal.clientId },
        });
        await publishProposal(context, proposalId, revision);
        return getAgentProposal(context, userId, proposalId);
      }
    }
    const [updatedChange] = await context.db
      .update(agentProposalChanges)
      .set({ decision: input.decision, updatedAt: new Date() })
      .where(
        and(
          eq(agentProposalChanges.id, structural.id),
          eq(agentProposalChanges.decision, 'pending'),
        ),
      )
      .returning();
    if (!updatedChange) throw conflict('Proposal item changed in another tab');
    const revision = await settleProposal(context, proposalId);
    await context.db.insert(auditEvents).values({
      userId,
      projectId: proposal.projectId,
      action: `agent_proposal.structure_${input.decision}`,
      details: { proposalId, changeId: structural.id, clientId: proposal.clientId },
    });
    await publishProposal(context, proposalId, revision);
    return getAgentProposal(context, userId, proposalId);
  }
  if (hunk.decision === 'conflicted') {
    if (input.decision !== 'rejected') return getAgentProposal(context, userId, proposalId);
    const [rejected] = await context.db
      .update(agentProposalHunks)
      .set({ decision: 'rejected', updatedAt: new Date() })
      .where(and(eq(agentProposalHunks.id, hunk.id), eq(agentProposalHunks.decision, 'conflicted')))
      .returning();
    if (!rejected) throw conflict('Proposal item changed in another tab');
    const revision = await settleProposal(context, proposalId);
    await publishProposal(context, proposalId, revision);
    return getAgentProposal(context, userId, proposalId);
  }
  if (hunk.decision !== 'pending') return getAgentProposal(context, userId, proposalId);
  const [change] = await context.db
    .select()
    .from(agentProposalChanges)
    .where(eq(agentProposalChanges.id, hunk.changeId))
    .limit(1);
  if (!change) throw notFound('Proposal change not found');
  if (input.decision === 'accepted') {
    const acceptance = await acceptTextHunk(context, proposal, change, hunk);
    if (acceptance === false) {
      const [conflictedHunk] = await context.db
        .update(agentProposalHunks)
        .set({ decision: 'conflicted', updatedAt: new Date() })
        .where(and(eq(agentProposalHunks.id, hunk.id), eq(agentProposalHunks.decision, 'pending')))
        .returning();
      if (!conflictedHunk) throw conflict('Proposal item changed in another tab');
      const revision = await settleProposal(context, proposalId);
      await context.db.insert(auditEvents).values({
        userId,
        projectId: proposal.projectId,
        action: 'agent_proposal.hunk_conflicted',
        details: { proposalId, hunkId: hunk.id, clientId: proposal.clientId },
      });
      await publishProposal(context, proposalId, revision);
      return getAgentProposal(context, userId, proposalId);
    }
    await context.db.insert(auditEvents).values({
      userId,
      projectId: proposal.projectId,
      action: 'agent_proposal.hunk_accepted',
      details: { proposalId, hunkId: hunk.id, clientId: proposal.clientId },
    });
    await publishProposal(context, proposalId, acceptance);
    return getAgentProposal(context, userId, proposalId);
  }
  const [updated] = await context.db
    .update(agentProposalHunks)
    .set({ decision: input.decision, updatedAt: new Date() })
    .where(and(eq(agentProposalHunks.id, hunk.id), eq(agentProposalHunks.decision, 'pending')))
    .returning();
  if (!updated) throw conflict('Proposal item changed in another tab');
  const revision = await settleProposal(context, proposalId);
  await context.db.insert(auditEvents).values({
    userId,
    projectId: proposal.projectId,
    action: `agent_proposal.hunk_${input.decision}`,
    details: { proposalId, hunkId: hunk.id, clientId: proposal.clientId },
  });
  await publishProposal(context, proposalId, revision);
  return getAgentProposal(context, userId, proposalId);
}

async function acceptStructuralChange(
  context: AppContext,
  proposal: typeof agentProposals.$inferSelect,
  change: typeof agentProposalChanges.$inferSelect,
) {
  return context.db.transaction(async (tx) => {
    await tx.execute(
      sql`select ${agentProposalChanges.id} from ${agentProposalChanges} where ${agentProposalChanges.id} = ${change.id} for update`,
    );
    const [lockedChange] = await tx
      .select()
      .from(agentProposalChanges)
      .where(eq(agentProposalChanges.id, change.id))
      .limit(1);
    if (lockedChange?.decision !== 'pending')
      throw conflict('Proposal item changed in another tab');
    await applyStructuralChange(context, tx, proposal, lockedChange);
    await tx
      .update(agentProposalChanges)
      .set({ decision: 'accepted', updatedAt: new Date() })
      .where(eq(agentProposalChanges.id, change.id));
    await tx
      .update(projects)
      .set({ sourceRevision: sql`${projects.sourceRevision} + 1`, updatedAt: new Date() })
      .where(eq(projects.id, proposal.projectId));
    return settleProposalWithDatabase(tx, proposal.id);
  });
}

async function applyStructuralChange(
  context: AppContext,
  database: Database | DatabaseTransaction,
  proposal: typeof agentProposals.$inferSelect,
  change: typeof agentProposalChanges.$inferSelect,
) {
  const tree = await projectEntries(context, proposal.projectId, database);
  const byPath = new Map(tree.rows.map((entry) => [tree.paths.get(entry.id) ?? entry.name, entry]));
  const collides = (target: string, ignoredEntryId?: string | null) =>
    [...byPath.entries()].some(
      ([path, entry]) => path.toLowerCase() === target.toLowerCase() && entry.id !== ignoredEntryId,
    );
  if (change.operation === 'create_folder') {
    const target = change.targetPath;
    if (!target || collides(target)) throw conflict('The target path is no longer available');
    const split = target.lastIndexOf('/');
    const parentPath = split < 0 ? null : target.slice(0, split);
    const name = split < 0 ? target : target.slice(split + 1);
    const parent = parentPath ? byPath.get(parentPath) : null;
    if (parentPath && (!parent || parent.kind !== 'folder'))
      throw conflict('Target folder changed');
    await database.insert(entries).values({
      projectId: proposal.projectId,
      parentId: parent?.id ?? null,
      name,
      kind: 'folder',
    });
  } else {
    const entry = change.basePath ? byPath.get(change.basePath) : null;
    if (!entry || entry.id !== change.entryId) throw conflict('The source path changed');
    if (change.operation === 'move') {
      const target = change.targetPath;
      if (!target || collides(target, entry.id))
        throw conflict('The target path is no longer available');
      const split = target.lastIndexOf('/');
      const parentPath = split < 0 ? null : target.slice(0, split);
      const name = split < 0 ? target : target.slice(split + 1);
      const parent = parentPath ? byPath.get(parentPath) : null;
      if (parentPath && (!parent || parent.kind !== 'folder'))
        throw conflict('Target folder changed');
      await database
        .update(entries)
        .set({ parentId: parent?.id ?? null, name, updatedAt: new Date() })
        .where(eq(entries.id, entry.id));
    } else if (change.operation === 'delete') {
      const ids = tree.rows
        .filter((candidate) => {
          const path = tree.paths.get(candidate.id);
          return path === change.basePath || Boolean(path?.startsWith(`${change.basePath}/`));
        })
        .map((candidate) => candidate.id);
      await database.delete(entries).where(inArray(entries.id, ids));
    }
  }
}

async function acceptTextHunk(
  context: AppContext,
  proposal: typeof agentProposals.$inferSelect,
  change: typeof agentProposalChanges.$inferSelect,
  selected: typeof agentProposalHunks.$inferSelect,
): Promise<number | false> {
  const historySummary = `Agent proposal: ${proposal.title} (${proposal.clientName})`;
  const all = await context.db
    .select()
    .from(agentProposalHunks)
    .where(eq(agentProposalHunks.changeId, change.id))
    .orderBy(asc(agentProposalHunks.sortOrder));
  const base = change.baseVersionId
    ? await context.db
        .select({ blob: fileBlobs })
        .from(fileVersions)
        .innerJoin(fileBlobs, eq(fileVersions.blobHash, fileBlobs.hash))
        .where(eq(fileVersions.id, change.baseVersionId))
        .limit(1)
    : [];
  const baseContent = base[0]
    ? decodeUtf8(await context.storage.getBuffer(base[0].blob.objectKey))
    : '';
  const accepted = all.filter((hunk) => hunk.decision === 'accepted');
  const expected = projectAcceptedHunks(baseContent, accepted.map(toProjectionHunk));
  const next = projectAcceptedHunks(baseContent, [...accepted, selected].map(toProjectionHunk));
  if (!change.entryId) {
    const parentPath = change.targetPath?.includes('/')
      ? change.targetPath.slice(0, change.targetPath.lastIndexOf('/'))
      : null;
    const name = change.targetPath?.split('/').at(-1);
    if (!name) throw new Error('New proposal file path is missing');
    const { rows, paths } = await projectEntries(context, proposal.projectId);
    const parent = parentPath ? rows.find((entry) => paths.get(entry.id) === parentPath) : null;
    if (parentPath && (!parent || parent.kind !== 'folder'))
      throw conflict('Target folder changed');
    const bytes = Buffer.from(next);
    const hash = sha256(bytes);
    const objectKey = `blobs/${hash.slice(0, 2)}/${hash}`;
    const historyRootId = deterministicUuid(`${proposal.id}\0history-root\0${selected.id}`);
    await context.storage.put(objectKey, bytes, 'text/plain');
    const result = await context.db.transaction(async (tx) => {
      await tx.execute(
        sql`select ${agentProposalHunks.id} from ${agentProposalHunks} where ${agentProposalHunks.id} = ${selected.id} for update`,
      );
      const [lockedHunk] = await tx
        .select()
        .from(agentProposalHunks)
        .where(eq(agentProposalHunks.id, selected.id))
        .limit(1);
      if (lockedHunk?.decision !== 'pending')
        throw conflict('Proposal item changed in another tab');
      const lockedTree = await projectEntries(context, proposal.projectId, tx);
      if (
        change.targetPath &&
        lockedTree.rows.some(
          (candidate) =>
            (lockedTree.paths.get(candidate.id) ?? candidate.name).toLowerCase() ===
            change.targetPath?.toLowerCase(),
        )
      )
        throw conflict('The target path is no longer available');
      const lockedParent = parentPath
        ? lockedTree.rows.find((candidate) => lockedTree.paths.get(candidate.id) === parentPath)
        : null;
      if (parentPath && (!lockedParent || lockedParent.kind !== 'folder'))
        throw conflict('Target folder changed');
      const [entry] = await tx
        .insert(entries)
        .values({
          projectId: proposal.projectId,
          parentId: lockedParent?.id ?? null,
          name,
          kind: 'file',
          mimeType: 'text/plain',
        })
        .returning();
      if (!entry) throw new Error('Proposed file was not created');
      await tx
        .insert(fileBlobs)
        .values({ hash, objectKey, size: bytes.byteLength })
        .onConflictDoUpdate({
          target: fileBlobs.hash,
          set: { refCount: sql`${fileBlobs.refCount} + 1` },
        });
      const [version] = await tx
        .insert(fileVersions)
        .values({ entryId: entry.id, blobHash: hash, version: 1 })
        .returning();
      if (!version) throw new Error('File version was not created');
      await tx
        .update(entries)
        .set({ currentVersionId: version.id, version: 1, size: bytes.byteLength })
        .where(eq(entries.id, entry.id));
      const finalHistoryObjectKey = `edit-history/${proposal.projectId}/${entry.id}/${historyRootId}.txt.gz`;
      await context.storage.put(finalHistoryObjectKey, gzipSync(next), 'application/gzip');
      await tx.insert(editorHistoryNodes).values({
        id: historyRootId,
        entryId: entry.id,
        parentId: null,
        depth: 0,
        beforeHash: hash,
        afterHash: hash,
        patch: [],
        snapshotObjectKey: finalHistoryObjectKey,
        summary: historySummary,
        clientMutationId: selected.id,
      });
      await tx.insert(editorHistoryState).values({
        entryId: entry.id,
        currentNodeId: historyRootId,
      });
      await tx
        .update(agentProposalChanges)
        .set({ entryId: entry.id, baseVersion: 0, updatedAt: new Date() })
        .where(eq(agentProposalChanges.id, change.id));
      await tx
        .update(agentProposalHunks)
        .set({ decision: 'accepted', updatedAt: new Date() })
        .where(eq(agentProposalHunks.id, selected.id));
      await tx
        .update(projects)
        .set({ sourceRevision: sql`${projects.sourceRevision} + 1`, updatedAt: new Date() })
        .where(eq(projects.id, proposal.projectId));
      const revision = await settleProposalWithDatabase(tx, proposal.id);
      return { entry, revision };
    });
    return result.revision;
  }
  const current = await getFileWithBlob(context.db, proposal.projectId, change.entryId);
  const currentContent = decodeUtf8(await context.storage.getBuffer(current.blob.objectKey));
  if (currentContent !== expected) {
    return false;
  }
  await ensureHistoryRoot(context, proposal.projectId, current.entry.id);
  return strictStoreVersion(
    context,
    current.entry,
    current.blob.hash,
    currentContent,
    next,
    historySummary,
    selected.id,
    proposal.id,
  );
}

function toProjectionHunk(hunk: typeof agentProposalHunks.$inferSelect) {
  return {
    baseStart: hunk.baseStart,
    baseEnd: hunk.baseEnd,
    replacementText: hunk.replacementText,
  };
}

async function strictStoreVersion(
  context: AppContext,
  entry: typeof entries.$inferSelect,
  expectedHash: string,
  before: string,
  content: string,
  summary: string,
  clientMutationId: string,
  proposalId: string,
) {
  const bytes = Buffer.from(content);
  const hash = sha256(bytes);
  const objectKey = `blobs/${hash.slice(0, 2)}/${hash}`;
  await context.storage.put(objectKey, bytes, entry.mimeType ?? 'text/plain');
  return context.db.transaction(async (tx) => {
    await tx.execute(
      sql`select ${agentProposalHunks.id} from ${agentProposalHunks} where ${agentProposalHunks.id} = ${clientMutationId} for update`,
    );
    const [lockedHunk] = await tx
      .select()
      .from(agentProposalHunks)
      .where(eq(agentProposalHunks.id, clientMutationId))
      .limit(1);
    if (lockedHunk?.decision !== 'pending') throw conflict('Proposal item changed in another tab');
    await tx.execute(
      sql`select ${entries.id} from ${entries} where ${entries.id} = ${entry.id} for update`,
    );
    const [current] = await tx
      .select({ entry: entries, blob: fileBlobs })
      .from(entries)
      .innerJoin(fileVersions, eq(entries.currentVersionId, fileVersions.id))
      .innerJoin(fileBlobs, eq(fileVersions.blobHash, fileBlobs.hash))
      .where(eq(entries.id, entry.id))
      .limit(1);
    if (!current || current.blob.hash !== expectedHash) return false;
    const [historyState] = await tx
      .select()
      .from(editorHistoryState)
      .where(eq(editorHistoryState.entryId, entry.id))
      .limit(1);
    const [historyParent] = historyState
      ? await tx
          .select()
          .from(editorHistoryNodes)
          .where(eq(editorHistoryNodes.id, historyState.currentNodeId))
          .limit(1)
      : [];
    if (!historyParent || historyParent.afterHash !== expectedHash) return false;
    await tx
      .insert(fileBlobs)
      .values({ hash, objectKey, size: bytes.byteLength })
      .onConflictDoUpdate({
        target: fileBlobs.hash,
        set: { refCount: sql`${fileBlobs.refCount} + 1` },
      });
    const nextVersion = current.entry.version + 1;
    const [version] = await tx
      .insert(fileVersions)
      .values({ entryId: entry.id, blobHash: hash, version: nextVersion })
      .returning();
    if (!version) throw new Error('File version was not created');
    await tx
      .update(entries)
      .set({
        currentVersionId: version.id,
        version: nextVersion,
        size: bytes.byteLength,
        updatedAt: new Date(),
      })
      .where(eq(entries.id, entry.id));
    await tx
      .update(projects)
      .set({ sourceRevision: sql`${projects.sourceRevision} + 1`, updatedAt: new Date() })
      .where(eq(projects.id, entry.projectId));
    await createHistoryNode(
      context,
      {
        projectId: entry.projectId,
        entryId: entry.id,
        parent: historyParent,
        before,
        after: content,
        summary,
        selectionBefore: null,
        selectionAfter: null,
        clientMutationId,
        deviceId: undefined,
        sessionId: undefined,
        makeCurrent: true,
      },
      tx,
    );
    await tx
      .update(agentProposalHunks)
      .set({ decision: 'accepted', updatedAt: new Date() })
      .where(eq(agentProposalHunks.id, clientMutationId));
    return settleProposalWithDatabase(tx, proposalId);
  });
}

async function settleProposal(context: AppContext, proposalId: string) {
  return settleProposalWithDatabase(context.db, proposalId);
}

async function settleProposalWithDatabase(
  database: Database | DatabaseTransaction,
  proposalId: string,
) {
  const pendingHunks = await database
    .select({ value: sql<number>`count(*)::int` })
    .from(agentProposalHunks)
    .where(
      and(
        eq(agentProposalHunks.proposalId, proposalId),
        inArray(agentProposalHunks.decision, ['pending', 'conflicted']),
      ),
    );
  const pendingChanges = await database
    .select({ value: sql<number>`count(*)::int` })
    .from(agentProposalChanges)
    .where(
      and(
        eq(agentProposalChanges.proposalId, proposalId),
        inArray(agentProposalChanges.decision, ['pending', 'conflicted']),
        inArray(agentProposalChanges.operation, ['create_folder', 'move', 'delete']),
      ),
    );
  const finished = (pendingHunks[0]?.value ?? 0) === 0 && (pendingChanges[0]?.value ?? 0) === 0;
  const [updated] = await database
    .update(agentProposals)
    .set({
      revision: sql`${agentProposals.revision} + 1`,
      ...(finished ? { status: 'resolved' as const, resolvedAt: new Date() } : {}),
      updatedAt: new Date(),
    })
    .where(eq(agentProposals.id, proposalId))
    .returning({ revision: agentProposals.revision });
  if (!updated) throw new Error('Proposal revision was not updated');
  return updated.revision;
}

export async function acceptRemainingProposalItems(
  context: AppContext,
  userId: string,
  proposalId: string,
  expectedRevision: number,
) {
  const proposal = await loadOwnedProposal(context, userId, proposalId);
  if (proposal.status !== 'reviewing') throw conflict('Proposal is not ready for review');
  if (proposal.revision !== expectedRevision)
    throw conflict('Proposal revision is stale', { proposalId, revision: proposal.revision });
  const changes = await context.db
    .select()
    .from(agentProposalChanges)
    .where(eq(agentProposalChanges.proposalId, proposalId))
    .orderBy(asc(agentProposalChanges.sortOrder));
  const hunks = await context.db
    .select()
    .from(agentProposalHunks)
    .where(eq(agentProposalHunks.proposalId, proposalId))
    .orderBy(asc(agentProposalHunks.sortOrder));
  const pendingHunks = hunks.filter((hunk) => hunk.decision === 'pending');
  const pendingStructures = changes.filter(
    (change) =>
      change.decision === 'pending' &&
      (change.operation === 'create_folder' ||
        change.operation === 'move' ||
        change.operation === 'delete'),
  );
  if (
    hunks.some((hunk) => hunk.decision === 'conflicted') ||
    changes.some((change) => change.decision === 'conflicted')
  )
    throw conflict('Resolve or reject conflicted items before accepting all remaining');
  if (!pendingHunks.length && !pendingStructures.length)
    return getAgentProposal(context, userId, proposalId);

  const textChanges = changes.filter(
    (change) => change.operation === 'create_file' || change.operation === 'replace_file',
  );
  const prepared = await Promise.all(
    textChanges.map(async (change) => {
      const changeHunks = hunks.filter((hunk) => hunk.changeId === change.id);
      const accepted = changeHunks.filter((hunk) => hunk.decision === 'accepted');
      const remaining = changeHunks.filter((hunk) => hunk.decision === 'pending');
      if (!remaining.length) return null;
      const baseRows = change.baseVersionId
        ? await context.db
            .select({ blob: fileBlobs })
            .from(fileVersions)
            .innerJoin(fileBlobs, eq(fileVersions.blobHash, fileBlobs.hash))
            .where(eq(fileVersions.id, change.baseVersionId))
            .limit(1)
        : [];
      if (change.baseVersionId && !baseRows[0])
        throw conflict('Proposal base content is no longer available');
      const baseContent = baseRows[0]
        ? decodeUtf8(await context.storage.getBuffer(baseRows[0].blob.objectKey))
        : '';
      const expectedContent = projectAcceptedHunks(baseContent, accepted.map(toProjectionHunk));
      const nextContent = projectAcceptedHunks(
        baseContent,
        [...accepted, ...remaining].map(toProjectionHunk),
      );
      const bytes = Buffer.from(nextContent);
      const hash = sha256(bytes);
      const objectKey = `blobs/${hash.slice(0, 2)}/${hash}`;
      await context.storage.put(objectKey, bytes, 'text/plain');
      if (change.entryId) await ensureHistoryRoot(context, proposal.projectId, change.entryId);
      return { change, expectedContent, nextContent, bytes, hash, objectKey };
    }),
  );
  const textUpdates = prepared.filter((item) => item !== null);
  const historySummary = `Agent proposal: ${proposal.title} (${proposal.clientName})`;
  const nextRevision = proposal.revision + 1;

  await context.db.transaction(async (tx) => {
    await tx.execute(
      sql`select ${agentProposals.id} from ${agentProposals} where ${agentProposals.id} = ${proposalId} for update`,
    );
    const [locked] = await tx
      .select()
      .from(agentProposals)
      .where(eq(agentProposals.id, proposalId))
      .limit(1);
    if (!locked || locked.status !== 'reviewing' || locked.revision !== expectedRevision)
      throw conflict('Proposal revision is stale', {
        proposalId,
        revision: locked?.revision ?? expectedRevision,
      });

    const creates = pendingStructures
      .filter((change) => change.operation === 'create_folder')
      .sort(
        (left, right) =>
          (left.targetPath?.split('/').length ?? 0) - (right.targetPath?.split('/').length ?? 0),
      );
    const moves = pendingStructures.filter((change) => change.operation === 'move');
    const deletes = pendingStructures
      .filter((change) => change.operation === 'delete')
      .sort(
        (left, right) =>
          (right.basePath?.split('/').length ?? 0) - (left.basePath?.split('/').length ?? 0),
      );
    for (const change of [...creates, ...moves])
      await applyStructuralChange(context, tx, proposal, change);

    for (const item of textUpdates) {
      let entry: typeof entries.$inferSelect;
      if (item.change.entryId) {
        await tx.execute(
          sql`select ${entries.id} from ${entries} where ${entries.id} = ${item.change.entryId} for update`,
        );
        const [current] = await tx
          .select({ entry: entries, blob: fileBlobs })
          .from(entries)
          .innerJoin(fileVersions, eq(entries.currentVersionId, fileVersions.id))
          .innerJoin(fileBlobs, eq(fileVersions.blobHash, fileBlobs.hash))
          .where(eq(entries.id, item.change.entryId))
          .limit(1);
        if (!current || current.blob.hash !== sha256(item.expectedContent))
          throw conflict('Accepted head changed; accept all was not applied', {
            path: item.change.targetPath,
          });
        entry = current.entry;
      } else {
        const target = item.change.targetPath;
        if (!target) throw new Error('Proposed file path is missing');
        const tree = await projectEntries(context, proposal.projectId, tx);
        const lowerTarget = target.toLowerCase();
        if (
          tree.rows.some(
            (candidate) =>
              (tree.paths.get(candidate.id) ?? candidate.name).toLowerCase() === lowerTarget,
          )
        )
          throw conflict('The target path is no longer available', { path: target });
        const split = target.lastIndexOf('/');
        const parentPath = split < 0 ? null : target.slice(0, split);
        const parent = parentPath
          ? tree.rows.find((candidate) => tree.paths.get(candidate.id) === parentPath)
          : null;
        if (parentPath && (!parent || parent.kind !== 'folder'))
          throw conflict('Target folder changed', { path: target });
        const [created] = await tx
          .insert(entries)
          .values({
            projectId: proposal.projectId,
            parentId: parent?.id ?? null,
            name: split < 0 ? target : target.slice(split + 1),
            kind: 'file',
            mimeType: 'text/plain',
          })
          .returning();
        if (!created) throw new Error('Proposed file was not created');
        entry = created;
        await tx
          .update(agentProposalChanges)
          .set({ entryId: created.id, baseVersion: 0, updatedAt: new Date() })
          .where(eq(agentProposalChanges.id, item.change.id));
      }
      await tx
        .insert(fileBlobs)
        .values({ hash: item.hash, objectKey: item.objectKey, size: item.bytes.byteLength })
        .onConflictDoUpdate({
          target: fileBlobs.hash,
          set: { refCount: sql`${fileBlobs.refCount} + 1` },
        });
      const nextVersion = entry.version + 1;
      const [version] = await tx
        .insert(fileVersions)
        .values({ entryId: entry.id, blobHash: item.hash, version: nextVersion })
        .returning();
      if (!version) throw new Error('File version was not created');
      await tx
        .update(entries)
        .set({
          currentVersionId: version.id,
          version: nextVersion,
          size: item.bytes.byteLength,
          updatedAt: new Date(),
        })
        .where(eq(entries.id, entry.id));
      if (!item.change.entryId) {
        const rootId = deterministicUuid(`${proposalId}\0bulk-root\0${item.change.id}`);
        const snapshotObjectKey = `edit-history/${proposal.projectId}/${entry.id}/${rootId}.txt.gz`;
        await context.storage.put(
          snapshotObjectKey,
          gzipSync(item.nextContent),
          'application/gzip',
        );
        await tx.insert(editorHistoryNodes).values({
          id: rootId,
          entryId: entry.id,
          parentId: null,
          depth: 0,
          beforeHash: item.hash,
          afterHash: item.hash,
          patch: [],
          snapshotObjectKey,
          summary: historySummary,
          clientMutationId: deterministicUuid(
            `${proposalId}\0bulk-root-mutation\0${item.change.id}`,
          ),
        });
        await tx.insert(editorHistoryState).values({ entryId: entry.id, currentNodeId: rootId });
      } else {
        const [state] = await tx
          .select()
          .from(editorHistoryState)
          .where(eq(editorHistoryState.entryId, entry.id))
          .limit(1);
        const [parent] = state
          ? await tx
              .select()
              .from(editorHistoryNodes)
              .where(eq(editorHistoryNodes.id, state.currentNodeId))
              .limit(1)
          : [];
        if (!parent || parent.afterHash !== sha256(item.expectedContent))
          throw conflict('Edit history changed while applying accept all');
        await createHistoryNode(
          context,
          {
            projectId: proposal.projectId,
            entryId: entry.id,
            parent,
            before: item.expectedContent,
            after: item.nextContent,
            summary: historySummary,
            selectionBefore: null,
            selectionAfter: null,
            clientMutationId: deterministicUuid(`${proposalId}\0bulk\0${item.change.id}`),
            deviceId: undefined,
            sessionId: undefined,
            makeCurrent: true,
          },
          tx,
        );
      }
    }

    for (const change of deletes) await applyStructuralChange(context, tx, proposal, change);
    await tx
      .update(agentProposalHunks)
      .set({ decision: 'accepted', updatedAt: new Date() })
      .where(
        and(
          eq(agentProposalHunks.proposalId, proposalId),
          eq(agentProposalHunks.decision, 'pending'),
        ),
      );
    await tx
      .update(agentProposalChanges)
      .set({ decision: 'accepted', updatedAt: new Date() })
      .where(
        and(
          eq(agentProposalChanges.proposalId, proposalId),
          eq(agentProposalChanges.decision, 'pending'),
        ),
      );
    const appliedCount = textUpdates.length + pendingStructures.length;
    if (appliedCount)
      await tx
        .update(projects)
        .set({
          sourceRevision: sql`${projects.sourceRevision} + ${appliedCount}`,
          updatedAt: new Date(),
        })
        .where(eq(projects.id, proposal.projectId));
    await tx
      .update(agentProposals)
      .set({
        status: 'resolved',
        revision: nextRevision,
        resolvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(agentProposals.id, proposalId));
    await tx.insert(auditEvents).values({
      userId,
      projectId: proposal.projectId,
      action: 'agent_proposal.remaining_accepted',
      details: { proposalId, clientId: proposal.clientId, itemCount: appliedCount },
    });
  });

  await publishProposal(context, proposalId, nextRevision);
  return getAgentProposal(context, userId, proposalId);
}

export async function rejectRemainingProposalItems(
  context: AppContext,
  userId: string,
  proposalId: string,
  expectedRevision: number,
) {
  const proposal = await loadOwnedProposal(context, userId, proposalId);
  if (!canOwnerDiscardProposal(proposal.status))
    throw conflict('Proposal can no longer be discarded');
  if (proposal.revision !== expectedRevision)
    throw conflict('Proposal revision is stale', { proposalId, revision: proposal.revision });
  await context.db.transaction(async (tx) => {
    await tx
      .update(agentProposalHunks)
      .set({ decision: 'rejected', updatedAt: new Date() })
      .where(
        and(
          eq(agentProposalHunks.proposalId, proposalId),
          inArray(agentProposalHunks.decision, ['pending', 'conflicted']),
        ),
      );
    await tx
      .update(agentProposalChanges)
      .set({ decision: 'rejected', updatedAt: new Date() })
      .where(
        and(
          eq(agentProposalChanges.proposalId, proposalId),
          inArray(agentProposalChanges.decision, ['pending', 'conflicted']),
        ),
      );
    await tx
      .update(agentProposals)
      .set({
        status: 'rejected',
        revision: proposal.revision + 1,
        resolvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(eq(agentProposals.id, proposalId), eq(agentProposals.revision, proposal.revision)),
      );
  });
  await context.db.insert(auditEvents).values({
    userId,
    projectId: proposal.projectId,
    action:
      proposal.status === 'reviewing'
        ? 'agent_proposal.remaining_rejected'
        : 'agent_proposal.unfinished_discarded',
    details: { proposalId, clientId: proposal.clientId },
  });
  await publishProposal(context, proposalId, proposal.revision + 1);
  return getAgentProposal(context, userId, proposalId);
}

export async function discardDraftProposalChange(
  context: AppContext,
  userId: string,
  projectId: string,
  proposalId: string,
  changeId: string,
  expectedRevision: number,
) {
  await requireProject(context.db, userId, projectId);
  const proposal = await loadOwnedProposal(context, userId, proposalId);
  if (proposal.projectId !== projectId) throw notFound('Proposal not found');
  if (!canOwnerDiscardDraftChange(proposal.status))
    throw conflict('Only unfinished draft changes can be discarded directly');
  if (proposal.revision !== expectedRevision)
    throw conflict('Proposal revision is stale', { proposalId, revision: proposal.revision });

  const nextRevision = await context.db.transaction(async (tx) => {
    await tx.execute(
      sql`select ${agentProposals.id} from ${agentProposals} where ${agentProposals.id} = ${proposalId} for update`,
    );
    const [locked] = await tx
      .select()
      .from(agentProposals)
      .where(and(eq(agentProposals.id, proposalId), eq(agentProposals.userId, userId)))
      .limit(1);
    if (!locked) throw notFound('Proposal not found');
    if (!canOwnerDiscardDraftChange(locked.status))
      throw conflict('Only unfinished draft changes can be discarded directly');
    assertProposalRevision(locked.revision, expectedRevision, proposalId);
    const [change] = await tx
      .select()
      .from(agentProposalChanges)
      .where(
        and(eq(agentProposalChanges.id, changeId), eq(agentProposalChanges.proposalId, proposalId)),
      )
      .limit(1);
    if (!change) throw notFound('Proposal change not found');
    await tx.delete(agentProposalChanges).where(eq(agentProposalChanges.id, changeId));
    const [remaining] = await tx
      .select({ value: sql<number>`count(*)::int` })
      .from(agentProposalChanges)
      .where(eq(agentProposalChanges.proposalId, proposalId));
    const empty = (remaining?.value ?? 0) === 0;
    const revision = locked.revision + 1;
    await tx
      .update(agentProposals)
      .set({
        revision,
        totalBytes: Math.max(0, locked.totalBytes - change.size),
        status: empty ? 'rejected' : 'draft',
        conflictPaths: [],
        latestCompileJobId: null,
        resolvedAt: empty ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(agentProposals.id, proposalId));
    return revision;
  });
  await context.db.insert(auditEvents).values({
    userId,
    projectId,
    action: 'agent_proposal.draft_change_discarded',
    details: { proposalId, changeId },
  });
  await publishProposal(context, proposalId, nextRevision);
  return getAgentProposal(context, userId, proposalId);
}

export async function reconcileProposalCompilation(
  context: AppContext,
  userId: string,
  proposalId: string,
) {
  const proposal = await loadOwnedProposal(context, userId, proposalId);
  const [project] = await context.db
    .select()
    .from(projects)
    .where(eq(projects.id, proposal.projectId))
    .limit(1);
  if (!project) return getAgentProposal(context, userId, proposalId);
  const serializedProposal = await getAgentProposal(context, userId, proposalId);
  if (proposal.status === 'resolved' && allProposalItemsAccepted(serializedProposal.changes)) {
    const compiledProposals = await context.db
      .select()
      .from(compileJobs)
      .where(
        and(
          eq(compileJobs.projectId, proposal.projectId),
          eq(compileJobs.target, 'proposal'),
          eq(compileJobs.proposalId, proposal.id),
          eq(compileJobs.status, 'succeeded'),
        ),
      )
      .orderBy(desc(compileJobs.createdAt))
      .limit(50);
    const acceptedManifest = await acceptedCheckpointManifest(context.db, proposal.projectId);
    let promotable:
      | {
          job: (typeof compiledProposals)[number];
          checkpoint: typeof checkpoints.$inferSelect;
        }
      | undefined;
    for (const job of compiledProposals) {
      if (!job.pdfObjectKey) continue;
      const [checkpoint] = await context.db
        .select()
        .from(checkpoints)
        .where(
          and(
            eq(checkpoints.id, job.checkpointId),
            eq(checkpoints.projectId, proposal.projectId),
            eq(checkpoints.target, 'proposal'),
            eq(checkpoints.proposalId, proposal.id),
          ),
        )
        .limit(1);
      if (checkpoint && checkpointContentMatches(checkpoint.manifest, acceptedManifest)) {
        promotable = { job, checkpoint };
        break;
      }
    }
    if (promotable) {
      const promoted = promotable;
      await context.db.transaction(async (tx) => {
        await tx
          .update(checkpoints)
          .set({
            sourceRevision: project.sourceRevision,
            target: 'accepted',
            proposalId: null,
            proposalRevision: null,
          })
          .where(
            and(
              eq(checkpoints.id, promoted.checkpoint.id),
              eq(checkpoints.projectId, proposal.projectId),
              eq(checkpoints.target, 'proposal'),
              eq(checkpoints.proposalId, proposal.id),
            ),
          );
        await tx
          .update(compileJobs)
          .set({
            sourceRevision: project.sourceRevision,
            target: 'accepted',
            proposalId: null,
            proposalRevision: null,
          })
          .where(
            and(
              eq(compileJobs.id, promoted.job.id),
              eq(compileJobs.target, 'proposal'),
              eq(compileJobs.proposalId, proposal.id),
              eq(compileJobs.status, 'succeeded'),
            ),
          );
        await tx
          .update(agentProposals)
          .set({ latestCompileJobId: promoted.job.id, updatedAt: new Date() })
          .where(eq(agentProposals.id, proposal.id));
        await tx.insert(auditEvents).values({
          userId,
          projectId: proposal.projectId,
          action: 'agent_proposal.compile_promoted',
          details: { proposalId, compileJobId: promoted.job.id },
        });
      });
      return getAgentProposal(context, userId, proposalId);
    }
  }
  return getAgentProposal(context, userId, proposalId);
}

function decodeStoredText(bytes: Uint8Array, label: string) {
  if (bytes.byteLength > agentProposalLimits.maxFileBytes)
    throw quotaExceeded(`${label} is too large`);
  return decodeUtf8(bytes);
}

export async function getAgentProposalFile(
  context: AppContext,
  userId: string,
  projectId: string,
  proposalId: string,
  rawPath: string,
) {
  await requireProject(context.db, userId, projectId);
  const proposal = await loadOwnedProposal(context, userId, proposalId);
  if (proposal.projectId !== projectId) throw notFound('Proposal not found');
  let path: string;
  try {
    path = normalizeArchivePath(rawPath);
  } catch {
    throw badRequest('Unsafe archive path');
  }
  const [change] = await context.db
    .select()
    .from(agentProposalChanges)
    .where(
      and(
        eq(agentProposalChanges.proposalId, proposalId),
        or(eq(agentProposalChanges.targetPath, path), eq(agentProposalChanges.basePath, path)),
      ),
    )
    .limit(1);
  if (
    !change ||
    change.entryKind === 'folder' ||
    change.operation === 'create_folder' ||
    change.operation === 'move' ||
    (change.operation !== 'delete' &&
      change.operation !== 'create_file' &&
      change.operation !== 'replace_file')
  )
    throw notFound('Proposal file not found');

  let baseText = '';
  let version = 0;
  if (change.operation !== 'create_file' && change.entryId) {
    const file = await getFileWithBlob(context.db, proposal.projectId, change.entryId);
    baseText = decodeStoredText(
      await context.storage.getBuffer(file.blob.objectKey),
      'Accepted file',
    );
    version = file.entry.version;
  }
  if (proposal.status === 'reviewing' && change.baseVersionId) {
    const [baseBlob] = await context.db
      .select({ objectKey: fileBlobs.objectKey })
      .from(fileVersions)
      .innerJoin(fileBlobs, eq(fileVersions.blobHash, fileBlobs.hash))
      .where(eq(fileVersions.id, change.baseVersionId))
      .limit(1);
    if (!baseBlob) throw conflict('Proposal base content is no longer available');
    baseText = decodeStoredText(
      await context.storage.getBuffer(baseBlob.objectKey),
      'Proposal base',
    );
  }

  let proposedText = baseText;
  let hash = change.contentHash ?? sha256(baseText);
  if (change.operation === 'delete') {
    proposedText = '';
    hash = sha256('');
  } else if (change.contentObjectKey) {
    proposedText = decodeStoredText(
      await context.storage.getBuffer(change.contentObjectKey),
      'Proposed file',
    );
    hash = change.contentHash ?? sha256(proposedText);
  }
  if (
    proposal.status === 'reviewing' &&
    (change.operation === 'create_file' || change.operation === 'replace_file')
  ) {
    const hunks = await context.db
      .select()
      .from(agentProposalHunks)
      .where(eq(agentProposalHunks.changeId, change.id))
      .orderBy(asc(agentProposalHunks.sortOrder));
    proposedText = projectAcceptedHunks(
      baseText,
      hunks.filter((hunk) => hunk.decision !== 'rejected').map(toProjectionHunk),
    );
    hash = sha256(proposedText);
  }
  if (
    Buffer.byteLength(baseText) > agentProposalLimits.maxFileBytes ||
    Buffer.byteLength(proposedText) > agentProposalLimits.maxFileBytes
  )
    throw quotaExceeded('Proposed file is too large');
  return { path, baseText, proposedText, version, hash };
}

export async function putOwnerProposalFile(
  context: AppContext,
  userId: string,
  projectId: string,
  proposalId: string,
  input: { expectedProposalRevision: number; path: string; content: string },
) {
  await requireProject(context.db, userId, projectId);
  const proposal = await loadOwnedProposal(context, userId, proposalId);
  if (proposal.projectId !== projectId) throw notFound('Proposal not found');
  if (!canOwnerReviseProposalFile(proposal.status))
    throw conflict('This proposal is frozen and can no longer be changed');
  let path: string;
  try {
    path = normalizeArchivePath(input.path);
  } catch {
    throw badRequest('Unsafe archive path');
  }
  const bytes = Buffer.from(input.content);
  const hash = sha256(bytes);
  const [preparedChange] = await context.db
    .select()
    .from(agentProposalChanges)
    .where(
      and(
        eq(agentProposalChanges.proposalId, proposalId),
        eq(agentProposalChanges.targetPath, path),
        inArray(agentProposalChanges.operation, ['create_file', 'replace_file']),
      ),
    )
    .limit(1);
  if (!preparedChange) throw notFound('Proposal file not found');
  let replacementHunks: ReturnType<typeof createFrozenHunks> | null = null;
  if (proposal.status === 'reviewing') {
    let baseText = '';
    if (preparedChange.baseVersionId) {
      const [baseBlob] = await context.db
        .select({ objectKey: fileBlobs.objectKey })
        .from(fileVersions)
        .innerJoin(fileBlobs, eq(fileVersions.blobHash, fileBlobs.hash))
        .where(eq(fileVersions.id, preparedChange.baseVersionId))
        .limit(1);
      if (!baseBlob) throw conflict('Proposal base content is no longer available');
      baseText = decodeStoredText(
        await context.storage.getBuffer(baseBlob.objectKey),
        'Proposal base',
      );
    }
    replacementHunks = createFrozenHunks(preparedChange.id, baseText, input.content);
    if (replacementHunks.length > agentProposalLimits.maxFrozenHunks)
      throw quotaExceeded('Proposal contains too many review hunks');
  }
  const objectKey = `proposals/${proposal.userId}/${proposal.projectId}/${proposalId}/${hash}`;
  await context.storage.put(objectKey, bytes, 'text/plain; charset=utf-8');
  const nextRevision = await context.db.transaction(async (tx) => {
    await tx.execute(
      sql`select ${agentProposals.id} from ${agentProposals} where ${agentProposals.id} = ${proposalId} for update`,
    );
    const [locked] = await tx
      .select()
      .from(agentProposals)
      .where(and(eq(agentProposals.id, proposalId), eq(agentProposals.userId, userId)))
      .limit(1);
    if (!locked) throw notFound('Proposal not found');
    if (!canOwnerReviseProposalFile(locked.status))
      throw conflict('This proposal is frozen and can no longer be changed');
    assertProposalRevision(locked.revision, input.expectedProposalRevision, proposalId);
    const [change] = await tx
      .select()
      .from(agentProposalChanges)
      .where(
        and(
          eq(agentProposalChanges.proposalId, proposalId),
          eq(agentProposalChanges.targetPath, path),
          inArray(agentProposalChanges.operation, ['create_file', 'replace_file']),
        ),
      )
      .limit(1);
    if (!change) throw notFound('Proposal file not found');
    if (change.id !== preparedChange.id) throw conflict('Proposal item changed in another tab');
    const nextTotal = nextProposalByteTotal(locked.totalBytes, change.size, bytes.byteLength);
    assertProposalWriteLimits({
      fileBytes: bytes.byteLength,
      nextTotalBytes: nextTotal,
      changedEntries: 0,
    });
    const [updated] = await tx
      .update(agentProposalChanges)
      .set({
        contentHash: hash,
        contentObjectKey: objectKey,
        size: bytes.byteLength,
        decision: replacementHunks ? 'pending' : change.decision,
        updatedAt: new Date(),
      })
      .where(eq(agentProposalChanges.id, change.id))
      .returning();
    if (!updated) throw conflict('Proposal item changed in another tab');
    if (replacementHunks) {
      await tx.delete(agentProposalHunks).where(eq(agentProposalHunks.changeId, change.id));
      if (replacementHunks.length)
        await tx.insert(agentProposalHunks).values(
          replacementHunks.map((hunk) => ({
            id: hunk.id,
            proposalId,
            changeId: hunk.changeId,
            baseStart: hunk.baseStart,
            baseEnd: hunk.baseEnd,
            baseText: hunk.baseText,
            replacementText: hunk.replacementText,
            contentHash: hunk.contentHash,
            sortOrder: hunk.order,
          })),
        );
    }
    const [next] = await tx
      .update(agentProposals)
      .set({
        revision: locked.revision + 1,
        totalBytes: nextTotal,
        updatedAt: new Date(),
      })
      .where(and(eq(agentProposals.id, proposalId), eq(agentProposals.revision, locked.revision)))
      .returning({ revision: agentProposals.revision });
    if (!next)
      throw conflict('Proposal revision is stale', { proposalId, revision: locked.revision });
    return next.revision;
  });
  await context.db.insert(auditEvents).values({
    userId,
    projectId: proposal.projectId,
    action: 'agent_proposal.file_revised',
    details: { proposalId, path, revision: nextRevision },
  });
  await publishProposal(context, proposalId, nextRevision);
  return getAgentProposal(context, userId, proposalId);
}

export async function reviseAgentProposalHunk(
  context: AppContext,
  userId: string,
  projectId: string,
  proposalId: string,
  hunkId: string,
  input: { expectedProposalRevision: number; replacementText: string },
) {
  await requireProject(context.db, userId, projectId);
  const proposal = await loadOwnedProposal(context, userId, proposalId);
  if (proposal.projectId !== projectId) throw notFound('Proposal not found');
  if (!canOwnerReviseAddition(proposal.status))
    throw conflict('This proposal can no longer be revised');
  assertProposalRevision(proposal.revision, input.expectedProposalRevision, proposalId);
  const bytes = Buffer.from(input.replacementText);
  assertProposalWriteLimits({
    fileBytes: bytes.byteLength,
    nextTotalBytes: 0,
    changedEntries: 0,
  });
  const [hunk] = await context.db
    .select()
    .from(agentProposalHunks)
    .where(and(eq(agentProposalHunks.id, hunkId), eq(agentProposalHunks.proposalId, proposalId)))
    .limit(1);
  if (!hunk) throw notFound('Proposal item not found');
  if (hunk.decision !== 'pending' && hunk.decision !== 'conflicted')
    throw conflict('This proposal item has already been decided');
  const [change] = await context.db
    .select()
    .from(agentProposalChanges)
    .where(eq(agentProposalChanges.id, hunk.changeId))
    .limit(1);
  if (!change) throw notFound('Proposal change not found');
  const decision = hunkDecisionAfterReplacement(hunk.decision);
  const contentHash = proposalHunkContentHash({
    baseStart: hunk.baseStart,
    baseEnd: hunk.baseEnd,
    baseText: hunk.baseText,
    replacementText: input.replacementText,
  });
  const hunks = await context.db
    .select()
    .from(agentProposalHunks)
    .where(eq(agentProposalHunks.changeId, change.id))
    .orderBy(asc(agentProposalHunks.sortOrder));
  let freezeBase = '';
  if (change.baseVersionId) {
    const [baseBlob] = await context.db
      .select({ objectKey: fileBlobs.objectKey })
      .from(fileVersions)
      .innerJoin(fileBlobs, eq(fileVersions.blobHash, fileBlobs.hash))
      .where(eq(fileVersions.id, change.baseVersionId))
      .limit(1);
    if (!baseBlob) throw conflict('Proposal base content is no longer available');
    freezeBase = decodeStoredText(
      await context.storage.getBuffer(baseBlob.objectKey),
      'Proposal base',
    );
  }
  const projected = projectAcceptedHunks(
    freezeBase,
    hunks
      .filter((item) => item.decision !== 'rejected')
      .map((item) =>
        item.id === hunk.id
          ? { ...toProjectionHunk(item), replacementText: input.replacementText }
          : toProjectionHunk(item),
      ),
  );
  const overlayBytes = Buffer.from(projected);
  const overlayHash = sha256(overlayBytes);
  const nextTotal = nextProposalByteTotal(
    proposal.totalBytes,
    change.size,
    overlayBytes.byteLength,
  );
  assertProposalWriteLimits({
    fileBytes: overlayBytes.byteLength,
    nextTotalBytes: nextTotal,
    changedEntries: 0,
  });
  const objectKey = `proposals/${proposal.userId}/${proposal.projectId}/${proposalId}/${overlayHash}`;
  await context.storage.put(objectKey, overlayBytes, 'text/plain; charset=utf-8');
  await context.db.transaction(async (tx) => {
    const [updatedHunk] = await tx
      .update(agentProposalHunks)
      .set({
        replacementText: input.replacementText,
        contentHash,
        decision,
        updatedAt: new Date(),
      })
      .where(
        and(eq(agentProposalHunks.id, hunk.id), eq(agentProposalHunks.decision, hunk.decision)),
      )
      .returning();
    if (!updatedHunk) throw conflict('Proposal item changed in another tab');
    await tx
      .update(agentProposalChanges)
      .set({
        contentHash: overlayHash,
        contentObjectKey: objectKey,
        size: overlayBytes.byteLength,
        updatedAt: new Date(),
      })
      .where(eq(agentProposalChanges.id, change.id));
    const [updated] = await tx
      .update(agentProposals)
      .set({
        revision: proposal.revision + 1,
        totalBytes: nextTotal,
        status: proposal.status,
        updatedAt: new Date(),
      })
      .where(and(eq(agentProposals.id, proposalId), eq(agentProposals.revision, proposal.revision)))
      .returning();
    if (!updated)
      throw conflict('Proposal revision is stale', { proposalId, revision: proposal.revision });
  });
  await context.db.insert(auditEvents).values({
    userId,
    projectId: proposal.projectId,
    action: 'agent_proposal.addition_revised',
    details: { proposalId, hunkId, revision: proposal.revision + 1, decision },
  });
  await publishProposal(context, proposalId, proposal.revision + 1);
  return getAgentProposal(context, userId, proposalId);
}

async function publishProposal(context: AppContext, proposalId: string, revision: number) {
  await context.redis.publish('agent-proposal-events', JSON.stringify({ proposalId, revision }));
}
