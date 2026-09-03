import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNotNull, isNull, lt, notExists } from 'drizzle-orm';
import {
  checkpoints,
  compileJobs,
  fileBlobs,
  fileVersions,
  entries,
  projectMemberships,
  projects,
} from '@latex-workshop/db';
import type { AppContext } from './context.js';
import { createCheckpoint } from './domain.js';

const RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const CHECKPOINT_IDLE_MS = 5 * 60 * 1_000;

export function startMaintenance(
  context: AppContext,
  log: {
    info: (value: unknown, message?: string) => void;
    error: (value: unknown, message?: string) => void;
  },
) {
  const execute = () =>
    void runMaintenance(context).catch((error) => log.error(error, 'Maintenance pass failed'));
  const initial = setTimeout(execute, 10_000);
  const interval = setInterval(execute, 60_000);
  initial.unref();
  interval.unref();
  return () => {
    clearTimeout(initial);
    clearInterval(interval);
  };
}

export async function runMaintenance(context: AppContext) {
  const token = randomUUID();
  const acquired = await context.redis.set(
    'latex-workshop:maintenance-lock',
    token,
    'EX',
    55,
    'NX',
  );
  if (!acquired) return;
  try {
    const now = Date.now();
    const retentionCutoff = new Date(now - RETENTION_MS);

    const orphanProjects = await context.db
      .select({ id: projects.id })
      .from(projects)
      .leftJoin(projectMemberships, eq(projectMemberships.projectId, projects.id))
      .where(isNull(projectMemberships.projectId));
    const expiredTrash = await context.db
      .select({ id: projects.id })
      .from(projects)
      .where(and(isNotNull(projects.trashedAt), lt(projects.trashedAt, retentionCutoff)));
    const deletedProjectIds = [
      ...new Set([...orphanProjects, ...expiredTrash].map(({ id }) => id)),
    ];
    for (const id of deletedProjectIds)
      await Promise.all([
        context.storage.deletePrefix(`artifacts/${id}/`),
        context.storage.deletePrefix(`edit-history/${id}/`),
      ]);
    if (deletedProjectIds.length)
      await context.db.delete(projects).where(inArray(projects.id, deletedProjectIds));

    const expiredJobs = await context.db
      .select({
        id: compileJobs.id,
        pdf: compileJobs.pdfObjectKey,
        synctex: compileJobs.synctexObjectKey,
      })
      .from(compileJobs)
      .where(lt(compileJobs.createdAt, retentionCutoff));
    for (const job of expiredJobs) {
      if (job.pdf) await context.storage.delete(job.pdf);
      if (job.synctex) await context.storage.delete(job.synctex);
    }
    if (expiredJobs.length)
      await context.db.delete(compileJobs).where(
        inArray(
          compileJobs.id,
          expiredJobs.map(({ id }) => id),
        ),
      );

    const expiredCheckpoints = await context.db
      .select({ id: checkpoints.id })
      .from(checkpoints)
      .leftJoin(compileJobs, eq(compileJobs.checkpointId, checkpoints.id))
      .where(and(lt(checkpoints.createdAt, retentionCutoff), isNull(compileJobs.id)));
    if (expiredCheckpoints.length)
      await context.db.delete(checkpoints).where(
        inArray(
          checkpoints.id,
          expiredCheckpoints.map(({ id }) => id),
        ),
      );

    const expiredVersions = await context.db
      .select({ id: fileVersions.id })
      .from(fileVersions)
      .leftJoin(entries, eq(entries.currentVersionId, fileVersions.id))
      .where(and(lt(fileVersions.createdAt, retentionCutoff), isNull(entries.id)));
    if (expiredVersions.length)
      await context.db.delete(fileVersions).where(
        inArray(
          fileVersions.id,
          expiredVersions.map(({ id }) => id),
        ),
      );

    const checkpointCutoff = new Date(now - CHECKPOINT_IDLE_MS);
    const activeProjects = await context.db
      .select()
      .from(projects)
      .where(and(isNull(projects.trashedAt), lt(projects.updatedAt, checkpointCutoff)));
    for (const project of activeProjects) {
      const [latest] = await context.db
        .select({ sourceRevision: checkpoints.sourceRevision })
        .from(checkpoints)
        .where(eq(checkpoints.projectId, project.id))
        .orderBy(desc(checkpoints.createdAt))
        .limit(1);
      if (!latest || latest.sourceRevision < project.sourceRevision)
        await createCheckpoint(context.db, project.id, 'periodic');
    }

    const retainedManifests = await context.db
      .select({ manifest: checkpoints.manifest })
      .from(checkpoints);
    const retainedHashes = new Set(
      retainedManifests.flatMap(({ manifest }) => manifest.map(({ blobHash }) => blobHash)),
    );
    const unreferenced = await context.db
      .select({ hash: fileBlobs.hash, objectKey: fileBlobs.objectKey })
      .from(fileBlobs)
      .leftJoin(fileVersions, eq(fileVersions.blobHash, fileBlobs.hash))
      .where(isNull(fileVersions.id));
    const collectible = unreferenced.filter(({ hash }) => !retainedHashes.has(hash));
    if (collectible.length) {
      const claimed = await context.db
        .delete(fileBlobs)
        .where(
          and(
            inArray(
              fileBlobs.hash,
              collectible.map(({ hash }) => hash),
            ),
            notExists(
              context.db
                .select({ id: fileVersions.id })
                .from(fileVersions)
                .where(eq(fileVersions.blobHash, fileBlobs.hash)),
            ),
          ),
        )
        .returning({ objectKey: fileBlobs.objectKey });
      for (const blob of claimed) await context.storage.delete(blob.objectKey);
    }
  } finally {
    await context.redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      'latex-workshop:maintenance-lock',
      token,
    );
  }
}
