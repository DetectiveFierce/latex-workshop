import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { AgentLibraryMutation } from '@latex-workshop/contracts';
import {
  agentClientPolicies,
  agentProjectGrants,
  auditEvents,
  libraryFolders,
  projectMemberships,
  projects,
  projectTagAssignments,
  projectTags,
} from '@latex-workshop/db';
import type { AppContext } from './context.js';
import { badRequest, conflict, notFound } from './errors.js';
import { sha256 } from './domain.js';
import { requireGrantedProject } from './agent-proposals.js';

type AgentIdentity = { userId: string; clientId: string; clientName: string };

function deterministicUuid(value: string): string {
  const hash = sha256(value).slice(0, 32).split('');
  hash[12] = '5';
  hash[16] = ['8', '9', 'a', 'b'][Number.parseInt(hash[16] ?? '0', 16) % 4] ?? '8';
  const joined = hash.join('');
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}

const publicFolder = (folder: typeof libraryFolders.$inferSelect) => ({
  id: folder.id,
  parentId: folder.parentId,
  name: folder.name,
});

const publicTag = (tag: typeof projectTags.$inferSelect) => ({
  id: tag.id,
  name: tag.name,
  color: tag.color,
});

async function ownedFolder(context: AppContext, userId: string, folderId: string) {
  const [folder] = await context.db
    .select()
    .from(libraryFolders)
    .where(
      and(
        eq(libraryFolders.id, folderId),
        eq(libraryFolders.userId, userId),
        isNull(libraryFolders.trashedAt),
      ),
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
  for (let remaining = all.length; remaining > 0; remaining -= 1) {
    let changed = false;
    for (const folder of all) {
      if (folder.parentId && ids.has(folder.parentId) && !ids.has(folder.id)) {
        ids.add(folder.id);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return [...ids];
}

async function grantedProjectIds(context: AppContext, identity: AgentIdentity) {
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
  if (policy?.allProjects) {
    const rows = await context.db
      .select({ projectId: projectMemberships.projectId })
      .from(projectMemberships)
      .where(
        and(eq(projectMemberships.userId, identity.userId), eq(projectMemberships.role, 'owner')),
      );
    return new Set(rows.map((row) => row.projectId));
  }
  const rows = await context.db
    .select({ projectId: agentProjectGrants.projectId })
    .from(agentProjectGrants)
    .innerJoin(
      projectMemberships,
      and(
        eq(projectMemberships.projectId, agentProjectGrants.projectId),
        eq(projectMemberships.userId, agentProjectGrants.userId),
      ),
    )
    .where(
      and(
        eq(agentProjectGrants.userId, identity.userId),
        eq(agentProjectGrants.clientId, identity.clientId),
        eq(projectMemberships.role, 'owner'),
      ),
    );
  return new Set(rows.map((row) => row.projectId));
}

async function hasCompleteLibraryAccess(context: AppContext, identity: AgentIdentity) {
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
  return policy?.allProjects === true;
}

async function requireAllProjectsGranted(
  context: AppContext,
  identity: AgentIdentity,
  projectIds: string[],
) {
  const granted = await grantedProjectIds(context, identity);
  if (projectIds.some((projectId) => !granted.has(projectId)))
    throw badRequest(
      'This operation also affects projects not granted to this connection. Grant those projects under Agent access first.',
    );
}

export async function listAgentLibraryOrganization(context: AppContext, identity: AgentIdentity) {
  const [folders, tags, complete] = await Promise.all([
    context.db
      .select()
      .from(libraryFolders)
      .where(and(eq(libraryFolders.userId, identity.userId), isNull(libraryFolders.trashedAt)))
      .orderBy(asc(libraryFolders.name)),
    context.db
      .select()
      .from(projectTags)
      .where(eq(projectTags.userId, identity.userId))
      .orderBy(asc(projectTags.name)),
    hasCompleteLibraryAccess(context, identity),
  ]);
  if (complete)
    return {
      folders: folders.map(publicFolder),
      tags: tags.map(publicTag),
      organizationComplete: true,
    };

  const granted = await grantedProjectIds(context, identity);
  const projectIds = [...granted];
  const [memberships, assignments] = projectIds.length
    ? await Promise.all([
        context.db
          .select({ folderId: projectMemberships.folderId })
          .from(projectMemberships)
          .where(
            and(
              eq(projectMemberships.userId, identity.userId),
              inArray(projectMemberships.projectId, projectIds),
            ),
          ),
        context.db
          .select({ tagId: projectTagAssignments.tagId })
          .from(projectTagAssignments)
          .where(
            and(
              eq(projectTagAssignments.userId, identity.userId),
              inArray(projectTagAssignments.projectId, projectIds),
            ),
          ),
      ])
    : [[], []];
  const folderById = new Map(folders.map((folder) => [folder.id, folder]));
  const visibleFolderIds = new Set<string>();
  for (const membership of memberships) {
    let folderId = membership.folderId;
    while (folderId && !visibleFolderIds.has(folderId)) {
      visibleFolderIds.add(folderId);
      folderId = folderById.get(folderId)?.parentId ?? null;
    }
  }
  const visibleTagIds = new Set(assignments.map((assignment) => assignment.tagId));
  return {
    folders: folders.filter((folder) => visibleFolderIds.has(folder.id)).map(publicFolder),
    tags: tags.filter((tag) => visibleTagIds.has(tag.id)).map(publicTag),
    organizationComplete: false,
  };
}

export async function organizeAgentLibrary(
  context: AppContext,
  identity: AgentIdentity,
  input: AgentLibraryMutation,
) {
  if (input.action === 'create_folder') {
    if (input.parentId) await ownedFolder(context, identity.userId, input.parentId);
    const id = deterministicUuid(
      `agent-library-folder\0${identity.userId}\0${identity.clientId}\0${input.idempotencyKey}`,
    );
    const [existing] = await context.db
      .select()
      .from(libraryFolders)
      .where(eq(libraryFolders.id, id));
    if (existing) return { action: input.action, folder: publicFolder(existing) };
    try {
      const [folder] = await context.db
        .insert(libraryFolders)
        .values({ id, userId: identity.userId, parentId: input.parentId, name: input.name })
        .returning();
      await context.db.insert(auditEvents).values({
        userId: identity.userId,
        action: 'library.folder.created_by_agent',
        details: { folderId: folder!.id, idempotencyKey: input.idempotencyKey },
      });
      return { action: input.action, folder: publicFolder(folder!) };
    } catch (error) {
      if (String(error).includes('library_folders_active_sibling_name_idx'))
        throw conflict('A folder with that name already exists here');
      throw error;
    }
  }

  if (input.action === 'update_folder') {
    await ownedFolder(context, identity.userId, input.folderId);
    const all = await context.db
      .select()
      .from(libraryFolders)
      .where(eq(libraryFolders.userId, identity.userId));
    const affectedFolderIds = descendantIds(all, input.folderId);
    const affected = await context.db
      .select({ projectId: projectMemberships.projectId })
      .from(projectMemberships)
      .where(
        and(
          eq(projectMemberships.userId, identity.userId),
          inArray(projectMemberships.folderId, affectedFolderIds),
        ),
      );
    await requireAllProjectsGranted(
      context,
      identity,
      affected.map((row) => row.projectId),
    );
    if (input.parentId !== undefined) {
      if (input.parentId === input.folderId) throw badRequest('A folder cannot contain itself');
      if (input.parentId) await ownedFolder(context, identity.userId, input.parentId);
      if (input.parentId && descendantIds(all, input.folderId).includes(input.parentId))
        throw badRequest('A folder cannot be moved into its descendant');
    }
    try {
      const [folder] = await context.db
        .update(libraryFolders)
        .set({
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
          updatedAt: new Date(),
        })
        .where(
          and(eq(libraryFolders.id, input.folderId), eq(libraryFolders.userId, identity.userId)),
        )
        .returning();
      await context.db.insert(auditEvents).values({
        userId: identity.userId,
        action: 'library.folder.updated_by_agent',
        details: { folderId: input.folderId, idempotencyKey: input.idempotencyKey },
      });
      return { action: input.action, folder: publicFolder(folder!) };
    } catch (error) {
      if (String(error).includes('library_folders_active_sibling_name_idx'))
        throw conflict('A folder with that name already exists here');
      throw error;
    }
  }

  if (input.action === 'trash_folder') {
    await ownedFolder(context, identity.userId, input.folderId);
    const all = await context.db
      .select()
      .from(libraryFolders)
      .where(eq(libraryFolders.userId, identity.userId));
    const folderIds = descendantIds(all, input.folderId);
    const contained = await context.db
      .select({ projectId: projectMemberships.projectId })
      .from(projectMemberships)
      .innerJoin(projects, eq(projects.id, projectMemberships.projectId))
      .where(
        and(
          eq(projectMemberships.userId, identity.userId),
          inArray(projectMemberships.folderId, folderIds),
          isNull(projects.trashedAt),
        ),
      );
    const projectIds = contained.map((row) => row.projectId);
    await requireAllProjectsGranted(context, identity, projectIds);
    const now = new Date();
    await context.db.transaction(async (tx) => {
      await tx
        .update(libraryFolders)
        .set({ trashedAt: now, updatedAt: now })
        .where(inArray(libraryFolders.id, folderIds));
      if (projectIds.length) {
        await tx
          .update(projects)
          .set({ trashedAt: now, updatedAt: now })
          .where(inArray(projects.id, projectIds));
        await tx
          .update(projectMemberships)
          .set({ trashedByFolderId: input.folderId })
          .where(
            and(
              eq(projectMemberships.userId, identity.userId),
              inArray(projectMemberships.projectId, projectIds),
            ),
          );
      }
      await tx.insert(auditEvents).values({
        userId: identity.userId,
        action: 'library.folder.trashed_by_agent',
        details: {
          folderId: input.folderId,
          folderIds,
          projectIds,
          idempotencyKey: input.idempotencyKey,
        },
      });
    });
    return { action: input.action, folderId: input.folderId, trashedProjectIds: projectIds };
  }

  if (input.action === 'create_tag') {
    const id = deterministicUuid(
      `agent-library-tag\0${identity.userId}\0${identity.clientId}\0${input.idempotencyKey}`,
    );
    const [existing] = await context.db.select().from(projectTags).where(eq(projectTags.id, id));
    if (existing) return { action: input.action, tag: publicTag(existing) };
    try {
      const [tag] = await context.db
        .insert(projectTags)
        .values({ id, userId: identity.userId, name: input.name, color: input.color })
        .returning();
      await context.db.insert(auditEvents).values({
        userId: identity.userId,
        action: 'library.tag.created_by_agent',
        details: { tagId: tag!.id, idempotencyKey: input.idempotencyKey },
      });
      return { action: input.action, tag: publicTag(tag!) };
    } catch (error) {
      if (String(error).includes('project_tags_user_name_idx'))
        throw conflict('A tag with that name already exists');
      throw error;
    }
  }

  if (input.action === 'update_tag') {
    await ownedTag(context, identity.userId, input.tagId);
    const assignments = await context.db
      .select({ projectId: projectTagAssignments.projectId })
      .from(projectTagAssignments)
      .where(
        and(
          eq(projectTagAssignments.userId, identity.userId),
          eq(projectTagAssignments.tagId, input.tagId),
        ),
      );
    await requireAllProjectsGranted(
      context,
      identity,
      assignments.map((assignment) => assignment.projectId),
    );
    try {
      const [tag] = await context.db
        .update(projectTags)
        .set({
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.color === undefined ? {} : { color: input.color }),
          updatedAt: new Date(),
        })
        .where(and(eq(projectTags.id, input.tagId), eq(projectTags.userId, identity.userId)))
        .returning();
      await context.db.insert(auditEvents).values({
        userId: identity.userId,
        action: 'library.tag.updated_by_agent',
        details: { tagId: input.tagId, idempotencyKey: input.idempotencyKey },
      });
      return { action: input.action, tag: publicTag(tag!) };
    } catch (error) {
      if (String(error).includes('project_tags_user_name_idx'))
        throw conflict('A tag with that name already exists');
      throw error;
    }
  }

  if (input.action === 'delete_tag') {
    await ownedTag(context, identity.userId, input.tagId);
    const assignments = await context.db
      .select({ projectId: projectTagAssignments.projectId })
      .from(projectTagAssignments)
      .where(
        and(
          eq(projectTagAssignments.userId, identity.userId),
          eq(projectTagAssignments.tagId, input.tagId),
        ),
      );
    await requireAllProjectsGranted(
      context,
      identity,
      assignments.map((assignment) => assignment.projectId),
    );
    await context.db.transaction(async (tx) => {
      await tx
        .delete(projectTags)
        .where(and(eq(projectTags.id, input.tagId), eq(projectTags.userId, identity.userId)));
      await tx.insert(auditEvents).values({
        userId: identity.userId,
        action: 'library.tag.deleted_by_agent',
        details: { tagId: input.tagId, idempotencyKey: input.idempotencyKey },
      });
    });
    return { action: input.action, tagId: input.tagId, removedAssignmentCount: assignments.length };
  }

  await requireGrantedProject(context, identity, input.projectId);
  if (input.action === 'move_project') {
    if (input.folderId) await ownedFolder(context, identity.userId, input.folderId);
    await context.db.transaction(async (tx) => {
      await tx
        .update(projectMemberships)
        .set({ folderId: input.folderId })
        .where(
          and(
            eq(projectMemberships.userId, identity.userId),
            eq(projectMemberships.projectId, input.projectId),
          ),
        );
      await tx.insert(auditEvents).values({
        userId: identity.userId,
        projectId: input.projectId,
        action: 'library.project.moved_by_agent',
        details: { folderId: input.folderId, idempotencyKey: input.idempotencyKey },
      });
    });
    return { action: input.action, projectId: input.projectId, folderId: input.folderId };
  }

  const tagIds = [...new Set(input.tagIds)];
  if (tagIds.length) {
    const tags = await context.db
      .select({ id: projectTags.id })
      .from(projectTags)
      .where(and(eq(projectTags.userId, identity.userId), inArray(projectTags.id, tagIds)));
    if (tags.length !== tagIds.length) throw notFound('One or more tags were not found');
  }
  await context.db.transaction(async (tx) => {
    await tx
      .delete(projectTagAssignments)
      .where(
        and(
          eq(projectTagAssignments.userId, identity.userId),
          eq(projectTagAssignments.projectId, input.projectId),
        ),
      );
    if (tagIds.length)
      await tx
        .insert(projectTagAssignments)
        .values(
          tagIds.map((tagId) => ({ projectId: input.projectId, tagId, userId: identity.userId })),
        );
    await tx.insert(auditEvents).values({
      userId: identity.userId,
      projectId: input.projectId,
      action: 'library.project.tags_set_by_agent',
      details: { tagIds, idempotencyKey: input.idempotencyKey },
    });
  });
  return { action: input.action, projectId: input.projectId, tagIds };
}
