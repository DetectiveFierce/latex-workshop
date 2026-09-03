import { and, desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  auditEvents,
  checkpoints,
  entries,
  fileBlobs,
  fileVersions,
  projects,
} from '@latex-workshop/db';
import type { AppContext } from '../lib/context.js';
import { requireUser } from '../lib/context.js';
import { buildEntryPaths, createCheckpoint, requireProject } from '../lib/domain.js';
import { badRequest, notFound } from '../lib/errors.js';

export async function registerHistoryRoutes(app: FastifyInstance, context: AppContext) {
  app.get('/api/v1/projects/:projectId/checkpoints', async (request) => {
    const user = await requireUser(context, request);
    const { projectId } = request.params as { projectId: string };
    await requireProject(context.db, user.id, projectId);
    const rows = await context.db
      .select({
        id: checkpoints.id,
        projectId: checkpoints.projectId,
        sourceRevision: checkpoints.sourceRevision,
        reason: checkpoints.reason,
        createdAt: checkpoints.createdAt,
      })
      .from(checkpoints)
      .where(eq(checkpoints.projectId, projectId))
      .orderBy(desc(checkpoints.createdAt));
    return { checkpoints: rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })) };
  });

  app.post('/api/v1/projects/:projectId/checkpoints', async (request, reply) => {
    const user = await requireUser(context, request);
    const { projectId } = request.params as { projectId: string };
    await requireProject(context.db, user.id, projectId);
    const checkpoint = await createCheckpoint(context.db, projectId, 'periodic');
    return reply
      .code(201)
      .send({ checkpoint: { ...checkpoint, createdAt: checkpoint.createdAt.toISOString() } });
  });

  app.get('/api/v1/projects/:projectId/checkpoints/:checkpointId/files', async (request) => {
    const user = await requireUser(context, request);
    const { projectId, checkpointId } = request.params as {
      projectId: string;
      checkpointId: string;
    };
    await requireProject(context.db, user.id, projectId);
    const [checkpoint] = await context.db
      .select()
      .from(checkpoints)
      .where(and(eq(checkpoints.id, checkpointId), eq(checkpoints.projectId, projectId)))
      .limit(1);
    if (!checkpoint) throw notFound('Checkpoint not found');
    return {
      files: checkpoint.manifest.map(({ path, size, entryId, versionId }) => ({
        path,
        size,
        entryId,
        versionId,
      })),
    };
  });

  app.get('/api/v1/projects/:projectId/checkpoints/:checkpointId/file', async (request) => {
    const user = await requireUser(context, request);
    const { projectId, checkpointId } = request.params as {
      projectId: string;
      checkpointId: string;
    };
    const { path } = request.query as { path?: string };
    if (!path) throw badRequest('A file path is required');
    await requireProject(context.db, user.id, projectId);
    const [checkpoint] = await context.db
      .select()
      .from(checkpoints)
      .where(and(eq(checkpoints.id, checkpointId), eq(checkpoints.projectId, projectId)))
      .limit(1);
    const item = checkpoint?.manifest.find((entry) => entry.path === path);
    if (!item) throw notFound('Checkpoint file not found');
    const historical = await context.storage.getBuffer(item.objectKey);
    const currentEntries = await context.db
      .select()
      .from(entries)
      .where(eq(entries.projectId, projectId));
    const paths = buildEntryPaths(currentEntries);
    const current = currentEntries.find(
      (entry) => paths.get(entry.id) === path && entry.currentVersionId,
    );
    let currentContent: string | null = null;
    if (current?.currentVersionId) {
      const [row] = await context.db
        .select({ objectKey: fileBlobs.objectKey })
        .from(fileVersions)
        .innerJoin(fileBlobs, eq(fileVersions.blobHash, fileBlobs.hash))
        .where(eq(fileVersions.id, current.currentVersionId));
      if (row) currentContent = (await context.storage.getBuffer(row.objectKey)).toString('utf8');
    }
    return { path, historical: historical.toString('utf8'), current: currentContent };
  });

  app.post('/api/v1/projects/:projectId/checkpoints/:checkpointId/restore', async (request) => {
    const user = await requireUser(context, request);
    const { projectId, checkpointId } = request.params as {
      projectId: string;
      checkpointId: string;
    };
    const project = await requireProject(context.db, user.id, projectId);
    const [checkpoint] = await context.db
      .select()
      .from(checkpoints)
      .where(and(eq(checkpoints.id, checkpointId), eq(checkpoints.projectId, projectId)))
      .limit(1);
    if (!checkpoint) throw notFound('Checkpoint not found');
    const before = await createCheckpoint(context.db, projectId, 'restore');
    const oldEntries = await context.db
      .select()
      .from(entries)
      .where(eq(entries.projectId, projectId));
    const oldPaths = buildEntryPaths(oldEntries);
    const mainPath = project.mainFileId ? oldPaths.get(project.mainFileId) : 'main.tex';
    await context.db.transaction(async (tx) => {
      await tx.delete(entries).where(eq(entries.projectId, projectId));
      const folders = new Map<string, string>();
      const ensureFolder = async (path: string): Promise<string | null> => {
        if (!path) return null;
        const existing = folders.get(path);
        if (existing) return existing;
        const slash = path.lastIndexOf('/');
        const parentPath = slash >= 0 ? path.slice(0, slash) : '';
        const name = slash >= 0 ? path.slice(slash + 1) : path;
        const parentId: string | null = await ensureFolder(parentPath);
        const createdFolders = await tx
          .insert(entries)
          .values({ projectId, parentId, name, kind: 'folder' })
          .returning();
        const folder = createdFolders[0]!;
        folders.set(path, folder.id);
        return folder.id;
      };
      let restoredMainId: string | null = null;
      for (const item of checkpoint.manifest) {
        const slash = item.path.lastIndexOf('/');
        const folderPath = slash >= 0 ? item.path.slice(0, slash) : '';
        const name = slash >= 0 ? item.path.slice(slash + 1) : item.path;
        const parentId = await ensureFolder(folderPath);
        const [file] = await tx
          .insert(entries)
          .values({
            projectId,
            parentId,
            name,
            kind: 'file',
            mimeType: item.mimeType,
            size: item.size,
            version: 1,
          })
          .returning();
        const [version] = await tx
          .insert(fileVersions)
          .values({ entryId: file!.id, blobHash: item.blobHash, version: 1 })
          .returning();
        await tx
          .update(entries)
          .set({ currentVersionId: version!.id })
          .where(eq(entries.id, file!.id));
        await tx
          .update(fileBlobs)
          .set({ refCount: sql`${fileBlobs.refCount} + 1` })
          .where(eq(fileBlobs.hash, item.blobHash));
        if (item.path === mainPath || (!restoredMainId && item.path === 'main.tex'))
          restoredMainId = file!.id;
      }
      await tx
        .update(projects)
        .set({
          mainFileId: restoredMainId,
          sourceRevision: sql`${projects.sourceRevision} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(projects.id, projectId));
    });
    await Promise.all(
      oldEntries
        .filter((entry) => entry.kind === 'file')
        .map((entry) => context.storage.deletePrefix(`edit-history/${projectId}/${entry.id}/`)),
    );
    const restored = await createCheckpoint(context.db, projectId, 'restore');
    await context.db.insert(auditEvents).values({
      userId: user.id,
      projectId,
      action: 'project.restored_checkpoint',
      details: { restoredFrom: checkpoint.id, safetyCheckpointId: before.id },
    });
    return {
      restoredFrom: checkpoint.id,
      safetyCheckpointId: before.id,
      checkpoint: { ...restored, createdAt: restored.createdAt.toISOString() },
    };
  });
}
