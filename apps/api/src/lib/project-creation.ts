import { readFile } from 'node:fs/promises';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { AppConfig } from '@latex-workshop/config';
import {
  auditEvents,
  entries,
  fileBlobs,
  fileVersions,
  projectMemberships,
  projects,
  userTemplateSeeds,
  type DatabaseTransaction,
} from '@latex-workshop/db';
import type { AppContext } from './context.js';
import { assertStorageQuota, buildEntryPaths, sha256 } from './domain.js';
import { notFound, quotaExceeded } from './errors.js';

export const AIDAN_TEMPLATE_SEED_KEY =
  'detective-fierce/tex-template@ec40af3ef128d3950050e39d5a257aa6d8ff9aed';

const defaultDocument = String.raw`\documentclass{article}
\usepackage[T1]{fontenc}
\usepackage{lmodern}
\title{Untitled Document}
\author{}
\date{\today}

\begin{document}
\maketitle

Start writing here.

\end{document}
`;

const starterManifest = [
  ['.gitignore', '17d8b9ce9d91570a8630df6ad976fb1cff1b692e85f4614b137ec843452358dc'],
  ['.latexmkrc', '2f3e4e9b98366bcb314b196b63696b30bf7313a738f27219801934bc8ad479c8'],
  ['README.md', '4018ffd3ca5febf3f0dbc0b9a20d869ee6f37b14262a4cd72e25b2ae6ac97d25'],
  ['build.sh', 'a1c77f4c7a221179f06520f65081c145f83c92c6bfbcb4e2e070e3995efe4be6'],
  ['template.tex', '88931162d8d3a703610732933a17fe0079a8648df8d0e21a9bf30d69f06a935b'],
  ['lib/commands.tex', 'c6bd9857ee15217d2b70edc89cd9b3a8083377ea9f3dafb46684c188e6466647'],
  ['lib/config.tex', 'a20a4e927570f00715109b8da5391a50689768d9232334260eb00a84096a316d'],
  ['lib/in_header.tex', '48334cea2018b7bb05d3689a104103f8b797355342532c964ae01c9f1212bed2'],
  ['lib/packages.tex', 'e86275e0b9f1816536b95024bd674ad6eb1a6f9e48367163bbfd582821429f13'],
] as const;

type InitialFile = { path: string; data: Buffer; hash: string; mimeType: string };

