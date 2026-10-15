import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { agentProposals, checkpoints } from '@latex-workshop/db';
import {
  editAgentProjectSchema,
  normalizeArchivePath,
  type EditAgentProject,
} from '@latex-workshop/contracts';
import type { AppContext } from './context.js';
import { sha256 } from './domain.js';
import { conflict } from './errors.js';
import {
  acceptRemainingProposalItems,
  finishAgentProposal,
  getAgentClientProposal,
  getAgentProjectTree,
  proposeAgentStructure,
  putAgentProposalFile,
  requireGrantedProject,
} from './agent-proposals.js';

type AgentIdentity = { userId: string; clientId: string; clientName: string };

export function editMutationId(value: string) {
  const hash = sha256(value);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export function validateDirectEdit(input: EditAgentProject) {
  const paths = input.files.map((file) => normalizeArchivePath(file.path));
  if (new Set(paths.map((path) => path.toLowerCase())).size !== paths.length)
    throw conflict('Each file may appear only once in an edit');
  // Structure is staged against the accepted tree. Keep file writes on their original paths;
  // the atomic apply step creates folders, writes files, then removes deleted entries.
  for (const change of input.structure) {
    if (
      'targetPath' in change &&
      paths.some(
        (path) => path.toLowerCase() === normalizeArchivePath(change.targetPath).toLowerCase(),
      )
    )
      throw conflict('A file and structure change cannot share a target path');
    if (change.operation === 'delete' || change.operation === 'move') {
      const source = normalizeArchivePath(change.basePath);
      if (paths.some((path) => path === source || path.startsWith(`${source}/`)))
        throw conflict('Write files and move/delete their paths in separate edits');
    }
  }
}

export function isRetryableEditConflict(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (current === null || typeof current !== 'object') return false;
    if ('code' in current && (current.code === '40P01' || current.code === '40001')) return true;
    current = 'cause' in current ? current.cause : null;
  }
  return false;
}

export async function editAgentProject(
  context: AppContext,
  identity: AgentIdentity,
  raw: EditAgentProject,
) {
  const input = editAgentProjectSchema.parse(raw);
  validateDirectEdit(input);
  await requireGrantedProject(context, identity, input.projectId);
  const editId = editMutationId(
    `direct-edit\0${identity.userId}\0${identity.clientId}\0${input.idempotencyKey}`,
  );
  const requestHash = sha256(JSON.stringify(input));
  const lockKey = `agent-edit-lock:${editId}`;
  const lockToken = randomUUID();
  if (!(await context.redis.set(lockKey, lockToken, 'EX', 300, 'NX')))
    throw conflict(
      'This edit is still running. Retry the identical request with the same idempotencyKey.',
    );
  try {
    await context.db
      .insert(agentProposals)
      .values({
        id: editId,
        projectId: input.projectId,
        userId: identity.userId,
        clientId: identity.clientId,
        clientName: identity.clientName,
        title: input.title,
        directEdit: true,
        requestHash,
      })
      .onConflictDoNothing();
    const [record] = await context.db
      .select()
      .from(agentProposals)
      .where(eq(agentProposals.id, editId))
      .limit(1);
    if (!record || record.requestHash !== requestHash || !record.directEdit)
      throw conflict('The idempotencyKey was already used for a different edit. Use a fresh UUID.');
    const replayed = record.status === 'resolved';
    let proposal = await getAgentClientProposal(context, identity, editId);
    if (proposal.status === 'needs_rebase' || proposal.status === 'rejected')
      throw conflict(
        'Project changed. Refresh its tree and files, then submit a new edit with a fresh idempotencyKey.',
      );
    if (proposal.status !== 'resolved') {
      const current = await requireGrantedProject(context, identity, input.projectId);
      if (current.sourceRevision !== input.expectedSourceRevision)
        throw conflict(
          'Project changed. Refresh get_project_tree and read_text_file before retrying.',
          { sourceRevision: current.sourceRevision },
        );
      if (proposal.status === 'draft') {
        if (input.structure.length)
          proposal = await proposeAgentStructure(context, identity, editId, {
            changes: input.structure,
            expectedProposalRevision: proposal.revision,
            idempotencyKey: editMutationId(`${editId}\0structure`),
          });
        for (const [index, file] of input.files.entries())
          proposal = await putAgentProposalFile(context, identity, editId, {
            ...file,
            expectedProposalRevision: proposal.revision,
            idempotencyKey: editMutationId(`${editId}\0file\0${index}`),
          });
        proposal = await finishAgentProposal(context, identity, editId, {
          expectedProposalRevision: proposal.revision,
          idempotencyKey: editMutationId(`${editId}\0finish`),
        });
      }
      if (proposal.status === 'needs_rebase')
        throw conflict('Project changed. Refresh its tree and files, then submit a new edit.');
      if (proposal.status === 'reviewing')
        await acceptRemainingProposalItems(context, identity.userId, editId, proposal.revision, {
          expectedSourceRevision: input.expectedSourceRevision,
        });
    }
    const [checkpoint] = await context.db
      .select({ id: checkpoints.id })
      .from(checkpoints)
      .where(and(eq(checkpoints.proposalId, editId), eq(checkpoints.target, 'accepted')))
      .limit(1);
    return {
      editId,
      applied: true,
      replayed,
      undoCheckpointId: checkpoint?.id ?? null,
      ...(await getAgentProjectTree(context, identity, input.projectId)),
      nextAction: replayed
        ? 'This edit already completed and was not applied again. The returned tree is current and may include later owner changes or undo. Refresh relevant files before a new edit.'
        : 'Changes are live. Compile the project to verify output. For the next edit, read the current tree and relevant files again; use their new revision and hashes. The owner can undo file edits in Undo history or restore the pre-edit checkpoint in Version history.',
    };
  } catch (error) {
    if (isRetryableEditConflict(error))
      throw conflict(
        'A concurrent edit changed the project while applying this batch. No files were applied. Refresh the tree and files, then submit a fresh edit.',
      );
    throw error;
  } finally {
    await context.redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      lockKey,
      lockToken,
    );
  }
}
