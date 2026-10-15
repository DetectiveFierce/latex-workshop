import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { compileJobs, entries, projectMemberships } from '@latex-workshop/db';
import type { CompileJob } from '@latex-workshop/contracts';
import type { AppContext } from './context.js';
import { createCheckpoint, requireProject, lockProjectHead } from './domain.js';
import { badRequest, conflict } from './errors.js';
import { serializeCompile } from '../routes/projects.js';

export async function requestProjectCompilation(
  context: AppContext,
  userId: string,
  projectId: string,
  input: { trigger: CompileJob['trigger'] },
  expectedSourceRevision?: number,
  options: { backgroundPreview?: boolean } = {},
) {
  const project = await requireProject(context.db, userId, projectId);
  if (!project.mainFileId) throw badRequest('Select a main .tex file before compiling');
  const [main] = await context.db
    .select()
    .from(entries)
    .where(and(eq(entries.id, project.mainFileId), eq(entries.projectId, projectId)))
    .limit(1);
  if (!main) throw badRequest('The selected main file no longer exists');
  if (main.size === 0)
    throw badRequest(
      'The accepted main file is empty. Compile the active proposal or accept its changes first.',
    );

  const [userActive] = await context.db
    .select({ count: sql<number>`count(*)::int` })
    .from(compileJobs)
    .innerJoin(projectMemberships, eq(projectMemberships.projectId, compileJobs.projectId))
    .where(
      and(
        eq(projectMemberships.userId, userId),
        inArray(compileJobs.status, ['queued', 'running']),
      ),
    );
  if ((userActive?.count ?? 0) >= (options.backgroundPreview ? 1 : 2))
    throw conflict('Your compilation concurrency limit has been reached');

  const [active] = await context.db
    .select()
    .from(compileJobs)
    .where(
      and(eq(compileJobs.projectId, projectId), inArray(compileJobs.status, ['queued', 'running'])),
    )
    .orderBy(desc(compileJobs.createdAt))
    .limit(1);
  if (active && options.backgroundPreview)
    throw conflict('A compilation is already running for this project');
  if (active?.status === 'running' && input.trigger === 'auto')
    return { job: serializeCompile(active), coalesced: true };
  if (active?.status === 'queued' && active.trigger === 'auto') {
    await context.queue.remove(active.id).catch(() => undefined);
    await context.db
      .update(compileJobs)
      .set({ status: 'cancelled', finishedAt: new Date() })
      .where(eq(compileJobs.id, active.id));
  } else if (active) {
    throw conflict('A compilation is already running for this project');
  }

  const job = await context.db.transaction(async (tx) => {
    await lockProjectHead(tx, projectId);
    const currentProject = await requireProject(tx, userId, projectId);
    const [currentActive] = await tx
      .select({ id: compileJobs.id })
      .from(compileJobs)
      .where(
        and(
          eq(compileJobs.projectId, projectId),
          inArray(compileJobs.status, ['queued', 'running']),
        ),
      )
      .limit(1);
    if (currentActive) throw conflict('A compilation is already running for this project');
    if (options.backgroundPreview) {
      if (currentProject.trashedAt || currentProject.mainFileId !== project.mainFileId)
        throw conflict('Project changed before preview generation');
      const [preview] = await tx
        .select({ id: compileJobs.id })
        .from(compileJobs)
        .where(
          and(
            eq(compileJobs.projectId, projectId),
            eq(compileJobs.target, 'accepted'),
            eq(compileJobs.status, 'succeeded'),
            isNotNull(compileJobs.pdfObjectKey),
          ),
        )
        .limit(1);
      if (preview) throw conflict('Project already has a preview');
    }
    const snapshot = await createCheckpoint(tx, projectId, 'compile');
    if (expectedSourceRevision !== undefined && snapshot.sourceRevision !== expectedSourceRevision)
      throw conflict('Project changed before compilation. Refresh the current tree.', {
        sourceRevision: snapshot.sourceRevision,
      });
    const [created] = await tx
      .insert(compileJobs)
      .values({
        projectId,
        checkpointId: snapshot.id,
        sourceRevision: snapshot.sourceRevision,
        engine: currentProject.compiler,
        trigger: input.trigger,
      })
      .returning();
    if (!created) throw new Error('Compilation was not created');
    return created;
  });
  try {
    await context.queue.add(
      'compile',
      { compileJobId: job.id },
      {
        jobId: job.id,
        ...(options.backgroundPreview ? { priority: 10 } : {}),
        attempts: 2,
        backoff: { type: 'fixed', delay: 1_000 },
        removeOnComplete: 500,
        removeOnFail: 500,
      },
    );
  } catch (error) {
    await context.db
      .update(compileJobs)
      .set({ status: 'failed', finishedAt: new Date(), log: 'Compilation could not be queued' })
      .where(eq(compileJobs.id, job.id));
    throw error;
  }
  return { job: serializeCompile(job) };
}
