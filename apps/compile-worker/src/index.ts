import { Worker } from 'bullmq';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { loadConfig } from '@latex-workshop/config';
import { checkpoints, compileJobs, createDatabase, projects } from '@latex-workshop/db';
import { ObjectStorage } from '@latex-workshop/storage';
import { parseLatexDiagnostics } from './diagnostics.js';
import { DockerCompilationRunner } from './runner.js';

const config = loadConfig();
const { db, client } = createDatabase(config.DATABASE_URL);
const storage = new ObjectStorage(config);
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const runner = new DockerCompilationRunner(config);
await storage.ensureBucket();

const worker = new Worker<{ compileJobId: string }>(
  'latex-compiles',
  async (queueJob) => {
    const [job] = await db
      .select()
      .from(compileJobs)
      .where(eq(compileJobs.id, queueJob.data.compileJobId))
      .limit(1);
    if (!job || job.status === 'cancelled') return;
    const [checkpoint] = await db
      .select()
      .from(checkpoints)
      .where(eq(checkpoints.id, job.checkpointId))
      .limit(1);
    const [project] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, job.projectId))
      .limit(1);
    if (!checkpoint || !project?.mainFileId) throw new Error('Compilation snapshot is incomplete');
    const main =
      checkpoint.manifest.find((item) => item.entryId === project.mainFileId) ??
      checkpoint.manifest.find((item) => item.path === 'main.tex');
    if (!main) throw new Error('Main file is not present in the compilation snapshot');
    await db
      .update(compileJobs)
      .set({ status: 'running', startedAt: new Date() })
      .where(eq(compileJobs.id, job.id));
    await publish(job.projectId, { type: 'status', job: { id: job.id, status: 'running' } });
    const files = await Promise.all(
      checkpoint.manifest.map(async (item) => ({
        path: item.path,
        data: await storage.getBuffer(item.objectKey),
      })),
    );
    const result = await runner.run({
      jobId: job.id,
      files,
      mainPath: main.path,
      engine: job.engine,
      isCancelled: async () => (await redis.exists(`compile-cancel:${job.id}`)) === 1,
    });
    if ((await redis.exists(`compile-cancel:${job.id}`)) === 1) return;
    const diagnostics = parseLatexDiagnostics(result.log);
    const succeeded = result.exitCode === 0 && result.pdf !== null;
    let pdfObjectKey: string | null = null;
    let synctexObjectKey: string | null = null;
    if (succeeded) {
      pdfObjectKey = `artifacts/${job.projectId}/${job.id}/document.pdf`;
      await storage.put(pdfObjectKey, result.pdf!, 'application/pdf');
      if (result.synctex) {
        synctexObjectKey = `artifacts/${job.projectId}/${job.id}/document.synctex.gz`;
        await storage.put(synctexObjectKey, result.synctex, 'application/gzip');
      }
    }
    const [updated] = await db
      .update(compileJobs)
      .set({
        status: succeeded ? 'succeeded' : 'failed',
        log: result.log,
        diagnostics,
        pdfObjectKey,
        synctexObjectKey,
        durationMs: result.durationMs,
        finishedAt: new Date(),
      })
      .where(eq(compileJobs.id, job.id))
      .returning();
    await publish(job.projectId, { type: 'status', job: serialize(updated!) });
  },
  { connection: redis, concurrency: 2, limiter: { max: 20, duration: 60_000 } },
);

worker.on('failed', async (queueJob, error) => {
  if (!queueJob) return;
  const finalAttempt = queueJob.attemptsMade >= (queueJob.opts.attempts ?? 1);
  if (finalAttempt) {
    const [updated] = await db
      .update(compileJobs)
      .set({
        status: 'failed',
        log: `Compilation infrastructure error: ${error.message}`,
        finishedAt: new Date(),
      })
      .where(eq(compileJobs.id, queueJob.data.compileJobId))
      .returning();
    if (updated) await publish(updated.projectId, { type: 'status', job: serialize(updated) });
  }
});

async function publish(projectId: string, event: unknown) {
  await redis.publish(`compile-events:${projectId}`, JSON.stringify(event));
}

function serialize(job: typeof compileJobs.$inferSelect) {
  return {
    ...job,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}

const shutdown = async () => {
  await worker.close();
  await redis.quit();
  await client.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
