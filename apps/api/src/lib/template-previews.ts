import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { compileJobs, projects } from '@latex-workshop/db';
import type { AppContext } from './context.js';
import { createCheckpoint } from './domain.js';
import { incrementMetric } from './operational-metrics.js';

const scheduled = new Map<string, ReturnType<typeof setTimeout>>();

export function scheduleTemplatePreview(context: AppContext, projectId: string, delayMs = 1_500) {
  const existing = scheduled.get(projectId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    scheduled.delete(projectId);
    void queueTemplatePreview(context, projectId).catch(() => {
      incrementMetric('latex_template_preview_queue_total', { status: 'failed' });
    });
  }, delayMs);
  timer.unref();
  scheduled.set(projectId, timer);
}

async function queueTemplatePreview(context: AppContext, projectId: string) {
  const result = await context.db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${'template-preview:' + projectId}))`,
    );
    const [project] = await tx.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!project?.isTemplate || project.trashedAt || !project.mainFileId)
      return { kind: 'current' } as const;

    const [current] = await tx
      .select({ id: compileJobs.id })
      .from(compileJobs)
      .where(
        and(
          eq(compileJobs.projectId, projectId),
          eq(compileJobs.sourceRevision, project.sourceRevision),
          eq(compileJobs.engine, project.compiler),
          eq(compileJobs.status, 'succeeded'),
          isNotNull(compileJobs.pdfObjectKey),
        ),
      )
      .orderBy(desc(compileJobs.createdAt))
      .limit(1);
    if (current) return { kind: 'current' } as const;

    const [active] = await tx
      .select({ id: compileJobs.id })
      .from(compileJobs)
      .where(
        and(
          eq(compileJobs.projectId, projectId),
          inArray(compileJobs.status, ['queued', 'running']),
          isNull(compileJobs.finishedAt),
        ),
      )
      .limit(1);
    if (active) return { kind: 'retry' } as const;

    const checkpoint = await createCheckpoint(tx, projectId, 'compile');
    const [job] = await tx
      .insert(compileJobs)
      .values({
        projectId,
        checkpointId: checkpoint.id,
        sourceRevision: checkpoint.sourceRevision,
        engine: project.compiler,
        trigger: 'auto',
      })
      .returning();
    return { kind: 'queued', job: job! } as const;
  });

  if (result.kind === 'retry') {
    scheduleTemplatePreview(context, projectId, 2_000);
    return;
  }
  if (result.kind !== 'queued') return;
  await context.queue.add(
    'compile',
    { compileJobId: result.job.id },
    {
      jobId: result.job.id,
      attempts: 2,
      backoff: { type: 'fixed', delay: 1_000 },
      removeOnComplete: 500,
      removeOnFail: 500,
    },
  );
  incrementMetric('latex_template_preview_queue_total', { status: 'queued' });
}
