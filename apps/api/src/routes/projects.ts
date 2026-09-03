import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  createEntrySchema,
  createProjectSchema,
  moveEntrySchema,
  saveTextSchema,
  updateProjectSchema,
  validateEntryName,
} from '@latex-workshop/contracts';
import {
  auditEvents,
  compileJobs,
  entries,
  fileBlobs,
  fileVersions,
  libraryFolders,
  projectMemberships,
  projectTagAssignments,
  projects,
} from '@latex-workshop/db';
import type { AppContext } from '../lib/context.js';
import { requireUser } from '../lib/context.js';
import {
  assertStorageQuota,
  buildEntryPaths,
  getFileWithBlob,
  requireProject,
  requireLibraryFolder,
  saveTextFileVersion,
  storeFileVersion,
} from '../lib/domain.js';
import { cloneProjectHead, createBlankProject } from '../lib/project-creation.js';
import { badRequest, conflict, notFound, quotaExceeded } from '../lib/errors.js';

function publicProject(project: typeof projects.$inferSelect) {
  return {
    ...project,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
    trashedAt: project.trashedAt?.toISOString() ?? null,
  };
}

function publicEntry(entry: typeof entries.$inferSelect) {
  return {
    ...entry,
    createdAt: entry.createdAt.toISOString(),
    updatedAt: entry.updatedAt.toISOString(),
  };
}

async function assertParent(context: AppContext, projectId: string, parentId: string | null) {
  if (!parentId) return;
  const [parent] = await context.db
    .select()
    .from(entries)
    .where(
      and(eq(entries.id, parentId), eq(entries.projectId, projectId), eq(entries.kind, 'folder')),
    )
    .limit(1);
  if (!parent) throw badRequest('Parent folder does not exist');
}

