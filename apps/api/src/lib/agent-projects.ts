import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import {
  agentProjectGrants,
  agentProposals,
  auditEvents,
  entries,
  fileBlobs,
  fileVersions,
  projectMemberships,
  projects,
} from '@latex-workshop/db';
import { agentProposalLimits, buildEntryPaths } from '@latex-workshop/contracts';
import type { AppContext } from './context.js';
import { badRequest, notFound, quotaExceeded } from './errors.js';
import { assertProjectSlots, defaultDocument } from './project-creation.js';
import { assertStorageQuota, sha256 } from './domain.js';
import {
  finishAgentProposal,
  getAgentClientProposal,
  isAgentEditableSource,
  putAgentProposalFile,
  requireGrantedProject,
  startAgentProposal,
} from './agent-proposals.js';

type AgentIdentity = { userId: string; clientId: string; clientName: string };
type SeedFile = { path: string; content: string; mimeType: string | null };

function deterministicUuid(value: string): string {
  const hash = sha256(value).slice(0, 32).split('');
  hash[12] = '5';
  hash[16] = ['8', '9', 'a', 'b'][Number.parseInt(hash[16] ?? '0', 16) % 4] ?? '8';
  const joined = hash.join('');
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}

function decodeSource(bytes: Uint8Array, path: string) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw badRequest(`Source project contains a non-UTF-8 file that cannot be reviewed: ${path}`);
  }
}

async function seedFromProject(
  context: AppContext,
  identity: AgentIdentity,
  sourceProjectId: string,
) {
  const source = await requireGrantedProject(context, identity, sourceProjectId);
  const rows = await context.db
    .select({ entry: entries, version: fileVersions, blob: fileBlobs })
    .from(entries)
    .leftJoin(fileVersions, eq(entries.currentVersionId, fileVersions.id))
    .leftJoin(fileBlobs, eq(fileVersions.blobHash, fileBlobs.hash))
    .where(eq(entries.projectId, sourceProjectId))
    .orderBy(asc(entries.createdAt));
  const paths = buildEntryPaths(rows.map(({ entry }) => entry));
  const files: SeedFile[] = [];
  for (const row of rows) {
    if (row.entry.kind !== 'file') continue;
    const path = paths.get(row.entry.id) ?? row.entry.name;
    if (!isAgentEditableSource(row.entry.name, row.entry.mimeType))
      throw badRequest(`Source project contains a binary file that cannot be proposed: ${path}`);
    if (!row.blob) throw badRequest(`Source project file has no accepted content: ${path}`);
    files.push({
      path,
      content: decodeSource(await context.storage.getBuffer(row.blob.objectKey), path),
      mimeType: row.entry.mimeType,
    });
  }
  const sourcePaths = new Map(
    rows.map(({ entry }) => [entry.id, paths.get(entry.id) ?? entry.name]),
  );
  const mainPath = source.mainFileId ? sourcePaths.get(source.mainFileId) : undefined;
  return {
    compiler: source.compiler,
    autoCompile: source.autoCompile,
    files,
    mainPath: mainPath ?? files.find((file) => file.path.endsWith('.tex'))?.path ?? 'main.tex',
  };
}

