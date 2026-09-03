import { randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { and, desc, eq, lt, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { editHistoryCheckoutSchema, editHistoryCommitSchema } from '@latex-workshop/contracts';
import {
  editorHistoryNodes,
  editorHistoryState,
  entries,
  type Database,
  type DatabaseTransaction,
} from '@latex-workshop/db';
import type { AppContext } from '../lib/context.js';
import { requireSession, requireUser } from '../lib/context.js';
import { getFileWithBlob, requireProject, saveTextFileVersion, sha256 } from '../lib/domain.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { incrementMetric, observeMetric } from '../lib/operational-metrics.js';

const SNAPSHOT_INTERVAL = 50;

export async function registerEditHistoryRoutes(app: FastifyInstance, context: AppContext) {
  app.get('/api/v1/projects/:projectId/entries/:entryId/edit-history', async (request) => {
    const user = await requireUser(context, request);
    const { projectId, entryId } = request.params as { projectId: string; entryId: string };
    const query = request.query as { cursor?: string; limit?: string };
    const limit = Math.min(200, Math.max(1, Number(query.limit) || 100));
    await requireProject(context.db, user.id, projectId);
    const root = await ensureHistoryRoot(context, projectId, entryId);
    const [cursor] = query.cursor
      ? await context.db
          .select()
          .from(editorHistoryNodes)
          .where(
            and(eq(editorHistoryNodes.id, query.cursor), eq(editorHistoryNodes.entryId, entryId)),
          )
          .limit(1)
      : [];
    if (query.cursor && !cursor) throw badRequest('Invalid edit history cursor');
    const rows = await context.db
      .select()
      .from(editorHistoryNodes)
      .where(
        cursor
          ? and(
              eq(editorHistoryNodes.entryId, entryId),
              or(
                lt(editorHistoryNodes.createdAt, cursor.createdAt),
                and(
                  eq(editorHistoryNodes.createdAt, cursor.createdAt),
                  lt(editorHistoryNodes.id, cursor.id),
                ),
              ),
            )
          : eq(editorHistoryNodes.entryId, entryId),
      )
      .orderBy(desc(editorHistoryNodes.createdAt), desc(editorHistoryNodes.id))
      .limit(limit + 1);
    const state = await currentState(context, entryId);
    const file = await getFileWithBlob(context.db, projectId, entryId);
    return {
      nodes: rows.slice(0, limit).map((row) => serializeNode(row, row.id === state?.currentNodeId)),
      currentNodeId: state?.currentNodeId ?? root.id,
      content: (await context.storage.getBuffer(file.blob.objectKey)).toString('utf8'),
      version: file.entry.version,
      nextCursor: rows.length > limit ? rows[limit - 1]!.id : null,
    };
  });

  app.get(
    '/api/v1/projects/:projectId/entries/:entryId/edit-history/:nodeId/content',
    async (request) => {
      const user = await requireUser(context, request);
      const { projectId, entryId, nodeId } = request.params as {
        projectId: string;
        entryId: string;
        nodeId: string;
      };
      await requireProject(context.db, user.id, projectId);
      const [node] = await context.db
        .select()
        .from(editorHistoryNodes)
        .where(and(eq(editorHistoryNodes.id, nodeId), eq(editorHistoryNodes.entryId, entryId)))
        .limit(1);
      if (!node) throw notFound('Edit history node not found');
      return {
        node: serializeNode(node, false),
        content: await materializeNode(context, node),
      };
    },
  );

  app.post('/api/v1/projects/:projectId/entries/:entryId/edit-history/commit', async (request) => {
    const { user, session } = await requireSession(context, request);
    const { projectId, entryId } = request.params as { projectId: string; entryId: string };
    await requireProject(context.db, user.id, projectId);
    const parsed = editHistoryCommitSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Invalid edit history commit', parsed.error.flatten());
    const input = parsed.data;
    observeMetric(
      'latex_edit_history_outbox_age_milliseconds',
      Number(request.headers['x-editor-outbox-age-ms']),
    );
    await ensureHistoryRoot(context, projectId, entryId);

    const [duplicate] = await context.db
      .select()
      .from(editorHistoryNodes)
      .where(
        and(
          eq(editorHistoryNodes.entryId, entryId),
          eq(editorHistoryNodes.clientMutationId, input.clientMutationId),
        ),
      )
      .limit(1);
    if (duplicate) {
      const state = await currentState(context, entryId);
      if (state?.currentNodeId !== duplicate.id)
        throw conflict('The submitted edit was retained as an alternate branch', {
          branchNodeId: duplicate.id,
          currentNodeId: state?.currentNodeId ?? null,
        });
      return commitResponse(context, projectId, duplicate, false);
    }

    const state = await currentState(context, entryId);
    if (!state) throw new Error('Edit history state is missing');
    const [submittedParent] = await context.db
      .select()
      .from(editorHistoryNodes)
      .where(
        and(
          eq(editorHistoryNodes.id, input.expectedHeadId ?? state.currentNodeId),
          eq(editorHistoryNodes.entryId, entryId),
        ),
      )
      .limit(1);
    if (!submittedParent) throw conflict('Edit history changed in another session');
    const submittedBefore = await materializeNode(context, submittedParent);
    const [entry] = await context.db
      .select()
      .from(entries)
      .where(and(eq(entries.id, entryId), eq(entries.projectId, projectId)))
      .limit(1);
    if (!entry) throw notFound('File not found');
    let created: typeof editorHistoryNodes.$inferSelect | null = null;
    let saved: Awaited<ReturnType<typeof saveTextFileVersion>>;
    try {
      saved = await saveTextFileVersion(
        context.db,
        context.storage,
        projectId,
        entryId,
        input.baseVersion,
        input.content,
        entry.mimeType ?? 'text/plain',
        async (tx, result) => {
          const [lockedState] = await tx
            .select()
            .from(editorHistoryState)
            .where(eq(editorHistoryState.entryId, entryId))
            .limit(1);
          if (!lockedState) throw new Error('Edit history state is missing');
          const [serverParent] = await tx
            .select()
            .from(editorHistoryNodes)
            .where(eq(editorHistoryNodes.id, lockedState.currentNodeId))
            .limit(1);
          if (!serverParent) throw new Error('The current edit-history head is missing');
          const serverBefore =
            submittedParent.id === serverParent.id
              ? submittedBefore
              : await materializeNode(context, serverParent, tx);
          if (result.kind === 'unchanged' && result.content === serverBefore) {
            created = serverParent;
            return;
          }
          let branchNode: typeof editorHistoryNodes.$inferSelect | null = null;
          if (submittedParent.id !== serverParent.id)
            branchNode = await createHistoryNode(
              context,
              {
                projectId,
                entryId,
                parent: submittedParent,
                before: submittedBefore,
                after: input.content,
                summary: input.summary,
                selectionBefore: input.selectionBefore,
                selectionAfter: input.selectionAfter,
                clientMutationId: randomUUID(),
                deviceId: request.headers['x-editor-device']?.toString(),
                sessionId: session.id,
              },
              tx,
            );
          created = await createHistoryNode(
            context,
            {
              projectId,
              entryId,
              parent: serverParent,
              before: serverBefore,
              after: result.content,
              summary: branchNode ? `Rebased: ${input.summary}` : input.summary,
              selectionBefore: input.selectionBefore,
              selectionAfter: input.selectionAfter,
              clientMutationId: input.clientMutationId,
              deviceId: request.headers['x-editor-device']?.toString(),
              sessionId: session.id,
              makeCurrent: true,
            },
            tx,
          );
        },
      );
    } catch (error) {
      const [racedDuplicate] = await context.db
        .select()
        .from(editorHistoryNodes)
        .where(
          and(
            eq(editorHistoryNodes.entryId, entryId),
            eq(editorHistoryNodes.clientMutationId, input.clientMutationId),
          ),
        )
        .limit(1);
      if (!racedDuplicate) throw error;
      const racedState = await currentState(context, entryId);
      if (racedState?.currentNodeId !== racedDuplicate.id)
        throw conflict('The submitted edit was retained as an alternate branch', {
          branchNodeId: racedDuplicate.id,
          currentNodeId: racedState?.currentNodeId ?? null,
        });
      return commitResponse(context, projectId, racedDuplicate, false);
    }
    if (saved.kind === 'conflict') {
      incrementMetric('latex_edit_history_commits_total', { outcome: 'conflict' });
      const branch = await createHistoryNode(context, {
        projectId,
        entryId,
        parent: submittedParent,
        before: submittedBefore,
        after: input.content,
        summary: input.summary,
        selectionBefore: input.selectionBefore,
        selectionAfter: input.selectionAfter,
        clientMutationId: input.clientMutationId,
        deviceId: request.headers['x-editor-device']?.toString(),
        sessionId: session.id,
      });
      throw conflict('This file has overlapping edits from another session', {
        version: saved.entry.version,
        content: saved.content,
        currentNodeId: state.currentNodeId,
        branchNodeId: branch.id,
      });
    }
    incrementMetric('latex_edit_history_commits_total', {
      outcome: saved.merged ? 'rebased' : 'committed',
    });
    return commitResponse(context, projectId, created ?? submittedParent, saved.merged);
  });

  app.post(
    '/api/v1/projects/:projectId/entries/:entryId/edit-history/checkout',
    async (request) => {
      const user = await requireUser(context, request);
      const { projectId, entryId } = request.params as { projectId: string; entryId: string };
      await requireProject(context.db, user.id, projectId);
      const parsed = editHistoryCheckoutSchema.safeParse(request.body);
      if (!parsed.success) throw badRequest('Invalid history checkout', parsed.error.flatten());
      const input = parsed.data;
      const state = await currentState(context, entryId);
      if (!state || state.currentNodeId !== input.expectedHeadId)
        throw conflict('Edit history changed in another session', {
          currentNodeId: state?.currentNodeId ?? null,
        });
      const [target] = await context.db
        .select()
        .from(editorHistoryNodes)
        .where(
          and(
            eq(editorHistoryNodes.id, input.targetNodeId),
            eq(editorHistoryNodes.entryId, entryId),
          ),
        )
        .limit(1);
      if (!target) throw notFound('Edit history node not found');
      const content = await materializeNode(context, target);
      const [entry] = await context.db
        .select()
        .from(entries)
        .where(and(eq(entries.id, entryId), eq(entries.projectId, projectId)))
        .limit(1);
      if (!entry) throw notFound('File not found');
      if (entry.version !== input.baseVersion)
        throw conflict('The file changed while navigating edit history', {
          version: entry.version,
          currentNodeId: state.currentNodeId,
        });
      const saved = await saveTextFileVersion(
        context.db,
        context.storage,
        projectId,
        entryId,
        input.baseVersion,
        content,
        entry.mimeType ?? 'text/plain',
        async (tx, result) => {
          if (result.merged)
            throw conflict('The file changed while navigating edit history', {
              version: result.entry.version,
              currentNodeId: state.currentNodeId,
            });
          const [lockedState] = await tx
            .select()
            .from(editorHistoryState)
            .where(eq(editorHistoryState.entryId, entryId))
            .limit(1);
          if (lockedState?.currentNodeId !== input.expectedHeadId)
            throw conflict('Edit history changed in another session', {
              currentNodeId: lockedState?.currentNodeId ?? null,
            });
          let child = target;
          while (child.parentId) {
            await tx
              .update(editorHistoryNodes)
              .set({ preferredChildId: child.id })
              .where(eq(editorHistoryNodes.id, child.parentId));
            const [parent] = await tx
              .select()
              .from(editorHistoryNodes)
              .where(eq(editorHistoryNodes.id, child.parentId))
              .limit(1);
            if (!parent) break;
            child = parent;
          }
          await tx
            .update(editorHistoryState)
            .set({ currentNodeId: target.id, updatedAt: new Date() })
            .where(eq(editorHistoryState.entryId, entryId));
        },
      );
      if (saved.kind === 'conflict')
        throw conflict('The file changed while navigating edit history', {
          version: saved.entry.version,
          content: saved.content,
          currentNodeId: state.currentNodeId,
        });
      return {
        node: serializeNode(target, true),
        content: saved.content,
        version: saved.entry.version,
        merged: saved.merged,
      };
    },
  );
}

async function ensureHistoryRoot(context: AppContext, projectId: string, entryId: string) {
  const state = await currentState(context, entryId);
  if (state) {
    const [node] = await context.db
      .select()
      .from(editorHistoryNodes)
      .where(eq(editorHistoryNodes.id, state.currentNodeId));
    if (node) return node;
  }
  const file = await getFileWithBlob(context.db, projectId, entryId);
  const content = (await context.storage.getBuffer(file.blob.objectKey)).toString('utf8');
  const id = randomUUID();
  const snapshotObjectKey = `edit-history/${projectId}/${entryId}/${id}.txt.gz`;
  await context.storage.put(snapshotObjectKey, gzipSync(content), 'application/gzip');
  const [root] = await context.db
    .insert(editorHistoryNodes)
    .values({
      id,
      entryId,
      parentId: null,
      depth: 0,
      beforeHash: file.blob.hash,
      afterHash: file.blob.hash,
      patch: [],
      snapshotObjectKey,
      summary: 'History started',
      clientMutationId: randomUUID(),
    })
    .returning();
  const insertedState = await context.db
    .insert(editorHistoryState)
    .values({ entryId, currentNodeId: id })
    .onConflictDoNothing()
    .returning();
  if (!insertedState.length) {
    await context.db.delete(editorHistoryNodes).where(eq(editorHistoryNodes.id, id));
    await context.storage.delete(snapshotObjectKey);
    const winner = await currentState(context, entryId);
    const [winnerNode] = winner
      ? await context.db
          .select()
          .from(editorHistoryNodes)
          .where(eq(editorHistoryNodes.id, winner.currentNodeId))
          .limit(1)
      : [];
    if (!winnerNode) throw new Error('Unable to initialize edit history');
    return winnerNode;
  }
  return root!;
}

async function currentState(context: AppContext, entryId: string) {
  const [state] = await context.db
    .select()
    .from(editorHistoryState)
    .where(eq(editorHistoryState.entryId, entryId))
    .limit(1);
  return state;
}

function serializeNode(row: typeof editorHistoryNodes.$inferSelect, current: boolean) {
  return {
    id: row.id,
    entryId: row.entryId,
    parentId: row.parentId,
    preferredChildId: row.preferredChildId,
    beforeHash: row.beforeHash,
    afterHash: row.afterHash,
    summary: row.summary,
    selectionBefore: row.selectionBefore,
    selectionAfter: row.selectionAfter,
    createdAt: row.createdAt.toISOString(),
    current,
  };
}

async function commitResponse(
  context: AppContext,
  projectId: string,
  node: typeof editorHistoryNodes.$inferSelect,
  merged: boolean,
) {
  const file = await getFileWithBlob(context.db, projectId, node.entryId);
  const state = await currentState(context, node.entryId);
  return {
    node: serializeNode(node, node.id === state?.currentNodeId),
    content: (await context.storage.getBuffer(file.blob.objectKey)).toString('utf8'),
    version: file.entry.version,
    merged,
  };
}

export function makePatch(before: string, after: string) {
  if (before === after) return [];
  let start = 0;
  const limit = Math.min(before.length, after.length);
  while (start < limit && before[start] === after[start]) start += 1;
  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }
  return [{ start, deleteCount: beforeEnd - start, text: after.slice(start, afterEnd) }];
}

export function applyPatch(
  content: string,
  patch: Array<{ start: number; deleteCount: number; text: string }>,
) {
  let result = content;
  for (const operation of patch) {
    if (
      !Number.isInteger(operation.start) ||
      !Number.isInteger(operation.deleteCount) ||
      operation.start < 0 ||
      operation.deleteCount < 0 ||
      operation.start + operation.deleteCount > result.length
    )
      throw new Error('Invalid edit-history patch');
    result =
      result.slice(0, operation.start) +
      operation.text +
      result.slice(operation.start + operation.deleteCount);
  }
  return result;
}

export function reconstructHistoryContent(
  snapshot: string,
  snapshotHash: string,
  chain: Array<{
    beforeHash: string;
    afterHash: string;
    patch: Array<{ start: number; deleteCount: number; text: string }>;
  }>,
) {
  if (sha256(snapshot) !== snapshotHash) throw new Error('Edit-history snapshot hash mismatch');
  let content = snapshot;
  for (const node of chain) {
    if (sha256(content) !== node.beforeHash) throw new Error('Edit-history patch base mismatch');
    content = applyPatch(content, node.patch);
    if (sha256(content) !== node.afterHash) throw new Error('Edit-history patch hash mismatch');
  }
  return content;
}

async function createHistoryNode(
  context: AppContext,
  input: {
    projectId: string;
    entryId: string;
    parent: typeof editorHistoryNodes.$inferSelect;
    before: string;
    after: string;
    summary: string;
    selectionBefore: (typeof editorHistoryNodes.$inferInsert)['selectionBefore'];
    selectionAfter: (typeof editorHistoryNodes.$inferInsert)['selectionAfter'];
    clientMutationId: string;
    deviceId: string | undefined;
    sessionId: string | undefined;
    makeCurrent?: boolean;
  },
  transaction?: DatabaseTransaction,
) {
  const id = randomUUID();
  const depth = input.parent.depth + 1;
  const snapshotObjectKey =
    depth % SNAPSHOT_INTERVAL === 0
      ? `edit-history/${input.projectId}/${input.entryId}/${id}.txt.gz`
      : null;
  if (snapshotObjectKey)
    await context.storage.put(snapshotObjectKey, gzipSync(input.after), 'application/gzip');
  const insert = async (tx: DatabaseTransaction) => {
    const inserted = await tx
      .insert(editorHistoryNodes)
      .values({
        id,
        entryId: input.entryId,
        parentId: input.parent.id,
        depth,
        beforeHash: sha256(input.before),
        afterHash: sha256(input.after),
        patch: makePatch(input.before, input.after),
        snapshotObjectKey,
        summary: input.summary,
        selectionBefore: input.selectionBefore,
        selectionAfter: input.selectionAfter,
        clientMutationId: input.clientMutationId,
        deviceId: input.deviceId,
        sessionId: input.sessionId,
      })
      .returning();
    await tx
      .update(editorHistoryNodes)
      .set({ preferredChildId: id })
      .where(eq(editorHistoryNodes.id, input.parent.id));
    if (input.makeCurrent)
      await tx
        .update(editorHistoryState)
        .set({ currentNodeId: id, updatedAt: new Date() })
        .where(eq(editorHistoryState.entryId, input.entryId));
    return inserted;
  };
  try {
    const [created] = transaction
      ? await insert(transaction)
      : await context.db.transaction((tx) => insert(tx));
    return created!;
  } catch (error) {
    if (snapshotObjectKey) await context.storage.delete(snapshotObjectKey).catch(() => undefined);
    throw error;
  }
}

async function materializeNode(
  context: AppContext,
  target: typeof editorHistoryNodes.$inferSelect,
  database: Database | DatabaseTransaction = context.db,
) {
  const chain: Array<typeof editorHistoryNodes.$inferSelect> = [];
  let current: typeof editorHistoryNodes.$inferSelect | undefined = target;
  while (current && !current.snapshotObjectKey) {
    chain.push(current);
    if (!current.parentId) break;
    const [parent] = await database
      .select()
      .from(editorHistoryNodes)
      .where(eq(editorHistoryNodes.id, current.parentId))
      .limit(1);
    current = parent;
  }
  if (!current?.snapshotObjectKey) {
    incrementMetric('latex_edit_history_reconstruction_failures_total', {
      reason: 'missing_snapshot',
    });
    throw new Error('Edit-history snapshot chain is incomplete');
  }
  const snapshot = await context.storage.getBuffer(current.snapshotObjectKey);
  const content = current.snapshotObjectKey.endsWith('.gz')
    ? gunzipSync(snapshot).toString('utf8')
    : snapshot.toString('utf8');
  try {
    return reconstructHistoryContent(content, current.afterHash, chain.reverse());
  } catch (error) {
    incrementMetric('latex_edit_history_reconstruction_failures_total', {
      reason: String(error).includes('snapshot')
        ? 'snapshot_hash'
        : String(error).includes('base')
          ? 'patch_base'
          : 'patch_hash',
    });
    throw error;
  }
}
