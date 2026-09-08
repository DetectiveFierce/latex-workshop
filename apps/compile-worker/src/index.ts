import { Worker } from 'bullmq';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { z } from 'zod';
import { loadConfig } from '@latex-workshop/config';
import {
  agentPdfPageLimits,
  checkpointManifestSchema,
  pdfPageImageObjectKey,
  pdfPageRenderQueuePayloadSchema,
  pdfPageRenderRequestKey,
  pdfPageRenderRequestSchema,
} from '@latex-workshop/contracts';
import {
  agentProposals,
  checkpoints,
  compileJobs,
  createDatabase,
  projects,
} from '@latex-workshop/db';
import { ObjectStorage } from '@latex-workshop/storage';
import { parseLatexDiagnostics } from './diagnostics.js';
import { compileArtifactObjectKeys, isStaleProposalCompile } from './proposal-jobs.js';
import { DockerCompilationRunner } from './runner.js';
import { DockerPdfPageRenderer } from './pdf-page-renderer.js';

const config = loadConfig();
const { db, client } = createDatabase(config.DATABASE_URL);
const storage = new ObjectStorage(config);
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const runner = new DockerCompilationRunner(config);
const pdfPageRenderer = new DockerPdfPageRenderer(config);
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
    if (job.target === 'proposal' && job.proposalId) {
      const [proposal] = await db
        .select({ revision: agentProposals.revision })
        .from(agentProposals)
        .where(eq(agentProposals.id, job.proposalId))
        .limit(1);
      if (isStaleProposalCompile(job, proposal ?? null)) {
        await db
          .update(compileJobs)
          .set({ status: 'cancelled', finishedAt: new Date() })
          .where(eq(compileJobs.id, job.id));
        await publish(job.projectId, {
          type: 'status',
          job: { id: job.id, status: 'cancelled', target: 'proposal' },
        });
        return;
      }
    }
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
    const manifest = checkpointManifestSchema.parse(checkpoint.manifest);
    const main =
      manifest.find((item) => item.entryId === project.mainFileId) ??
      manifest.find((item) => item.path === 'main.tex');
    if (!main) throw new Error('Main file is not present in the compilation snapshot');
    await db
      .update(compileJobs)
      .set({ status: 'running', startedAt: new Date() })
      .where(eq(compileJobs.id, job.id));
    await publish(job.projectId, { type: 'status', job: { id: job.id, status: 'running' } });
    const files = await Promise.all(
      manifest.map(async (item) => ({
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
    if (result.exitCode === 0 && result.pdf !== null) {
      const keys = compileArtifactObjectKeys(job.projectId, job.id);
      pdfObjectKey = keys.pdf;
      await storage.put(pdfObjectKey, result.pdf, 'application/pdf');
      if (result.synctex) {
        synctexObjectKey = keys.synctex;
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
    if (updated) await publish(job.projectId, { type: 'status', job: serialize(updated) });
  },
  { connection: redis, concurrency: 2, limiter: { max: 20, duration: 60_000 } },
);

const pdfRenderWorker = new Worker<{ compileJobId: string }>(
  'latex-pdf-renders',
  async (queueJob) => {
    const { compileJobId } = pdfPageRenderQueuePayloadSchema.parse(queueJob.data);
    const renderRequestId = z.uuid().parse(queueJob.id);
    const key = pdfPageRenderRequestKey(renderRequestId);
    const raw = await redis.get(key);
    if (!raw) return;
    const envelope = JSON.parse(raw) as { request?: unknown };
    const request = pdfPageRenderRequestSchema.parse(envelope.request);
    await redis.set(
      key,
      JSON.stringify({ status: 'running', request }),
      'EX',
      agentPdfPageLimits.renderRequestTtlSeconds,
    );
    const [job] = await db
      .select({
        id: compileJobs.id,
        projectId: compileJobs.projectId,
        status: compileJobs.status,
        pdfObjectKey: compileJobs.pdfObjectKey,
      })
      .from(compileJobs)
      .where(eq(compileJobs.id, request.compileJobId))
      .limit(1);
    if (
      !job?.pdfObjectKey ||
      job.id !== compileJobId ||
      job.status !== 'succeeded' ||
      job.projectId !== request.projectId
    )
      throw new Error('Compiled PDF is unavailable');
    const pdf = await storage.getBuffer(job.pdfObjectKey);
    const pages = await pdfPageRenderer.render({ renderRequestId, pdf, pages: request.pages });
    const stored = await Promise.all(
      pages.map(async (page) => {
        const objectKey = pdfPageImageObjectKey(job.projectId, job.id, page.page);
        await storage.put(objectKey, page.data, 'image/png');
        return { page: page.page, objectKey };
      }),
    );
    await redis.set(
      key,
      JSON.stringify({ status: 'succeeded', pages: stored }),
      'EX',
      agentPdfPageLimits.renderRequestTtlSeconds,
    );
  },
  { connection: redis, concurrency: 1, limiter: { max: 20, duration: 60_000 } },
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

pdfRenderWorker.on('failed', async (queueJob, error) => {
  if (!queueJob || queueJob.attemptsMade < (queueJob.opts.attempts ?? 1)) return;
  const parsed = pdfPageRenderQueuePayloadSchema.safeParse(queueJob.data);
  const requestId = z.uuid().safeParse(queueJob.id);
  if (!parsed.success || !requestId.success) return;
  await redis.set(
    pdfPageRenderRequestKey(requestId.data),
    JSON.stringify({ status: 'failed', message: error.message.slice(0, 1_000) }),
    'EX',
    agentPdfPageLimits.renderRequestTtlSeconds,
  );
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

let shutdownStarted = false;
const shutdown = async () => {
  if (shutdownStarted) return;
  shutdownStarted = true;
  await Promise.all([worker.close(), pdfRenderWorker.close()]);
  if (redis.status !== 'end') await redis.quit();
  await client.end();
};
const requestShutdown = () => {
  void shutdown().catch((error: unknown) => {
    console.error('Compile worker shutdown failed', error);
    process.exitCode = 1;
  });
};
process.once('SIGINT', requestShutdown);
process.once('SIGTERM', requestShutdown);
