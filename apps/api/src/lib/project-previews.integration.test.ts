import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { Job } from 'bullmq';
import { loadConfig } from '@latex-workshop/config';
import {
  checkpoints,
  compileJobs,
  entries,
  projectMemberships,
  projects,
  users,
} from '@latex-workshop/db';
import { createContext, type AppContext } from './context.js';
import { runMaintenance } from './maintenance.js';
import { queueTemplatePreview } from './template-previews.js';
import { requestProjectCompilation } from './project-compiles.js';
import {
  missingPreviewCandidates,
  PREVIEW_RETRY_MS,
  queueMissingProjectPreview,
  retainedPreviewJobs,
} from './project-previews.js';

// Run against a migrated disposable database named preview_regression_*.
const databaseUrl = process.env.PREVIEW_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('Library preview maintenance (PostgreSQL)', () => {
  let context: AppContext;
  const now = Date.now();
  const old = new Date(now - 40 * 24 * 60 * 60 * 1_000);
  const idle = new Date(now - 120_000);

  beforeAll(() => {
    if (!databaseUrl || !new URL(databaseUrl).pathname.startsWith('/preview_regression_'))
      throw new Error(
        'Preview integration tests require a disposable preview_regression_* database',
      );
    context = createContext({
      ...loadConfig(),
      DATABASE_URL: databaseUrl,
      REDIS_URL: 'redis://127.0.0.1:6379/15',
    });
    vi.spyOn(context.queue, 'add').mockImplementation(
      async (name, data, options) => new Job(context.queue, name, data, options),
    );
    vi.spyOn(context.storage, 'deletePrefix').mockResolvedValue(undefined);
    vi.spyOn(context.storage, 'delete').mockResolvedValue({ $metadata: {} });
  });
  beforeEach(async () => {
    await context.client.unsafe('truncate table users, projects cascade');
    vi.clearAllMocks();
    await context.redis.del('latex-workshop:maintenance-lock');
  });
  afterAll(async () => {
    await Promise.all([context.queue.close(), context.pdfRenderQueue.close()]);
    await context.redis.quit();
    await context.client.end();
    vi.restoreAllMocks();
  });

  async function project(
    options: {
      isTemplate?: boolean;
      trashedAt?: Date;
      size?: number;
      role?: string;
      updatedAt?: Date;
    } = {},
  ) {
    const userId = randomUUID();
    const projectId = randomUUID();
    const mainFileId = randomUUID();
    await context.db
      .insert(users)
      .values({ id: userId, name: 'Preview test', email: `${userId}@example.test` });
    await context.db.insert(projects).values({
      id: projectId,
      name: 'Preview test',
      mainFileId,
      updatedAt: options.updatedAt ?? idle,
      isTemplate: options.isTemplate ?? false,
      trashedAt: options.trashedAt ?? null,
    });
    await context.db
      .insert(projectMemberships)
      .values({ projectId, userId, role: options.role ?? 'owner' });
    await context.db.insert(entries).values({
      id: mainFileId,
      projectId,
      name: 'main.tex',
      kind: 'file',
      size: options.size ?? 20,
    });
    return { projectId, userId };
  }
  async function compile(
    projectId: string,
    options: {
      status?: 'succeeded' | 'failed' | 'running';
      target?: 'accepted' | 'proposal';
      createdAt?: Date;
      sourceRevision?: number;
      pdf?: boolean;
    } = {},
  ) {
    const [checkpoint] = await context.db
      .insert(checkpoints)
      .values({
        projectId,
        reason: 'compile',
        sourceRevision: options.sourceRevision ?? 0,
        manifest: [],
        createdAt: options.createdAt ?? old,
      })
      .returning();
    if (!checkpoint) throw new Error('Missing test checkpoint');
    const id = randomUUID();
    await context.db.insert(compileJobs).values({
      id,
      projectId,
      checkpointId: checkpoint.id,
      sourceRevision: options.sourceRevision ?? 0,
      engine: 'pdflatex',
      trigger: 'auto',
      target: options.target ?? 'accepted',
      status: options.status ?? 'succeeded',
      pdfObjectKey: options.pdf === false ? null : `artifacts/${projectId}/${id}/document.pdf`,
      createdAt: options.createdAt ?? old,
    });
    return id;
  }

  it('retains the last accepted PDF despite newer failed and proposal builds', async () => {
    const { projectId } = await project();
    const previous = await compile(projectId, { createdAt: new Date(old.getTime() - 1_000) });
    const retained = await compile(projectId);
    const failed = await compile(projectId, {
      status: 'failed',
      pdf: false,
      createdAt: new Date(old.getTime() + 1_000),
    });
    const proposal = await compile(projectId, {
      target: 'proposal',
      createdAt: new Date(old.getTime() + 2_000),
    });
    expect(await retainedPreviewJobs(context.db)).toEqual([{ id: retained }]);
    await runMaintenance(context);
    expect((await context.db.select().from(compileJobs)).map((job) => job.id)).toEqual([retained]);
    for (const id of [previous, failed, proposal])
      expect(context.storage.deletePrefix).toHaveBeenCalledWith(`artifacts/${projectId}/${id}/`);
    expect(context.storage.deletePrefix).not.toHaveBeenCalledWith(
      `artifacts/${projectId}/${retained}/`,
    );
    expect(context.queue.add).not.toHaveBeenCalled();
  });

  it('backfills ordinary documents with auto compile off and templates, skipping unsafe candidates', async () => {
    const ordinary = await project();
    const template = await project({ isTemplate: true });
    await project({ trashedAt: new Date() });
    await project({ size: 0 });
    await project({ role: 'viewer' });
    await project({ updatedAt: new Date() });
    const proposalOnly = await project();
    await compile(proposalOnly.projectId, { target: 'proposal' });
    expect(
      new Set((await missingPreviewCandidates(context.db, now)).map((item) => item.projectId)),
    ).toEqual(new Set([ordinary.projectId, template.projectId, proposalOnly.projectId]));
    await queueMissingProjectPreview(context, now);
    expect(context.queue.add).toHaveBeenCalledTimes(1);
    expect(context.queue.add).toHaveBeenCalledWith(
      'compile',
      expect.objectContaining({ compileJobId: expect.any(String) }),
      expect.objectContaining({ priority: 10 }),
    );
    await queueMissingProjectPreview(context, now);
    expect(context.queue.add).toHaveBeenCalledTimes(1);
  });

  it('cools down failing source and retries after edits or a day', async () => {
    const candidate = await project();
    await compile(candidate.projectId, {
      status: 'failed',
      pdf: false,
      createdAt: new Date(now - 1_000),
    });
    expect(await missingPreviewCandidates(context.db, now)).toEqual([]);
    expect(await missingPreviewCandidates(context.db, now + PREVIEW_RETRY_MS)).toEqual([candidate]);
    await context.db
      .update(projects)
      .set({ sourceRevision: 1 })
      .where(eq(projects.id, candidate.projectId));
    expect(await missingPreviewCandidates(context.db, now)).toEqual([candidate]);
  });

  it('yields to existing foreground work', async () => {
    await project();
    const busy = await project();
    await compile(busy.projectId, { status: 'running', pdf: false });
    await queueMissingProjectPreview(context, now);
    expect(context.queue.add).not.toHaveBeenCalled();
  });

  it('serializes concurrent requests and leaves one immutable build', async () => {
    const candidate = await project();
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        requestProjectCompilation(
          context,
          candidate.userId,
          candidate.projectId,
          { trigger: 'auto' },
          undefined,
          { backgroundPreview: true },
        ),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await context.db.select().from(compileJobs)).toHaveLength(1);
    expect(context.queue.add).toHaveBeenCalledTimes(1);
  });

  it('marks queue failures terminal so a missing preview can retry later', async () => {
    const candidate = await project();
    vi.mocked(context.queue.add).mockRejectedValueOnce(new Error('Redis unavailable'));
    await expect(
      requestProjectCompilation(
        context,
        candidate.userId,
        candidate.projectId,
        { trigger: 'auto' },
        undefined,
        { backgroundPreview: true },
      ),
    ).rejects.toThrow('Redis unavailable');
    expect((await context.db.select().from(compileJobs))[0]?.status).toBe('failed');
  });
  it('marks template queue failures terminal instead of leaving a permanently queued preview', async () => {
    const candidate = await project({ isTemplate: true });
    vi.mocked(context.queue.add).mockRejectedValueOnce(new Error('Redis unavailable'));
    await expect(queueTemplatePreview(context, candidate.projectId)).rejects.toThrow(
      'Redis unavailable',
    );
    expect((await context.db.select().from(compileJobs))[0]?.status).toBe('failed');
  });
});