export async function registerProjectRoutes(app: FastifyInstance, context: AppContext) {
  app.get('/api/v1/projects', async (request) => {
    const user = await requireUser(context, request);
    const query = request.query as { trash?: string; search?: string };
    const trashClause =
      query.trash === 'true' ? isNotNull(projects.trashedAt) : isNull(projects.trashedAt);
    const templateClause = query.trash === 'true' ? undefined : eq(projects.isTemplate, false);
    const rows = await context.db
      .select({ project: projects })
      .from(projects)
      .innerJoin(projectMemberships, eq(projectMemberships.projectId, projects.id))
      .where(and(eq(projectMemberships.userId, user.id), trashClause, templateClause))
      .orderBy(desc(projects.updatedAt));
    const projectIds = rows.map(({ project }) => project.id);
    const successfulCompiles = projectIds.length
      ? await context.db
          .selectDistinctOn([compileJobs.projectId], {
            id: compileJobs.id,
            projectId: compileJobs.projectId,
          })
          .from(compileJobs)
          .where(
            and(
              inArray(compileJobs.projectId, projectIds),
              eq(compileJobs.status, 'succeeded'),
              isNotNull(compileJobs.pdfObjectKey),
            ),
          )
          .orderBy(compileJobs.projectId, desc(compileJobs.createdAt))
      : [];
    const previews = new Map<string, string>();
    for (const compile of successfulCompiles)
      if (!previews.has(compile.projectId)) previews.set(compile.projectId, compile.id);
    const search = query.search?.trim().toLocaleLowerCase();
    return {
      projects: rows
        .map(({ project }) => ({
          ...publicProject(project),
          previewJobId: previews.get(project.id) ?? null,
        }))
        .filter((project) => !search || project.name.toLocaleLowerCase().includes(search)),
    };
  });

  app.post('/api/v1/projects', async (request, reply) => {
    const user = await requireUser(context, request);
    const input = createProjectSchema.parse(request.body);
    if (input.folderId) await requireLibraryFolder(context.db, user.id, input.folderId);
    const project = input.templateProjectId
      ? await cloneProjectHead(context, {
          userId: user.id,
          sourceProjectId: input.templateProjectId,
          name: input.name,
          folderId: input.folderId ?? null,
          requireTemplate: true,
        })
      : await createBlankProject(context, user.id, input.name, input.folderId ?? null);
    return reply.code(201).send({ project: publicProject(project) });
  });

  app.get('/api/v1/projects/:projectId', async (request) => {
    const user = await requireUser(context, request);
    const { projectId } = request.params as { projectId: string };
    const project = await requireProject(context.db, user.id, projectId);
    const projectEntries = await context.db
      .select()
      .from(entries)
      .where(eq(entries.projectId, projectId))
      .orderBy(asc(entries.createdAt));
    const [latestCompile] = await context.db
      .select()
      .from(compileJobs)
      .where(eq(compileJobs.projectId, projectId))
      .orderBy(desc(compileJobs.createdAt))
      .limit(1);
    return {
      project: publicProject(project),
      entries: projectEntries.map(publicEntry),
      latestCompile: latestCompile ? serializeCompile(latestCompile) : null,
    };
  });

  app.patch('/api/v1/projects/:projectId', async (request) => {
    const user = await requireUser(context, request);
    const { projectId } = request.params as { projectId: string };
    const projectBefore = await requireProject(context.db, user.id, projectId);
    const input = updateProjectSchema.parse(request.body);
    if (input.mainFileId) {
      const [main] = await context.db
        .select()
        .from(entries)
        .where(
          and(
            eq(entries.id, input.mainFileId),
            eq(entries.projectId, projectId),
            eq(entries.kind, 'file'),
          ),
        )
        .limit(1);
      if (!main || !main.name.endsWith('.tex'))
        throw badRequest('Main file must be a .tex file in this project');
    }
    const [project] = await context.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(projects)
        .set({ ...input, updatedAt: new Date() })
        .where(eq(projects.id, projectId))
        .returning();
      if (input.isTemplate !== undefined && input.isTemplate !== projectBefore.isTemplate)
        await tx.insert(auditEvents).values({
          userId: user.id,
          projectId,
          action: input.isTemplate ? 'project.template_enabled' : 'project.template_disabled',
        });
      return [updated!];
    });
    return { project: publicProject(project!) };
  });

  app.post('/api/v1/projects/:projectId/duplicate', async (request, reply) => {
    const user = await requireUser(context, request);
    const { projectId } = request.params as { projectId: string };
    const source = await requireProject(context.db, user.id, projectId);
    const [sourceMembership] = await context.db
      .select()
      .from(projectMemberships)
      .where(
        and(eq(projectMemberships.projectId, projectId), eq(projectMemberships.userId, user.id)),
      );
    const sourceTags = await context.db
      .select({ tagId: projectTagAssignments.tagId })
      .from(projectTagAssignments)
      .where(
        and(
          eq(projectTagAssignments.projectId, projectId),
          eq(projectTagAssignments.userId, user.id),
        ),
      );
    const updated = await cloneProjectHead(context, {
      userId: user.id,
      sourceProjectId: projectId,
      name: `${source.name} copy`,
      folderId: sourceMembership?.folderId ?? null,
      requireTemplate: false,
    });
    if (sourceTags.length)
      await context.db
        .insert(projectTagAssignments)
        .values(sourceTags.map(({ tagId }) => ({ projectId: updated.id, tagId, userId: user.id })));
    return reply.code(201).send({ project: publicProject(updated) });
  });

  app.delete('/api/v1/projects/:projectId', async (request, reply) => {
    const user = await requireUser(context, request);
    const { projectId } = request.params as { projectId: string };
    await requireProject(context.db, user.id, projectId);
    const permanent = (request.query as { permanent?: string }).permanent === 'true';
    if (permanent) {
      await Promise.all([
        context.storage.deletePrefix(`artifacts/${projectId}/`),
        context.storage.deletePrefix(`edit-history/${projectId}/`),
      ]);
      await context.db.delete(projects).where(eq(projects.id, projectId));
      await context.db
        .insert(auditEvents)
        .values({ userId: user.id, action: 'project.deleted', details: { projectId } });
    } else {
      await context.db.transaction(async (tx) => {
        await tx
          .update(projects)
          .set({ trashedAt: new Date(), updatedAt: new Date() })
          .where(eq(projects.id, projectId));
        await tx
          .update(projectMemberships)
          .set({ trashedByFolderId: null })
          .where(
            and(
              eq(projectMemberships.projectId, projectId),
              eq(projectMemberships.userId, user.id),
            ),
          );
      });
      await context.db
        .insert(auditEvents)
        .values({ userId: user.id, projectId, action: 'project.trashed' });
    }
    return reply.code(204).send();
  });

  app.post('/api/v1/projects/:projectId/restore', async (request) => {
    const user = await requireUser(context, request);
    const { projectId } = request.params as { projectId: string };
    await requireProject(context.db, user.id, projectId);
    const [membership] = await context.db
      .select()
      .from(projectMemberships)
      .where(
        and(eq(projectMemberships.projectId, projectId), eq(projectMemberships.userId, user.id)),
      );
    const [activeFolder] = membership?.folderId
      ? await context.db
          .select({ id: libraryFolders.id })
          .from(libraryFolders)
          .where(
            and(
              eq(libraryFolders.id, membership.folderId),
              eq(libraryFolders.userId, user.id),
              isNull(libraryFolders.trashedAt),
            ),
          )
          .limit(1)
      : [];
    await context.db
      .update(projectMemberships)
      .set({ folderId: activeFolder?.id ?? null, trashedByFolderId: null })
      .where(
        and(eq(projectMemberships.projectId, projectId), eq(projectMemberships.userId, user.id)),
      );
    const [project] = await context.db
      .update(projects)
      .set({ trashedAt: null, updatedAt: new Date() })
      .where(eq(projects.id, projectId))
      .returning();
    return { project: publicProject(project!) };
  });

  app.post('/api/v1/projects/:projectId/entries', async (request, reply) => {
    const user = await requireUser(context, request);
    const { projectId } = request.params as { projectId: string };
    await requireProject(context.db, user.id, projectId);
    const input = createEntrySchema.parse(request.body);
    const name = validateEntryName(input.name);
    await assertParent(context, projectId, input.parentId);
    try {
      const [entry] = await context.db
        .insert(entries)
        .values({
          projectId,
          parentId: input.parentId,
          name,
          kind: input.kind,
          mimeType: input.kind === 'file' ? 'text/plain' : null,
        })
        .returning();
      if (input.kind === 'file') {
        await storeFileVersion(
          context.db,
          context.storage,
          entry!,
          Buffer.from(input.content ?? ''),
          name.endsWith('.tex') ? 'text/x-tex' : 'text/plain',
        );
      } else {
        await context.db
          .update(projects)
          .set({ sourceRevision: sql`${projects.sourceRevision} + 1`, updatedAt: new Date() })
          .where(eq(projects.id, projectId));
      }
      const [fresh] = await context.db.select().from(entries).where(eq(entries.id, entry!.id));
      return reply.code(201).send({ entry: publicEntry(fresh!) });
    } catch (error) {
      if (String(error).includes('entries_sibling_name_idx'))
        throw conflict('An entry with that name already exists');
      throw error;
    }
  });

  app.get('/api/v1/projects/:projectId/entries/:entryId/content', async (request, reply) => {
    const user = await requireUser(context, request);
    const { projectId, entryId } = request.params as { projectId: string; entryId: string };
    await requireProject(context.db, user.id, projectId);
    const file = await getFileWithBlob(context.db, projectId, entryId);
    const content = await context.storage.getBuffer(file.blob.objectKey);
    reply.header('etag', `"${file.blob.hash}"`);
    if (
      file.entry.mimeType?.startsWith('text/') ||
      /\.(tex|bib|sty|cls|md|json|ya?ml)$/i.test(file.entry.name)
    ) {
      return {
        content: content.toString('utf8'),
        version: file.entry.version,
        hash: file.blob.hash,
      };
    }
    reply.header('content-type', file.entry.mimeType ?? 'application/octet-stream');
    return reply.send(content);
  });

  app.put('/api/v1/projects/:projectId/entries/:entryId/content', async (request) => {
    const user = await requireUser(context, request);
    const { projectId, entryId } = request.params as { projectId: string; entryId: string };
    await requireProject(context.db, user.id, projectId);
    const input = saveTextSchema.parse(request.body);
    const [entry] = await context.db
      .select()
      .from(entries)
      .where(
        and(eq(entries.id, entryId), eq(entries.projectId, projectId), eq(entries.kind, 'file')),
      )
      .limit(1);
    if (!entry) throw notFound('File not found');
    const bytes = Buffer.from(input.content);
    if (bytes.byteLength > context.config.MAX_FILE_BYTES) throw quotaExceeded('File is too large');
    await assertStorageQuota(
      context.db,
      context.config,
      user.id,
      projectId,
      bytes.byteLength - entry.size,
    );
    const result = await saveTextFileVersion(
      context.db,
      context.storage,
      projectId,
      entryId,
      input.baseVersion,
      input.content,
      entry.mimeType ?? 'text/plain',
    );
    if (result.kind === 'conflict')
      throw conflict('This file has overlapping edits from another session', {
        version: result.entry.version,
        content: result.content,
      });
    return {
      entry: publicEntry(result.entry),
      content: result.content,
      merged: result.merged,
      unchanged: result.kind === 'unchanged',
    };
  });

  app.post('/api/v1/projects/:projectId/entries/:entryId/duplicate', async (request, reply) => {
    const user = await requireUser(context, request);
    const { projectId, entryId } = request.params as { projectId: string; entryId: string };
    await requireProject(context.db, user.id, projectId);
    const all = await context.db.select().from(entries).where(eq(entries.projectId, projectId));
    const source = all.find((entry) => entry.id === entryId);
    if (!source) throw notFound('Entry not found');

    const subtreeIds = new Set([entryId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const entry of all) {
        if (entry.parentId && subtreeIds.has(entry.parentId) && !subtreeIds.has(entry.id)) {
          subtreeIds.add(entry.id);
          changed = true;
        }
      }
    }
    const subtree = all.filter((entry) => subtreeIds.has(entry.id));
    await assertStorageQuota(
      context.db,
      context.config,
      user.id,
      projectId,
      subtree.reduce((total, entry) => total + entry.size, 0),
    );
    const currentVersionIds = subtree.flatMap((entry) =>
      entry.currentVersionId ? [entry.currentVersionId] : [],
    );
    const currentVersions = currentVersionIds.length
      ? await context.db
          .select()
          .from(fileVersions)
          .where(inArray(fileVersions.id, currentVersionIds))
      : [];
    const versionById = new Map(currentVersions.map((version) => [version.id, version]));
    const siblings = new Set(
      all
        .filter((entry) => entry.parentId === source.parentId)
        .map((entry) => entry.name.toLocaleLowerCase()),
    );
    const copyName = nextCopyName(source.name, siblings);
    const paths = buildEntryPaths(subtree);
    const ordered = [...subtree].sort(
      (left, right) =>
        paths.get(left.id)!.split('/').length - paths.get(right.id)!.split('/').length,
    );

    const duplicated = await context.db.transaction(async (tx) => {
      const idMap = new Map<string, string>();
      let rootCopy: typeof entries.$inferSelect | null = null;
      for (const original of ordered) {
        const [copy] = await tx
          .insert(entries)
          .values({
            projectId,
            parentId:
              original.id === source.id
                ? source.parentId
                : original.parentId
                  ? (idMap.get(original.parentId) ?? null)
                  : null,
            name: original.id === source.id ? copyName : original.name,
            kind: original.kind,
            mimeType: original.mimeType,
            size: original.size,
          })
          .returning();
        idMap.set(original.id, copy!.id);
        if (original.id === source.id) rootCopy = copy!;
        if (original.currentVersionId) {
          const currentVersion = versionById.get(original.currentVersionId);
          if (!currentVersion) throw new Error('Current file version is missing');
          const [newVersion] = await tx
            .insert(fileVersions)
            .values({ entryId: copy!.id, blobHash: currentVersion.blobHash, version: 1 })
            .returning();
          await tx
            .update(entries)
            .set({ currentVersionId: newVersion!.id, version: 1 })
            .where(eq(entries.id, copy!.id));
          await tx
            .update(fileBlobs)
            .set({ refCount: sql`${fileBlobs.refCount} + 1` })
            .where(eq(fileBlobs.hash, currentVersion.blobHash));
        }
      }
      await tx
        .update(projects)
        .set({ sourceRevision: sql`${projects.sourceRevision} + 1`, updatedAt: new Date() })
        .where(eq(projects.id, projectId));
      await tx
        .insert(auditEvents)
        .values({ userId: user.id, projectId, action: 'entry.duplicated', details: { entryId } });
      return rootCopy;
    });
    if (!duplicated) throw new Error('Duplicate operation did not create an entry');
    const [fresh] = await context.db.select().from(entries).where(eq(entries.id, duplicated.id));
    return reply.code(201).send({ entry: publicEntry(fresh!) });
  });

  app.patch('/api/v1/projects/:projectId/entries/:entryId', async (request) => {
    const user = await requireUser(context, request);
    const { projectId, entryId } = request.params as { projectId: string; entryId: string };
    await requireProject(context.db, user.id, projectId);
    const input = moveEntrySchema.parse(request.body);
    const [entry] = await context.db
      .select()
      .from(entries)
      .where(and(eq(entries.id, entryId), eq(entries.projectId, projectId)))
      .limit(1);
    if (!entry) throw notFound('Entry not found');
    if (input.parentId !== undefined) {
      await assertParent(context, projectId, input.parentId);
      if (input.parentId === entryId) throw badRequest('A folder cannot contain itself');
      if (entry.kind === 'folder' && input.parentId) {
        const all = await context.db.select().from(entries).where(eq(entries.projectId, projectId));
        const byId = new Map(all.map((row) => [row.id, row]));
        let cursor: string | null = input.parentId;
        while (cursor) {
          if (cursor === entryId) throw badRequest('A folder cannot be moved into its descendant');
          cursor = byId.get(cursor)?.parentId ?? null;
        }
      }
    }
    const [updated] = await context.db
      .update(entries)
      .set({
        ...(input.name ? { name: validateEntryName(input.name) } : {}),
        ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
        updatedAt: new Date(),
      })
      .where(eq(entries.id, entryId))
      .returning();
    await context.db
      .update(projects)
      .set({ sourceRevision: sql`${projects.sourceRevision} + 1`, updatedAt: new Date() })
      .where(eq(projects.id, projectId));
    return { entry: publicEntry(updated!) };
  });

  app.delete('/api/v1/projects/:projectId/entries/:entryId', async (request, reply) => {
    const user = await requireUser(context, request);
    const { projectId, entryId } = request.params as { projectId: string; entryId: string };
    const project = await requireProject(context.db, user.id, projectId);
    const all = await context.db.select().from(entries).where(eq(entries.projectId, projectId));
    if (!all.some((entry) => entry.id === entryId)) throw notFound('Entry not found');
    const ids = new Set([entryId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const entry of all)
        if (entry.parentId && ids.has(entry.parentId) && !ids.has(entry.id)) {
          ids.add(entry.id);
          changed = true;
        }
    }
    await context.db
      .delete(entries)
      .where(and(eq(entries.projectId, projectId), inArray(entries.id, [...ids])));
    await context.db
      .update(projects)
      .set({
        mainFileId: project.mainFileId && ids.has(project.mainFileId) ? null : project.mainFileId,
        sourceRevision: sql`${projects.sourceRevision} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(projects.id, projectId));
    await Promise.all(
      [...ids].map((id) => context.storage.deletePrefix(`edit-history/${projectId}/${id}/`)),
    );
    return reply.code(204).send();
  });

  app.post('/api/v1/projects/:projectId/uploads/presign', async (request) => {
    const user = await requireUser(context, request);
    const { projectId } = request.params as { projectId: string };
    await requireProject(context.db, user.id, projectId);
    const input = request.body as {
      name: string;
      contentType?: string;
      size: number;
      parentId?: string | null;
    };
    const name = validateEntryName(input.name);
    if (
      !Number.isInteger(input.size) ||
      input.size < 0 ||
      input.size > context.config.MAX_FILE_BYTES
    )
      throw quotaExceeded('File is too large');
    await assertParent(context, projectId, input.parentId ?? null);
    const uploadId = randomUUID();
    const objectKey = `uploads/${user.id}/${projectId}/${uploadId}`;
    const url = await context.storage.presignPut(
      objectKey,
      input.contentType ?? 'application/octet-stream',
    );
    return { uploadId, objectKey, url, name, expiresIn: 300 };
  });

  app.post('/api/v1/projects/:projectId/uploads/finalize', async (request, reply) => {
    const user = await requireUser(context, request);
    const { projectId } = request.params as { projectId: string };
    await requireProject(context.db, user.id, projectId);
    const input = request.body as {
      objectKey: string;
      name: string;
      parentId?: string | null;
      contentType?: string;
    };
    if (!input.objectKey.startsWith(`uploads/${user.id}/${projectId}/`))
      throw badRequest('Invalid upload key');
    const head = await context.storage.head(input.objectKey);
    if (head.size > context.config.MAX_FILE_BYTES) throw quotaExceeded('File is too large');
    await assertStorageQuota(context.db, context.config, user.id, projectId, head.size);
    const data = await context.storage.getBuffer(input.objectKey);
    const [entry] = await context.db
      .insert(entries)
      .values({
        projectId,
        parentId: input.parentId ?? null,
        name: validateEntryName(input.name),
        kind: 'file',
        mimeType: input.contentType ?? head.contentType,
      })
      .returning();
    await storeFileVersion(
      context.db,
      context.storage,
      entry!,
      data,
      input.contentType ?? head.contentType,
    );
    await context.storage.delete(input.objectKey);
    const [fresh] = await context.db.select().from(entries).where(eq(entries.id, entry!.id));
    return reply.code(201).send({ entry: publicEntry(fresh!) });
  });
}

function nextCopyName(name: string, siblingNames: Set<string>) {
  const extensionIndex = name.lastIndexOf('.');
  const hasExtension = extensionIndex > 0;
  const stem = hasExtension ? name.slice(0, extensionIndex) : name;
  const extension = hasExtension ? name.slice(extensionIndex) : '';
  for (let index = 1; index < 10_000; index += 1) {
    const suffix = index === 1 ? ' copy' : ` copy ${index}`;
    const candidate = `${stem}${suffix}${extension}`;
    if (!siblingNames.has(candidate.toLocaleLowerCase())) return candidate;
  }
  throw conflict('Unable to choose a duplicate name');
}

export function serializeCompile(job: typeof compileJobs.$inferSelect) {
  return {
    ...job,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}
