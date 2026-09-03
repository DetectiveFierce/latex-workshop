import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  compileRequestSchema,
  forwardSyncRequestSchema,
  inverseSyncRequestSchema,
  type PdfSyncResult,
} from '@latex-workshop/contracts';
import {
  checkpoints,
  compileJobs,
  entries,
  fileVersions,
  projectMemberships,
} from '@latex-workshop/db';
import type { AppContext } from '../lib/context.js';
import { requireUser } from '../lib/context.js';
import {
  buildEntryPaths,
  createCheckpoint,
  getFileWithBlob,
  requireProject,
} from '../lib/domain.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { incrementMetric, observeMetric } from '../lib/operational-metrics.js';
import { serializeCompile } from './projects.js';
import {
  alignSelectionToCompiled,
  contentHint,
  findSyncTexInput,
  normalizeSyncPath,
  parseSyncTexRecords,
  rankSyncRecords,
  recordToPdfResult,
  structuralSourceAnchors,
  unionSyncResults,
} from '../lib/synctex.js';

const exec = promisify(execFile);

export async function registerCompileRoutes(app: FastifyInstance, context: AppContext) {
  app.post('/api/v1/projects/:projectId/compilations', async (request, reply) => {
    const user = await requireUser(context, request);
    const { projectId } = request.params as { projectId: string };
    const project = await requireProject(context.db, user.id, projectId);
    if (!project.mainFileId) throw badRequest('Select a main .tex file before compiling');
    const [main] = await context.db
      .select()
      .from(entries)
      .where(and(eq(entries.id, project.mainFileId), eq(entries.projectId, projectId)))
      .limit(1);
    if (!main) throw badRequest('The selected main file no longer exists');
    const input = compileRequestSchema.parse(request.body ?? {});

    const [userActive] = await context.db
      .select({ count: sql<number>`count(*)::int` })
      .from(compileJobs)
      .innerJoin(projectMemberships, eq(projectMemberships.projectId, compileJobs.projectId))
      .where(
        and(
          eq(projectMemberships.userId, user.id),
          inArray(compileJobs.status, ['queued', 'running']),
        ),
      );
    if ((userActive?.count ?? 0) >= 2)
      throw conflict('Your compilation concurrency limit has been reached');

    const [active] = await context.db
      .select()
      .from(compileJobs)
      .where(
        and(
          eq(compileJobs.projectId, projectId),
          inArray(compileJobs.status, ['queued', 'running']),
        ),
      )
      .orderBy(desc(compileJobs.createdAt))
      .limit(1);
    if (active?.status === 'running' && input.trigger === 'auto')
      return reply.code(202).send({ job: serializeCompile(active), coalesced: true });
    if (active?.status === 'queued' && active.trigger === 'auto') {
      await context.queue.remove(active.id).catch(() => undefined);
      await context.db
        .update(compileJobs)
        .set({ status: 'cancelled', finishedAt: new Date() })
        .where(eq(compileJobs.id, active.id));
    } else if (active) {
      throw conflict('A compilation is already running for this project');
    }

    const checkpoint = await createCheckpoint(context.db, projectId, 'compile');
    const [job] = await context.db
      .insert(compileJobs)
      .values({
        projectId,
        checkpointId: checkpoint.id,
        sourceRevision: checkpoint.sourceRevision,
        engine: project.compiler,
        trigger: input.trigger,
      })
      .returning();
    await context.queue.add(
      'compile',
      { compileJobId: job!.id },
      {
        jobId: job!.id,
        attempts: 2,
        backoff: { type: 'fixed', delay: 1_000 },
        removeOnComplete: 500,
        removeOnFail: 500,
      },
    );
    return reply.code(202).send({ job: serializeCompile(job!) });
  });

  app.get('/api/v1/projects/:projectId/compilations', async (request) => {
    const user = await requireUser(context, request);
    const { projectId } = request.params as { projectId: string };
    await requireProject(context.db, user.id, projectId);
    const jobs = await context.db
      .select()
      .from(compileJobs)
      .where(eq(compileJobs.projectId, projectId))
      .orderBy(desc(compileJobs.createdAt))
      .limit(50);
    return { jobs: jobs.map(serializeCompile) };
  });

  app.get('/api/v1/projects/:projectId/compilations/:jobId', async (request) => {
    const user = await requireUser(context, request);
    const { projectId, jobId } = request.params as { projectId: string; jobId: string };
    await requireProject(context.db, user.id, projectId);
    const [job] = await context.db
      .select()
      .from(compileJobs)
      .where(and(eq(compileJobs.id, jobId), eq(compileJobs.projectId, projectId)))
      .limit(1);
    if (!job) throw notFound('Compilation not found');
    return { job: serializeCompile(job) };
  });

  app.delete('/api/v1/projects/:projectId/compilations/:jobId', async (request, reply) => {
    const user = await requireUser(context, request);
    const { projectId, jobId } = request.params as { projectId: string; jobId: string };
    await requireProject(context.db, user.id, projectId);
    const [job] = await context.db
      .select()
      .from(compileJobs)
      .where(and(eq(compileJobs.id, jobId), eq(compileJobs.projectId, projectId)))
      .limit(1);
    if (!job) throw notFound('Compilation not found');
    if (job.status === 'queued') await context.queue.remove(jobId).catch(() => undefined);
    await context.redis.set(`compile-cancel:${jobId}`, '1', 'EX', 120);
    await context.db
      .update(compileJobs)
      .set({ status: 'cancelled', finishedAt: new Date() })
      .where(eq(compileJobs.id, jobId));
    await context.redis.publish(
      `compile-events:${projectId}`,
      JSON.stringify({ type: 'status', job: { ...serializeCompile(job), status: 'cancelled' } }),
    );
    return reply.code(204).send();
  });

  app.get('/api/v1/projects/:projectId/compile-events', async (request, reply) => {
    const user = await requireUser(context, request);
    const { projectId } = request.params as { projectId: string };
    await requireProject(context.db, user.id, projectId);
    const subscriber = context.redis.duplicate();
    await subscriber.subscribe(`compile-events:${projectId}`);
    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    response.write(`event: ready\ndata: ${JSON.stringify({ projectId })}\n\n`);
    const heartbeat = setInterval(
      () =>
        response.write(
          `event: heartbeat\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`,
        ),
      15_000,
    );
    const cleanup = () => {
      clearInterval(heartbeat);
      void subscriber.quit();
    };
    request.raw.on('close', cleanup);
    subscriber.on('message', (_channel: string, message: string) =>
      response.write(`event: compile\ndata: ${message}\n\n`),
    );
  });

  app.get('/api/v1/projects/:projectId/compilations/:jobId/pdf', async (request, reply) => {
    const user = await requireUser(context, request);
    const { projectId, jobId } = request.params as { projectId: string; jobId: string };
    await requireProject(context.db, user.id, projectId);
    const job = await successfulJob(context, projectId, jobId);
    const object = await context.storage.getStream(job.pdfObjectKey!, request.headers.range);
    reply
      .header('accept-ranges', 'bytes')
      .header('content-type', 'application/pdf')
      .header('cache-control', 'private, max-age=31536000, immutable');
    if (object.etag) reply.header('etag', object.etag);
    if (object.contentRange) reply.code(206).header('content-range', object.contentRange);
    if (object.contentLength !== undefined) reply.header('content-length', object.contentLength);
    return reply.send(object.stream);
  });

  app.get('/api/v1/projects/:projectId/compilations/:jobId/download', async (request, reply) => {
    const { projectId, jobId } = request.params as { projectId: string; jobId: string };
    reply.header('content-disposition', `attachment; filename="${projectId.slice(0, 8)}.pdf"`);
    return app
      .inject({
        method: 'GET',
        url: `/api/v1/projects/${projectId}/compilations/${jobId}/pdf`,
        headers: request.headers as Record<string, string>,
      })
      .then((response) =>
        reply.code(response.statusCode).headers(response.headers).send(response.rawPayload),
      );
  });

  app.post('/api/v1/projects/:projectId/compilations/:jobId/synctex/forward', async (request) => {
    const user = await requireUser(context, request);
    const { projectId, jobId } = request.params as { projectId: string; jobId: string };
    const project = await requireProject(context.db, user.id, projectId);
    const parsed = forwardSyncRequestSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Invalid source selection', parsed.error.flatten());
    const syncStartedAt = Date.now();
    const input = parsed.data;
    const job = await successfulJob(context, projectId, jobId);
    const [checkpoint] = await context.db
      .select()
      .from(checkpoints)
      .where(eq(checkpoints.id, job.checkpointId));
    if (!checkpoint) throw notFound('Compilation checkpoint not found');
    const projectEntries = await context.db
      .select()
      .from(entries)
      .where(eq(entries.projectId, projectId));
    const currentPaths = buildEntryPaths(projectEntries);
    const currentEntry = projectEntries.find(
      (entry) =>
        normalizeSyncPath(currentPaths.get(entry.id) ?? null) === normalizeSyncPath(input.path),
    );
    const manifestEntry = checkpoint.manifest.find(
      (item) => item.entryId === currentEntry?.id || item.path === input.path,
    );
    if (!manifestEntry) throw notFound('Source file is not present in this compilation');
    const [compiledVersion] = manifestEntry
      ? await context.db
          .select({ version: fileVersions.version })
          .from(fileVersions)
          .where(eq(fileVersions.id, manifestEntry.versionId))
          .limit(1)
      : [];
    const sourceFileChangedSinceCompile = compiledVersion?.version !== input.entryVersion;
    const compiledSource = (await context.storage.getBuffer(manifestEntry.objectKey)).toString(
      'utf8',
    );
    const syncData = job.synctexObjectKey
      ? await context.storage.getBuffer(job.synctexObjectKey)
      : null;
    const syncInput = syncData
      ? findSyncTexInput(gunzipSync(syncData).toString('utf8'), manifestEntry.path)
      : manifestEntry.path;
    const currentSource = currentEntry
      ? (
          await context.storage.getBuffer(
            (await getFileWithBlob(context.db, projectId, currentEntry.id)).blob.objectKey,
          )
        ).toString('utf8')
      : compiledSource;
    const compiledSelection = sourceFileChangedSinceCompile
      ? alignSelectionToCompiled(currentSource, compiledSource, input.selection)
      : input.selection;
    const anchors = structuralSourceAnchors(compiledSource, compiledSelection);
    const results: PdfSyncResult[] = [];
    for (const anchor of anchors) {
      const hint = contentHint(anchor.text, anchor.before, anchor.after);
      const baseArgs = [
        'view',
        '-i',
        `${anchor.start.line}:${anchor.start.column}:${input.pageHint ?? 0}:${syncInput}`,
        '-o',
        'document.pdf',
      ];
      const hintedArgs = hint ? [...baseArgs, '-h', hint] : baseArgs;
      let records = parseSyncTexRecords(
        await querySyncTex(context, job, hintedArgs).catch(() => ''),
      );
      if (!records.length && hint)
        records = parseSyncTexRecords(await querySyncTex(context, job, baseArgs).catch(() => ''));
      const record = rankSyncRecords(records, {
        path: manifestEntry.path,
        line: anchor.start.line,
        ...(input.pageHint !== undefined ? { pageHint: input.pageHint } : {}),
        selectedText: anchor.text,
      })[0];
      if (record) {
        const mapped = recordToPdfResult(record, {
          artifactStale: job.sourceRevision < project.sourceRevision,
          sourceFileChangedSinceCompile,
          selectedText: input.selection.text,
          usedContext: Boolean(hint),
        });
        results.push({
          ...mapped,
          path: mapped.path ?? manifestEntry.path,
          line: mapped.line ?? anchor.start.line,
          column: mapped.column ?? anchor.start.column,
        });
      }
    }
    const result = unionSyncResults(results);
    if (!result) {
      incrementMetric('latex_synctex_requests_total', { outcome: 'no_match' });
      observeMetric('latex_synctex_mapping_milliseconds', Date.now() - syncStartedAt, {
        outcome: 'no_match',
      });
      throw notFound('No SyncTeX location found');
    }
    incrementMetric('latex_synctex_requests_total', {
      outcome: 'matched',
      confidence: result.confidence,
    });
    observeMetric('latex_synctex_mapping_milliseconds', Date.now() - syncStartedAt, {
      outcome: 'matched',
    });
    return result;
  });

  app.post('/api/v1/projects/:projectId/compilations/:jobId/synctex/inverse', async (request) => {
    const user = await requireUser(context, request);
    const { projectId, jobId } = request.params as { projectId: string; jobId: string };
    await requireProject(context.db, user.id, projectId);
    const parsed = inverseSyncRequestSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Invalid PDF position', parsed.error.flatten());
    const input = parsed.data;
    const job = await successfulJob(context, projectId, jobId);
    const output = await querySyncTex(context, job, [
      'edit',
      '-o',
      `${input.page}:${input.x}:${input.y}:document.pdf`,
    ]);
    const record = parseSyncTexRecords(output)[0];
    const path = record ? normalizeSyncPath(record.input) : null;
    if (!record || !path || !record.line) throw notFound('No SyncTeX location found');
    return { path, line: record.line, column: record.column };
  });
}

