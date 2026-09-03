import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Database, DatabaseTransaction } from '@latex-workshop/db';
import {
  checkpoints,
  entries,
  fileBlobs,
  fileVersions,
  libraryFolders,
  projectMemberships,
  projects,
  userTemplateSeeds,
  type CheckpointManifestEntry,
} from '@latex-workshop/db';
import type { ObjectStorage } from '@latex-workshop/storage';
import { forbidden, notFound, quotaExceeded } from './errors.js';
import type { AppConfig } from '@latex-workshop/config';
import { buildEntryPaths, mergeText } from '@latex-workshop/contracts';

export { buildEntryPaths } from '@latex-workshop/contracts';

export function sha256(value: Uint8Array | string) {
  return createHash('sha256').update(value).digest('hex');
}

export async function requireProject(db: Database, userId: string, projectId: string) {
  const [row] = await db
    .select({ project: projects, role: projectMemberships.role })
    .from(projects)
    .innerJoin(projectMemberships, eq(projectMemberships.projectId, projects.id))
    .where(and(eq(projects.id, projectId), eq(projectMemberships.userId, userId)))
    .limit(1);
  if (!row) throw notFound('Project not found');
  if (row.role !== 'owner') throw forbidden();
  return row.project;
}

export async function requireLibraryFolder(db: Database, userId: string, folderId: string) {
  const [folder] = await db
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

export async function storeFileVersion(
  db: Database,
  storage: ObjectStorage,
  entry: typeof entries.$inferSelect,
  content: Uint8Array,
  mimeType: string,
) {
  const hash = sha256(content);
  const objectKey = `blobs/${hash.slice(0, 2)}/${hash}`;
  await storage.put(objectKey, content, mimeType);
  const nextVersion = entry.version + 1;
  const [version] = await db.transaction(async (tx) => {
    await tx
      .insert(fileBlobs)
      .values({ hash, objectKey, size: content.byteLength })
      .onConflictDoUpdate({
        target: fileBlobs.hash,
        set: { refCount: sql`${fileBlobs.refCount} + 1` },
      });
    const [created] = await tx
      .insert(fileVersions)
      .values({ entryId: entry.id, blobHash: hash, version: nextVersion })
      .returning();
    await tx
      .update(entries)
      .set({
        currentVersionId: created!.id,
        version: nextVersion,
        size: content.byteLength,
        mimeType,
        updatedAt: new Date(),
      })
      .where(eq(entries.id, entry.id));
    await tx
      .update(projects)
      .set({ sourceRevision: sql`${projects.sourceRevision} + 1`, updatedAt: new Date() })
      .where(eq(projects.id, entry.projectId));
    return [created!];
  });
  return version;
}

export type SaveTextVersionResult =
  | {
      kind: 'saved' | 'unchanged';
      entry: typeof entries.$inferSelect;
      content: string;
      merged: boolean;
    }
  | {
      kind: 'conflict';
      entry: typeof entries.$inferSelect;
      content: string;
    };

export async function saveTextFileVersion(
  db: Database,
  storage: ObjectStorage,
  projectId: string,
  entryId: string,
  baseVersion: number,
  localContent: string,
  mimeType: string,
  onPersist?: (
    tx: DatabaseTransaction,
    result: Extract<SaveTextVersionResult, { kind: 'saved' | 'unchanged' }>,
  ) => Promise<void>,
): Promise<SaveTextVersionResult> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select ${entries.id} from ${entries} where ${entries.id} = ${entryId} and ${entries.projectId} = ${projectId} for update`,
    );
    const [current] = await tx
      .select({ entry: entries, version: fileVersions, blob: fileBlobs })
      .from(entries)
      .innerJoin(fileVersions, eq(entries.currentVersionId, fileVersions.id))
      .innerJoin(fileBlobs, eq(fileVersions.blobHash, fileBlobs.hash))
      .where(and(eq(entries.id, entryId), eq(entries.projectId, projectId)))
      .limit(1);
    if (!current) throw notFound('File not found');

    const localBytes = Buffer.from(localContent);
    const localHash = sha256(localBytes);
    if (localHash === current.blob.hash) {
      const result = {
        kind: 'unchanged',
        entry: current.entry,
        content: localContent,
        merged: false,
      } as const;
      await onPersist?.(tx, result);
      return result;
    }

    let finalContent = localContent;
    let finalBytes = localBytes;
    let merged = false;
    if (current.entry.version !== baseVersion) {
      const [base] = await tx
        .select({ blob: fileBlobs })
        .from(fileVersions)
        .innerJoin(fileBlobs, eq(fileVersions.blobHash, fileBlobs.hash))
        .where(and(eq(fileVersions.entryId, entryId), eq(fileVersions.version, baseVersion)))
        .limit(1);
      const currentContent = (await storage.getBuffer(current.blob.objectKey)).toString('utf8');
      if (!base) return { kind: 'conflict', entry: current.entry, content: currentContent };
      const baseContent = (await storage.getBuffer(base.blob.objectKey)).toString('utf8');
      const result = mergeText(baseContent, localContent, currentContent);
      if (!result.clean) return { kind: 'conflict', entry: current.entry, content: currentContent };
      finalContent = result.content;
      finalBytes = Buffer.from(finalContent);
      merged = finalContent !== localContent;
      if (sha256(finalBytes) === current.blob.hash) {
        const result = {
          kind: 'unchanged',
          entry: current.entry,
          content: finalContent,
          merged,
        } as const;
        await onPersist?.(tx, result);
        return result;
      }
    }

    const hash = sha256(finalBytes);
    const objectKey = `blobs/${hash.slice(0, 2)}/${hash}`;
    await storage.put(objectKey, finalBytes, mimeType);
    const nextVersion = current.entry.version + 1;
    await tx
      .insert(fileBlobs)
      .values({ hash, objectKey, size: finalBytes.byteLength })
      .onConflictDoUpdate({
        target: fileBlobs.hash,
        set: { refCount: sql`${fileBlobs.refCount} + 1` },
      });
    const [created] = await tx
      .insert(fileVersions)
      .values({ entryId, blobHash: hash, version: nextVersion })
      .returning();
    const [fresh] = await tx
      .update(entries)
      .set({
        currentVersionId: created!.id,
        version: nextVersion,
        size: finalBytes.byteLength,
        mimeType,
        updatedAt: new Date(),
      })
      .where(and(eq(entries.id, entryId), eq(entries.version, current.entry.version)))
      .returning();
    if (!fresh) throw new Error('File version update lost its lock');
    await tx
      .update(projects)
      .set({ sourceRevision: sql`${projects.sourceRevision} + 1`, updatedAt: new Date() })
      .where(eq(projects.id, projectId));
    const result = { kind: 'saved', entry: fresh, content: finalContent, merged } as const;
    await onPersist?.(tx, result);
    return result;
  });
}

export async function createCheckpoint(
  db: Database | DatabaseTransaction,
  projectId: string,
  reason: 'periodic' | 'compile' | 'import' | 'restore',
) {
  const projectEntries = await db
    .select()
    .from(entries)
    .where(eq(entries.projectId, projectId))
    .orderBy(asc(entries.createdAt));
  const files = projectEntries.filter((entry) => entry.kind === 'file' && entry.currentVersionId);
  const versions = files.length
    ? await db
        .select({ version: fileVersions, blob: fileBlobs })
        .from(fileVersions)
        .innerJoin(fileBlobs, eq(fileVersions.blobHash, fileBlobs.hash))
        .where(
          inArray(
            fileVersions.id,
            files.map((entry) => entry.currentVersionId!),
          ),
        )
    : [];
  const versionMap = new Map(versions.map(({ version, blob }) => [version.id, { version, blob }]));
  const paths = buildEntryPaths(projectEntries);
  const manifest: CheckpointManifestEntry[] = files.map((entry) => {
    const pair = versionMap.get(entry.currentVersionId!);
    if (!pair) throw new Error(`Missing current version for ${entry.id}`);
    return {
      entryId: entry.id,
      path: paths.get(entry.id)!,
      versionId: pair.version.id,
      blobHash: pair.blob.hash,
      objectKey: pair.blob.objectKey,
      size: pair.blob.size,
      mimeType: entry.mimeType,
    };
  });
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) throw notFound('Project not found');
  const [checkpoint] = await db
    .insert(checkpoints)
    .values({ projectId, sourceRevision: project.sourceRevision, reason, manifest })
    .returning();
  return checkpoint!;
}

export async function getFileWithBlob(db: Database, projectId: string, entryId: string) {
  const [row] = await db
    .select({ entry: entries, version: fileVersions, blob: fileBlobs })
    .from(entries)
    .leftJoin(fileVersions, eq(entries.currentVersionId, fileVersions.id))
    .leftJoin(fileBlobs, eq(fileVersions.blobHash, fileBlobs.hash))
    .where(and(eq(entries.id, entryId), eq(entries.projectId, projectId)))
    .limit(1);
  if (!row?.version || !row.blob) throw notFound('File not found');
  return row as {
    entry: typeof entries.$inferSelect;
    version: typeof fileVersions.$inferSelect;
    blob: typeof fileBlobs.$inferSelect;
  };
}

export async function assertStorageQuota(
  db: Database | DatabaseTransaction,
  config: AppConfig,
  userId: string,
  projectId: string,
  deltaBytes: number,
) {
  const [projectUsage] = await db
    .select({ bytes: sql<number>`coalesce(sum(${entries.size}), 0)::bigint` })
    .from(entries)
    .where(eq(entries.projectId, projectId));
  if (Number(projectUsage?.bytes ?? 0) + deltaBytes > config.MAX_PROJECT_BYTES)
    throw quotaExceeded('Project storage limit reached');
  const [userUsage] = await db
    .select({ bytes: sql<number>`coalesce(sum(${entries.size}), 0)::bigint` })
    .from(entries)
    .innerJoin(projectMemberships, eq(projectMemberships.projectId, entries.projectId))
    .leftJoin(userTemplateSeeds, eq(userTemplateSeeds.projectId, entries.projectId))
    .where(and(eq(projectMemberships.userId, userId), isNull(userTemplateSeeds.projectId)));
  if (Number(userUsage?.bytes ?? 0) + deltaBytes > config.MAX_USER_BYTES)
    throw quotaExceeded('Account storage limit reached');
}