export async function assertProjectSlots(
  tx: DatabaseTransaction,
  config: AppConfig,
  userId: string,
  additional = 1,
) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${userId}))`);
  const [usage] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(projectMemberships)
    .innerJoin(projects, eq(projectMemberships.projectId, projects.id))
    .leftJoin(userTemplateSeeds, eq(userTemplateSeeds.projectId, projects.id))
    .where(
      and(
        eq(projectMemberships.userId, userId),
        isNull(projects.trashedAt),
        isNull(userTemplateSeeds.projectId),
      ),
    );
  if ((usage?.count ?? 0) + additional > config.MAX_PROJECTS_PER_USER)
    throw quotaExceeded('Project limit reached');
}

export async function createBlankProject(
  context: AppContext,
  userId: string,
  name: string,
  folderId: string | null,
) {
  const bytes = Buffer.from(defaultDocument);
  const hash = sha256(bytes);
  const objectKey = blobKey(hash);
  await context.storage.put(objectKey, bytes, 'text/x-tex');
  return context.db.transaction(async (tx) => {
    await assertProjectSlots(tx, context.config, userId);
    const [project] = await tx.insert(projects).values({ name }).returning();
    await tx
      .insert(projectMemberships)
      .values({ projectId: project!.id, userId, role: 'owner', folderId });
    await assertStorageQuota(tx, context.config, userId, project!.id, bytes.byteLength);
    const [entry] = await tx
      .insert(entries)
      .values({
        projectId: project!.id,
        name: 'main.tex',
        kind: 'file',
        mimeType: 'text/x-tex',
        size: bytes.byteLength,
        version: 1,
      })
      .returning();
    await referenceBlob(tx, entry!.id, hash, objectKey, bytes.byteLength);
    const [result] = await tx
      .update(projects)
      .set({ mainFileId: entry!.id, sourceRevision: 1, updatedAt: new Date() })
      .where(eq(projects.id, project!.id))
      .returning();
    await tx.insert(auditEvents).values({
      userId,
      projectId: project!.id,
      action: 'project.created',
      details: { source: 'blank' },
    });
    return result!;
  });
}

export async function cloneProjectHead(
  context: AppContext,
  input: {
    userId: string;
    sourceProjectId: string;
    name: string;
    folderId: string | null;
    requireTemplate: boolean;
  },
) {
  return context.db.transaction(
    async (tx) => {
      await assertProjectSlots(tx, context.config, input.userId);
      const [source] = await tx
        .select({ project: projects })
        .from(projects)
        .innerJoin(projectMemberships, eq(projectMemberships.projectId, projects.id))
        .where(
          and(
            eq(projects.id, input.sourceProjectId),
            eq(projectMemberships.userId, input.userId),
            isNull(projects.trashedAt),
            ...(input.requireTemplate ? [eq(projects.isTemplate, true)] : []),
          ),
        )
        .limit(1);
      if (!source) throw notFound('Template not found');

      const sourceEntries = await tx
        .select({ entry: entries, version: fileVersions, blob: fileBlobs })
        .from(entries)
        .leftJoin(fileVersions, eq(entries.currentVersionId, fileVersions.id))
        .leftJoin(fileBlobs, eq(fileVersions.blobHash, fileBlobs.hash))
        .where(eq(entries.projectId, input.sourceProjectId))
        .orderBy(asc(entries.createdAt));
      const totalBytes = sourceEntries.reduce((total, row) => total + row.entry.size, 0);
      if (totalBytes > context.config.MAX_PROJECT_BYTES)
        throw quotaExceeded('Project storage limit reached');

      const [created] = await tx
        .insert(projects)
        .values({
          name: input.name,
          compiler: source.project.compiler,
          autoCompile: source.project.autoCompile,
        })
        .returning();
      await tx.insert(projectMemberships).values({
        projectId: created!.id,
        userId: input.userId,
        role: 'owner',
        folderId: input.folderId,
      });
      await assertStorageQuota(tx, context.config, input.userId, created!.id, totalBytes);

      const paths = buildEntryPaths(sourceEntries.map(({ entry }) => entry));
      const sorted = [...sourceEntries].sort(
        (left, right) =>
          paths.get(left.entry.id)!.split('/').length -
          paths.get(right.entry.id)!.split('/').length,
      );
      const idMap = new Map<string, string>();
      for (const row of sorted) {
        if (row.entry.currentVersionId && (!row.version || !row.blob))
          throw new Error(`Template file ${row.entry.id} has no current blob`);
        const [copy] = await tx
          .insert(entries)
          .values({
            projectId: created!.id,
            parentId: row.entry.parentId ? (idMap.get(row.entry.parentId) ?? null) : null,
            name: row.entry.name,
            kind: row.entry.kind,
            mimeType: row.entry.mimeType,
            size: row.entry.size,
            version: row.blob ? 1 : 0,
          })
          .returning();
        idMap.set(row.entry.id, copy!.id);
        if (row.blob)
          await referenceBlob(tx, copy!.id, row.blob.hash, row.blob.objectKey, row.blob.size);
      }
      const mainFileId = source.project.mainFileId
        ? (idMap.get(source.project.mainFileId) ?? null)
        : null;
      const [result] = await tx
        .update(projects)
        .set({
          mainFileId,
          sourceRevision: sourceEntries.length ? 1 : 0,
          updatedAt: new Date(),
        })
        .where(eq(projects.id, created!.id))
        .returning();
      await tx.insert(auditEvents).values({
        userId: input.userId,
        projectId: created!.id,
        action: input.requireTemplate ? 'project.created_from_template' : 'project.duplicated',
        details: { sourceProjectId: input.sourceProjectId, bytes: totalBytes },
      });
      return result!;
    },
    { isolationLevel: 'repeatable read' },
  );
}

export async function ensureAidanTemplate(context: AppContext, userId: string) {
  const existing = await context.db
    .select({ projectId: userTemplateSeeds.projectId })
    .from(userTemplateSeeds)
    .where(
      and(
        eq(userTemplateSeeds.userId, userId),
        eq(userTemplateSeeds.seedKey, AIDAN_TEMPLATE_SEED_KEY),
      ),
    )
    .limit(1);
  if (existing.length) return false;

  const files = await loadStarterFiles(context.config);
  for (const file of files) await context.storage.put(blobKey(file.hash), file.data, file.mimeType);

  return context.db.transaction(async (tx) => {
    const [receipt] = await tx
      .insert(userTemplateSeeds)
      .values({ userId, seedKey: AIDAN_TEMPLATE_SEED_KEY })
      .onConflictDoNothing()
      .returning();
    if (!receipt) return false;
    const [project] = await tx
      .insert(projects)
      .values({ name: 'Aidan Template', compiler: 'pdflatex', isTemplate: true })
      .returning();
    await tx.insert(projectMemberships).values({ projectId: project!.id, userId, role: 'owner' });
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
          projectId: project!.id,
          parentId,
          name: slash < 0 ? path : path.slice(slash + 1),
          kind: 'folder',
        })
        .returning();
      folderIds.set(path, folder!.id);
      return folder!.id;
    };
    let mainFileId: string | null = null;
    for (const file of files) {
      const slash = file.path.lastIndexOf('/');
      const parentId = await ensureFolder(slash < 0 ? '' : file.path.slice(0, slash));
      const [entry] = await tx
        .insert(entries)
        .values({
          projectId: project!.id,
          parentId,
          name: slash < 0 ? file.path : file.path.slice(slash + 1),
          kind: 'file',
          mimeType: file.mimeType,
          size: file.data.byteLength,
          version: 1,
        })
        .returning();
      await referenceBlob(tx, entry!.id, file.hash, blobKey(file.hash), file.data.byteLength);
      if (file.path === 'template.tex') mainFileId = entry!.id;
    }
    await tx
      .update(projects)
      .set({ mainFileId, sourceRevision: 1, updatedAt: new Date() })
      .where(eq(projects.id, project!.id));
    await tx
      .update(userTemplateSeeds)
      .set({ projectId: project!.id })
      .where(
        and(
          eq(userTemplateSeeds.userId, userId),
          eq(userTemplateSeeds.seedKey, AIDAN_TEMPLATE_SEED_KEY),
        ),
      );
    await tx.insert(auditEvents).values({
      userId,
      projectId: project!.id,
      action: 'project.template_seeded',
      details: { seedKey: AIDAN_TEMPLATE_SEED_KEY, fileCount: files.length },
    });
    return true;
  });
}

async function loadStarterFiles(config: AppConfig): Promise<InitialFile[]> {
  const files = await Promise.all(
    starterManifest.map(async ([path, expectedHash]) => {
      const data = await readFile(new URL(`../templates/aidan-template/${path}`, import.meta.url));
      const hash = sha256(data);
      if (hash !== expectedHash) throw new Error(`Starter template checksum mismatch: ${path}`);
      if (data.byteLength > config.MAX_FILE_BYTES)
        throw new Error(`Starter template file exceeds configured limit: ${path}`);
      return { path, data, hash, mimeType: mimeType(path) };
    }),
  );
  if (files.reduce((total, file) => total + file.data.byteLength, 0) > config.MAX_PROJECT_BYTES)
    throw new Error('Starter template exceeds the configured project limit');
  return files;
}

async function referenceBlob(
  tx: DatabaseTransaction,
  entryId: string,
  hash: string,
  objectKey: string,
  size: number,
) {
  await tx
    .insert(fileBlobs)
    .values({ hash, objectKey, size })
    .onConflictDoUpdate({
      target: fileBlobs.hash,
      set: { refCount: sql`${fileBlobs.refCount} + 1` },
    });
  const [version] = await tx
    .insert(fileVersions)
    .values({ entryId, blobHash: hash, version: 1 })
    .returning();
  await tx.update(entries).set({ currentVersionId: version!.id }).where(eq(entries.id, entryId));
}

const blobKey = (hash: string) => `blobs/${hash.slice(0, 2)}/${hash}`;

function mimeType(path: string) {
  if (path.endsWith('.tex')) return 'text/x-tex';
  if (path.endsWith('.md')) return 'text/markdown';
  if (path.endsWith('.sh')) return 'text/x-shellscript';
  return 'text/plain';
}
