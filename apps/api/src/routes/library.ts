import { and, asc, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  bulkLibraryActionSchema,
  createLibraryFolderSchema,
  createProjectTagSchema,
  updateLibraryFolderSchema,
  updateProjectTagSchema,
} from '@latex-workshop/contracts';
import {
  auditEvents,
  compileJobs,
  libraryFolders,
  projectMemberships,
  projects,
  projectTagAssignments,
  projectTags,
} from '@latex-workshop/db';
import type { AppContext } from '../lib/context.js';
import { requireUser } from '../lib/context.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';

const publicFolder = (folder: typeof libraryFolders.$inferSelect) => ({
  id: folder.id,
  parentId: folder.parentId,
  name: folder.name,
  trashedAt: folder.trashedAt?.toISOString() ?? null,
  createdAt: folder.createdAt.toISOString(),
  updatedAt: folder.updatedAt.toISOString(),
});

const publicTag = (tag: typeof projectTags.$inferSelect) => ({
  id: tag.id,
  name: tag.name,
  color: tag.color as 'slate' | 'green' | 'cyan' | 'blue' | 'amber' | 'orange' | 'magenta' | 'red',
  createdAt: tag.createdAt.toISOString(),
  updatedAt: tag.updatedAt.toISOString(),
});

async function ownedFolder(
  context: AppContext,
  userId: string,
  folderId: string,
  state: 'active' | 'trashed' | 'any' = 'active',
) {
  const stateClause =
    state === 'active'
      ? isNull(libraryFolders.trashedAt)
      : state === 'trashed'
        ? isNotNull(libraryFolders.trashedAt)
        : undefined;
  const [folder] = await context.db
    .select()
    .from(libraryFolders)
    .where(
      stateClause
        ? and(eq(libraryFolders.id, folderId), eq(libraryFolders.userId, userId), stateClause)
        : and(eq(libraryFolders.id, folderId), eq(libraryFolders.userId, userId)),
    )
    .limit(1);
  if (!folder) throw notFound('Folder not found');
  return folder;
}

async function ownedTag(context: AppContext, userId: string, tagId: string) {
  const [tag] = await context.db
    .select()
    .from(projectTags)
    .where(and(eq(projectTags.id, tagId), eq(projectTags.userId, userId)))
    .limit(1);
  if (!tag) throw notFound('Tag not found');
  return tag;
}

function descendantIds(all: Array<typeof libraryFolders.$inferSelect>, rootId: string) {
  const ids = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const folder of all) {
      if (folder.parentId && ids.has(folder.parentId) && !ids.has(folder.id)) {
        ids.add(folder.id);
        changed = true;
      }
    }
  }
  return [...ids];
}

async function libraryPayload(context: AppContext, userId: string, trash: boolean) {
  const rows = await context.db
    .select({ project: projects, membership: projectMemberships })
    .from(projects)
    .innerJoin(projectMemberships, eq(projectMemberships.projectId, projects.id))
    .where(
      and(
        eq(projectMemberships.userId, userId),
        trash ? isNotNull(projects.trashedAt) : isNull(projects.trashedAt),
        ...(trash ? [] : [eq(projects.isTemplate, false)]),
      ),
    )
    .orderBy(desc(projects.updatedAt));
  const folders = await context.db
    .select()
    .from(libraryFolders)
    .where(eq(libraryFolders.userId, userId))
    .orderBy(asc(libraryFolders.name));
  const tags = await context.db
    .select()
    .from(projectTags)
    .where(eq(projectTags.userId, userId))
    .orderBy(asc(projectTags.name));
  const projectIds = rows.map(({ project }) => project.id);
  const assignments = projectIds.length
    ? await context.db
        .select({ assignment: projectTagAssignments, tag: projectTags })
        .from(projectTagAssignments)
        .innerJoin(projectTags, eq(projectTagAssignments.tagId, projectTags.id))
        .where(
          and(
            eq(projectTagAssignments.userId, userId),
            inArray(projectTagAssignments.projectId, projectIds),
          ),
        )
    : [];
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
  const previewByProject = new Map(
    successfulCompiles.map((compile) => [compile.projectId, compile.id]),
  );
  const tagsByProject = new Map<string, Array<ReturnType<typeof publicTag>>>();
  for (const { assignment, tag } of assignments) {
    const current = tagsByProject.get(assignment.projectId) ?? [];
    current.push(publicTag(tag));
    tagsByProject.set(assignment.projectId, current);
  }
  return {
    projects: rows.map(({ project, membership }) => ({
      id: project.id,
      name: project.name,
      compiler: project.compiler,
      mainFileId: project.mainFileId,
      autoCompile: project.autoCompile,
      sourceRevision: project.sourceRevision,
      isTemplate: project.isTemplate,
      trashedAt: project.trashedAt?.toISOString() ?? null,
      createdAt: project.createdAt.toISOString(),
      updatedAt: project.updatedAt.toISOString(),
      folderId: membership.folderId,
      favorite: membership.favorite,
      lastOpenedAt: membership.lastOpenedAt?.toISOString() ?? null,
      trashedByFolderId: membership.trashedByFolderId,
      previewJobId: previewByProject.get(project.id) ?? null,
      tags: tagsByProject.get(project.id) ?? [],
    })),
    folders: folders.map(publicFolder),
    tags: tags.map(publicTag),
  };
}