async function successfulJob(context: AppContext, projectId: string, jobId: string) {
  const [job] = await context.db
    .select()
    .from(compileJobs)
    .where(
      and(
        eq(compileJobs.id, jobId),
        eq(compileJobs.projectId, projectId),
        eq(compileJobs.status, 'succeeded'),
      ),
    )
    .limit(1);
  if (!job?.pdfObjectKey) throw notFound('Compiled PDF not found');
  return job;
}

async function querySyncTex(
  context: AppContext,
  job: typeof compileJobs.$inferSelect,
  args: string[],
) {
  if (!job.synctexObjectKey) throw notFound('SyncTeX data not found');
  const folder = await mkdtemp(join(tmpdir(), 'latex-synctex-'));
  try {
    await Promise.all([
      context.storage
        .getBuffer(job.pdfObjectKey!)
        .then((data) => writeFile(join(folder, 'document.pdf'), data)),
      context.storage
        .getBuffer(job.synctexObjectKey!)
        .then((data) => writeFile(join(folder, 'document.synctex.gz'), data)),
    ]);
    const [checkpoint] = await context.db
      .select()
      .from(checkpoints)
      .where(eq(checkpoints.id, job.checkpointId));
    for (const item of checkpoint?.manifest ?? []) {
      const target = join(folder, item.path);
      await import('node:fs/promises').then(async (fs) => {
        await fs.mkdir(join(target, '..'), { recursive: true });
        await fs.writeFile(target, '');
      });
    }
    const result = await exec('synctex', args, { cwd: folder, timeout: 5_000 });
    return result.stdout;
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
