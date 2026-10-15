import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, notExists } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { compileJobs, entries, projectMemberships, projects } from '@latex-workshop/db';
import type { Database } from '@latex-workshop/db';
import type { AppContext } from './context.js';
import { HttpError } from './errors.js';
import { requestProjectCompilation } from './project-compiles.js';

export const PREVIEW_RETRY_MS = 24 * 60 * 60 * 1_000;
export const PREVIEW_IDLE_MS = 60_000;

export function retainedPreviewJobs(db: Database) {
  return db
    .selectDistinctOn([compileJobs.projectId], { id: compileJobs.id })
    .from(compileJobs)
    .where(
      and(
        eq(compileJobs.target, 'accepted'),
        eq(compileJobs.status, 'succeeded'),
        isNotNull(compileJobs.pdfObjectKey),
      ),
    )
    .orderBy(compileJobs.projectId, desc(compileJobs.createdAt), desc(compileJobs.id));
}

export function missingPreviewCandidates(db: Database, now: number) {
  const previous = alias(compileJobs, 'previous_preview_compile');
  return db
    .select({ projectId: projects.id, userId: projectMemberships.userId })
    .from(projects)
    .innerJoin(projectMemberships, eq(projectMemberships.projectId, projects.id))
    .innerJoin(
      entries,
      and(eq(entries.id, projects.mainFileId), eq(entries.projectId, projects.id)),
    )
    .where(
      and(
        eq(projectMemberships.role, 'owner'),
        isNull(projects.trashedAt),
        gt(entries.size, 0),
        lt(projects.updatedAt, new Date(now - PREVIEW_IDLE_MS)),
        notExists(
          db
            .select({ id: previous.id })
            .from(previous)
            .where(
              and(
                eq(previous.projectId, projects.id),
                eq(previous.target, 'accepted'),
                eq(previous.status, 'succeeded'),
                isNotNull(previous.pdfObjectKey),
              ),
            ),
        ),
        notExists(
          db
            .select({ id: previous.id })
            .from(previous)
            .where(
              and(
                eq(previous.projectId, projects.id),
                inArray(previous.status, ['queued', 'running']),
              ),
            ),
        ),
        notExists(
          db
            .select({ id: previous.id })
            .from(previous)
            .where(
              and(
                eq(previous.projectId, projects.id),
                eq(previous.target, 'accepted'),
                eq(previous.sourceRevision, projects.sourceRevision),
                eq(previous.engine, projects.compiler),
                gt(previous.createdAt, new Date(now - PREVIEW_RETRY_MS)),
              ),
            ),
        ),
      ),
    )
    .orderBy(desc(projects.updatedAt), asc(projects.id))
    .limit(20);
}

export async function queueMissingProjectPreview(context: AppContext, now = Date.now()) {
  // Add at most one build per maintenance pass and leave the worker's other slot available.
  const [active] = await context.db
    .select({ id: compileJobs.id })
    .from(compileJobs)
    .where(inArray(compileJobs.status, ['queued', 'running']))
    .limit(1);
  if (active) return;
  for (const candidate of await missingPreviewCandidates(context.db, now)) {
    try {
      await requestProjectCompilation(
        context,
        candidate.userId,
        candidate.projectId,
        { trigger: 'auto' },
        undefined,
        { backgroundPreview: true },
      );
      return;
    } catch (error) {
      if (!(error instanceof HttpError && [400, 404, 409].includes(error.statusCode))) throw error;
    }
  }
}