export async function registerLibraryRoutes(app: FastifyInstance, context: AppContext) {
  app.get('/api/v1/library', async (request) => {
    const user = await requireUser(context, request);
    const trash = (request.query as { trash?: string }).trash === 'true';
    return libraryPayload(context, user.id, trash);
  });

  app.post('/api/v1/library/folders', async (request, reply) => {
    const user = await requireUser(context, request);
    const input = createLibraryFolderSchema.parse(request.body);
    if (input.parentId) await ownedFolder(context, user.id, input.parentId);
    try {
      const [folder] = await context.db
        .insert(libraryFolders)
        .values({ userId: user.id, parentId: input.parentId, name: input.name })
        .returning();
      return reply.code(201).send({ folder: publicFolder(folder!) });
    } catch (error) {
      if (String(error).includes('library_folders_active_sibling_name_idx'))
        throw conflict('A folder with that name already exists here');
      throw error;
    }
  });

  app.patch('/api/v1/library/folders/:folderId', async (request) => {
    const user = await requireUser(context, request);
    const { folderId } = request.params as { folderId: string };
    const input = updateLibraryFolderSchema.parse(request.body);
    await ownedFolder(context, user.id, folderId);
    if (input.parentId !== undefined) {
      if (input.parentId === folderId) throw badRequest('A folder cannot contain itself');
      if (input.parentId) await ownedFolder(context, user.id, input.parentId);
      const all = await context.db
        .select()
        .from(libraryFolders)
        .where(eq(libraryFolders.userId, user.id));
      if (input.parentId && descendantIds(all, folderId).includes(input.parentId))
        throw badRequest('A folder cannot be moved into its descendant');
    }
    try {
      const [folder] = await context.db
        .update(libraryFolders)
        .set({ ...input, updatedAt: new Date() })
        .where(and(eq(libraryFolders.id, folderId), eq(libraryFolders.userId, user.id)))
        .returning();
      return { folder: publicFolder(folder!) };
    } catch (error) {
      if (String(error).includes('library_folders_active_sibling_name_idx'))
        throw conflict('A folder with that name already exists here');
      throw error;
    }
  });

  app.delete('/api/v1/library/folders/:folderId', async (request, reply) => {
    const user = await requireUser(context, request);
    const { folderId } = request.params as { folderId: string };
    const permanent = (request.query as { permanent?: string }).permanent === 'true';
    await ownedFolder(context, user.id, folderId, permanent ? 'trashed' : 'active');
    const all = await context.db
      .select()
      .from(libraryFolders)
      .where(eq(libraryFolders.userId, user.id));
    const ids = descendantIds(all, folderId);
    const contained = await context.db
      .select({ project: projects })
      .from(projectMemberships)
      .innerJoin(projects, eq(projectMemberships.projectId, projects.id))
      .where(
        and(eq(projectMemberships.userId, user.id), inArray(projectMemberships.folderId, ids)),
      );
    if (permanent) {
      for (const { project } of contained)
        await Promise.all([
          context.storage.deletePrefix(`artifacts/${project.id}/`),
          context.storage.deletePrefix(`edit-history/${project.id}/`),
        ]);
      await context.db.transaction(async (tx) => {
        if (contained.length)
          await tx.delete(projects).where(
            inArray(
              projects.id,
              contained.map(({ project }) => project.id),
            ),
          );
        await tx.delete(libraryFolders).where(inArray(libraryFolders.id, ids));
        await tx.insert(auditEvents).values({
          userId: user.id,
          action: 'library.folder.deleted',
          details: { folderId, projectCount: contained.length },
        });
      });
    } else {
      const activeProjectIds = contained
        .filter(({ project }) => project.trashedAt === null)
        .map(({ project }) => project.id);
      const now = new Date();
      await context.db.transaction(async (tx) => {
        await tx
          .update(libraryFolders)
          .set({ trashedAt: now, updatedAt: now })
          .where(inArray(libraryFolders.id, ids));
        if (activeProjectIds.length) {
          await tx
            .update(projects)
            .set({ trashedAt: now, updatedAt: now })
            .where(inArray(projects.id, activeProjectIds));
          await tx
            .update(projectMemberships)
            .set({ trashedByFolderId: folderId })
            .where(
              and(
                eq(projectMemberships.userId, user.id),
                inArray(projectMemberships.projectId, activeProjectIds),
              ),
            );
        }
        await tx.insert(auditEvents).values({
          userId: user.id,
          action: 'library.folder.trashed',
          details: { folderId, projectCount: activeProjectIds.length },
        });
      });
    }
    return reply.code(204).send();
  });

  app.post('/api/v1/library/folders/:folderId/restore', async (request) => {
    const user = await requireUser(context, request);
    const { folderId } = request.params as { folderId: string };
    const root = await ownedFolder(context, user.id, folderId, 'trashed');
    if (root.parentId) {
      const parent = await ownedFolder(context, user.id, root.parentId, 'any');
      if (parent.trashedAt) throw conflict('Restore the parent folder first');
    }
    const all = await context.db
      .select()
      .from(libraryFolders)
      .where(eq(libraryFolders.userId, user.id));
    const ids = descendantIds(all, folderId);
    const linked = await context.db
      .select({ projectId: projectMemberships.projectId })
      .from(projectMemberships)
      .where(
        and(
          eq(projectMemberships.userId, user.id),
          eq(projectMemberships.trashedByFolderId, folderId),
        ),
      );
    const projectIds = linked.map((row) => row.projectId);
    const now = new Date();
    await context.db.transaction(async (tx) => {
      await tx
        .update(libraryFolders)
        .set({ trashedAt: null, updatedAt: now })
        .where(inArray(libraryFolders.id, ids));
      if (projectIds.length) {
        await tx
          .update(projects)
          .set({ trashedAt: null, updatedAt: now })
          .where(inArray(projects.id, projectIds));
        await tx
          .update(projectMemberships)
          .set({ trashedByFolderId: null })
          .where(
            and(
              eq(projectMemberships.userId, user.id),
              inArray(projectMemberships.projectId, projectIds),
            ),
          );
      }
      await tx.insert(auditEvents).values({
        userId: user.id,
        action: 'library.folder.restored',
        details: { folderId, projectCount: projectIds.length },
      });
    });
    const [folder] = await context.db
      .select()
      .from(libraryFolders)
      .where(eq(libraryFolders.id, folderId));
    return { folder: publicFolder(folder!) };
  });

  app.post('/api/v1/library/tags', async (request, reply) => {
    const user = await requireUser(context, request);
    const input = createProjectTagSchema.parse(request.body);
    try {
      const [tag] = await context.db
        .insert(projectTags)
        .values({ userId: user.id, ...input })
        .returning();
      return reply.code(201).send({ tag: publicTag(tag!) });
    } catch (error) {
      if (String(error).includes('project_tags_user_name_idx'))
        throw conflict('A tag with that name already exists');
      throw error;
    }
  });

  app.patch('/api/v1/library/tags/:tagId', async (request) => {
    const user = await requireUser(context, request);
    const { tagId } = request.params as { tagId: string };
    const input = updateProjectTagSchema.parse(request.body);
    await ownedTag(context, user.id, tagId);
    try {
      const [tag] = await context.db
        .update(projectTags)
        .set({ ...input, updatedAt: new Date() })
        .where(and(eq(projectTags.id, tagId), eq(projectTags.userId, user.id)))
        .returning();
      return { tag: publicTag(tag!) };
    } catch (error) {
      if (String(error).includes('project_tags_user_name_idx'))
        throw conflict('A tag with that name already exists');
      throw error;
    }
  });

  app.delete('/api/v1/library/tags/:tagId', async (request, reply) => {
    const user = await requireUser(context, request);
    const { tagId } = request.params as { tagId: string };
    await ownedTag(context, user.id, tagId);
    await context.db
      .delete(projectTags)
      .where(and(eq(projectTags.id, tagId), eq(projectTags.userId, user.id)));
    return reply.code(204).send();
  });

  app.post('/api/v1/library/projects/actions', async (request) => {
    const user = await requireUser(context, request);
    const input = bulkLibraryActionSchema.parse(request.body);
    const projectIds = [...new Set(input.projectIds)];
    const ownedProjects = await context.db
      .select({ membership: projectMemberships, project: projects })
      .from(projectMemberships)
      .innerJoin(projects, eq(projectMemberships.projectId, projects.id))
      .where(
        and(
          eq(projectMemberships.userId, user.id),
          inArray(projectMemberships.projectId, projectIds),
        ),
      );
    if (ownedProjects.length !== projectIds.length)
      throw notFound('One or more projects were not found');
    const memberships = ownedProjects.map(({ membership }) => membership);
    if (
      input.action === 'delete' &&
      ownedProjects.some(({ project }) => project.trashedAt === null)
    )
      throw badRequest('Projects must be in Trash before permanent deletion');

    if (input.action === 'move' && input.folderId)
      await ownedFolder(context, user.id, input.folderId);
    if (input.action === 'add-tags' || input.action === 'remove-tags') {
      const owned = await context.db
        .select({ id: projectTags.id })
        .from(projectTags)
        .where(and(eq(projectTags.userId, user.id), inArray(projectTags.id, input.tagIds)));
      if (owned.length !== new Set(input.tagIds).size)
        throw notFound('One or more tags were not found');
    }
    if (input.action === 'delete') {
      for (const projectId of projectIds)
        await Promise.all([
          context.storage.deletePrefix(`artifacts/${projectId}/`),
          context.storage.deletePrefix(`edit-history/${projectId}/`),
        ]);
    }

    await context.db.transaction(async (tx) => {
      if (input.action === 'move')
        await tx
          .update(projectMemberships)
          .set({ folderId: input.folderId })
          .where(
            and(
              eq(projectMemberships.userId, user.id),
              inArray(projectMemberships.projectId, projectIds),
            ),
          );
      if (input.action === 'favorite')
        await tx
          .update(projectMemberships)
          .set({ favorite: input.value })
          .where(
            and(
              eq(projectMemberships.userId, user.id),
              inArray(projectMemberships.projectId, projectIds),
            ),
          );
      if (input.action === 'add-tags')
        await tx
          .insert(projectTagAssignments)
          .values(
            projectIds.flatMap((projectId) =>
              input.tagIds.map((tagId) => ({ projectId, tagId, userId: user.id })),
            ),
          )
          .onConflictDoNothing();
      if (input.action === 'remove-tags')
        await tx
          .delete(projectTagAssignments)
          .where(
            and(
              eq(projectTagAssignments.userId, user.id),
              inArray(projectTagAssignments.projectId, projectIds),
              inArray(projectTagAssignments.tagId, input.tagIds),
            ),
          );
      if (input.action === 'trash') {
        await tx
          .update(projects)
          .set({ trashedAt: new Date(), updatedAt: new Date() })
          .where(inArray(projects.id, projectIds));
        await tx
          .update(projectMemberships)
          .set({ trashedByFolderId: null })
          .where(
            and(
              eq(projectMemberships.userId, user.id),
              inArray(projectMemberships.projectId, projectIds),
            ),
          );
      }
      if (input.action === 'restore') {
        const activeFolders = await tx
          .select({ id: libraryFolders.id })
          .from(libraryFolders)
          .where(and(eq(libraryFolders.userId, user.id), isNull(libraryFolders.trashedAt)));
        const activeIds = new Set(activeFolders.map((folder) => folder.id));
        for (const membership of memberships) {
          await tx
            .update(projectMemberships)
            .set({
              folderId:
                membership.folderId && activeIds.has(membership.folderId)
                  ? membership.folderId
                  : null,
              trashedByFolderId: null,
            })
            .where(
              and(
                eq(projectMemberships.userId, user.id),
                eq(projectMemberships.projectId, membership.projectId),
              ),
            );
        }
        await tx
          .update(projects)
          .set({ trashedAt: null, updatedAt: new Date() })
          .where(inArray(projects.id, projectIds));
      }
      if (input.action === 'delete')
        await tx.delete(projects).where(inArray(projects.id, projectIds));
      await tx.insert(auditEvents).values({
        userId: user.id,
        action: `library.projects.${input.action}`,
        details: { projectIds },
      });
    });
    if (input.action === 'delete')
      await Promise.all(
        projectIds.flatMap((projectId) => [
          context.storage.deletePrefix(`artifacts/${projectId}/`),
          context.storage.deletePrefix(`edit-history/${projectId}/`),
        ]),
      );
    return { updated: projectIds.length };
  });

  app.post('/api/v1/library/projects/:projectId/opened', async (request, reply) => {
    const user = await requireUser(context, request);
    const { projectId } = request.params as { projectId: string };
    const [membership] = await context.db
      .update(projectMemberships)
      .set({ lastOpenedAt: new Date() })
      .where(
        and(eq(projectMemberships.userId, user.id), eq(projectMemberships.projectId, projectId)),
      )
      .returning({ projectId: projectMemberships.projectId });
    if (!membership) throw notFound('Project not found');
    return reply.code(204).send();
  });
}