export async function createAgentProject(
  context: AppContext,
  identity: AgentIdentity,
  input: {
    name: string;
    sourceProjectId?: string | undefined;
    isTemplate: boolean;
    idempotencyKey: string;
  },
) {
  const projectId = deterministicUuid(
    `agent-project\0${identity.userId}\0${identity.clientId}\0${input.idempotencyKey}`,
  );
  const [existing] = await context.db
    .select()
    .from(projects)
    .innerJoin(
      projectMemberships,
      and(
        eq(projectMemberships.projectId, projects.id),
        eq(projectMemberships.userId, identity.userId),
      ),
    )
    .where(and(eq(projects.id, projectId), isNull(projects.trashedAt)))
    .limit(1);
  if (existing) {
    const [proposal] = await context.db
      .select({ id: agentProposals.id })
      .from(agentProposals)
      .where(
        and(
          eq(agentProposals.projectId, projectId),
          eq(agentProposals.clientId, identity.clientId),
        ),
      )
      .limit(1);
    if (!proposal) throw notFound('Created project proposal not found');
    return {
      project: summarizeProject(existing.projects),
      proposal: await getAgentClientProposal(context, identity, proposal.id),
    };
  }

  const seed = input.sourceProjectId
    ? await seedFromProject(context, identity, input.sourceProjectId)
    : {
        compiler: 'pdflatex' as const,
        autoCompile: true,
        files: [{ path: 'main.tex', content: defaultDocument, mimeType: 'text/x-tex' }],
        mainPath: 'main.tex',
      };
  const totalBytes = seed.files.reduce((total, file) => total + Buffer.byteLength(file.content), 0);
  if (seed.files.some((file) => Buffer.byteLength(file.content) > agentProposalLimits.maxFileBytes))
    throw quotaExceeded('Source project contains a file that is too large for review');
  if (seed.files.length > agentProposalLimits.maxChangedEntries)
    throw quotaExceeded('Source project has too many files for one review proposal');
  if (totalBytes > agentProposalLimits.maxProposalBytes)
    throw quotaExceeded('Source project is too large for one review proposal');
  if (!seed.files.some((file) => file.path === seed.mainPath))
    throw badRequest('Source project main file cannot be proposed');

  const emptyHash = sha256('');
  const emptyObjectKey = `blobs/${emptyHash.slice(0, 2)}/${emptyHash}`;
  await context.storage.put(emptyObjectKey, Buffer.alloc(0), 'text/plain');
  const created = await context.db.transaction(async (tx) => {
    await assertProjectSlots(tx, context.config, identity.userId);
    const [project] = await tx
      .insert(projects)
      .values({
        id: projectId,
        name: input.name,
        compiler: seed.compiler,
        autoCompile: seed.autoCompile,
        isTemplate: input.isTemplate,
      })
      .returning();
    if (!project) throw new Error('Agent project was not created');
    await assertStorageQuota(tx, context.config, identity.userId, projectId, totalBytes);
    await tx.insert(projectMemberships).values({
      projectId,
      userId: identity.userId,
      role: 'owner',
    });
    await tx
      .insert(agentProjectGrants)
      .values({
        projectId,
        userId: identity.userId,
        clientId: identity.clientId,
        clientName: identity.clientName,
      })
      .onConflictDoNothing();

    const folderIds = new Map<string, string>();
    const ensureFolder = async (path: string): Promise<string | null> => {
      if (!path) return null;
      const known = folderIds.get(path);
      if (known) return known;
      const slash = path.lastIndexOf('/');
      const parentId = await ensureFolder(slash < 0 ? '' : path.slice(0, slash));
      const [folder] = await tx
        .insert(entries)
        .values({
          projectId,
          parentId,
          name: slash < 0 ? path : path.slice(slash + 1),
          kind: 'folder',
        })
        .returning();
      if (!folder) throw new Error('Project folder skeleton was not created');
      folderIds.set(path, folder.id);
      return folder.id;
    };
    let mainFileId: string | null = null;
    for (const file of seed.files) {
      const slash = file.path.lastIndexOf('/');
      const parentId = await ensureFolder(slash < 0 ? '' : file.path.slice(0, slash));
      const [entry] = await tx
        .insert(entries)
        .values({
          projectId,
          parentId,
          name: slash < 0 ? file.path : file.path.slice(slash + 1),
          kind: 'file',
          mimeType: file.mimeType,
          size: 0,
          version: 1,
        })
        .returning();
      if (!entry) throw new Error('Project file skeleton was not created');
      await tx
        .insert(fileBlobs)
        .values({ hash: emptyHash, objectKey: emptyObjectKey, size: 0 })
        .onConflictDoUpdate({
          target: fileBlobs.hash,
          set: { refCount: sql`${fileBlobs.refCount} + 1` },
        });
      const [version] = await tx
        .insert(fileVersions)
        .values({ entryId: entry.id, blobHash: emptyHash, version: 1 })
        .returning();
      await tx
        .update(entries)
        .set({ currentVersionId: version!.id })
        .where(eq(entries.id, entry.id));
      if (file.path === seed.mainPath) mainFileId = entry.id;
    }
    const [result] = await tx
      .update(projects)
      .set({ mainFileId, sourceRevision: 1, updatedAt: new Date() })
      .where(eq(projects.id, projectId))
      .returning();
    await tx.insert(auditEvents).values({
      userId: identity.userId,
      projectId,
      action: 'project.created_by_agent',
      details: { sourceProjectId: input.sourceProjectId ?? null, isTemplate: input.isTemplate },
    });
    return result!;
  });

  let proposal = await startAgentProposal(context, identity, {
    projectId,
    title: `Create ${input.isTemplate ? 'template' : 'project'} “${input.name}”`,
    idempotencyKey: deterministicUuid(`${input.idempotencyKey}\0start`),
  });
  for (const file of seed.files) {
    proposal = await putAgentProposalFile(context, identity, proposal.id, {
      expectedProposalRevision: proposal.revision,
      idempotencyKey: deterministicUuid(`${input.idempotencyKey}\0file\0${file.path}`),
      path: file.path,
      content: file.content,
      baseHash: emptyHash,
    });
  }
  proposal = await finishAgentProposal(context, identity, proposal.id, {
    expectedProposalRevision: proposal.revision,
    idempotencyKey: deterministicUuid(`${input.idempotencyKey}\0finish`),
  });
  return { project: summarizeProject(created), proposal };
}

export async function renameAgentProject(
  context: AppContext,
  identity: AgentIdentity,
  input: { projectId: string; name: string; idempotencyKey: string },
) {
  const project = await requireGrantedProject(context, identity, input.projectId);
  if (project.name === input.name) return summarizeProject(project);
  const [updated] = await context.db.transaction(async (tx) => {
    const rows = await tx
      .update(projects)
      .set({ name: input.name, updatedAt: new Date() })
      .where(eq(projects.id, input.projectId))
      .returning();
    await tx.insert(auditEvents).values({
      userId: identity.userId,
      projectId: input.projectId,
      action: 'project.renamed_by_agent',
      details: { from: project.name, to: input.name, idempotencyKey: input.idempotencyKey },
    });
    return rows;
  });
  return summarizeProject(updated!);
}

function summarizeProject(project: typeof projects.$inferSelect) {
  return {
    id: project.id,
    name: project.name,
    sourceRevision: project.sourceRevision,
    compiler: project.compiler,
    isTemplate: project.isTemplate,
  };
}
