import { and, eq } from 'drizzle-orm';
import { checkpoints, entries } from '@latex-workshop/db';
import type { compileJobs, projects } from '@latex-workshop/db';
import type { InverseSyncRequest, InverseSyncResult } from '@latex-workshop/contracts';
import { checkpointManifestSchema } from '@latex-workshop/contracts';
import type { AppContext } from './context.js';
import { buildEntryPaths, getFileWithBlob } from './domain.js';
import { notFound } from './errors.js';
import { readBoundedObject } from './bounded-object.js';
import { alignSelectionToCompiled } from './synctex.js';
import {
  parseInverseSyncRecords,
  resolveInversePath,
  sourceSelectionForPdf,
} from './inverse-sync.js';

export async function findInverseSource(
  context: AppContext,
  project: typeof projects.$inferSelect,
  job: typeof compileJobs.$inferSelect,
  input: InverseSyncRequest,
  query: (args: string[]) => Promise<string>,
): Promise<InverseSyncResult> {
  const [checkpoint] = await context.db
    .select()
    .from(checkpoints)
    .where(and(eq(checkpoints.id, job.checkpointId), eq(checkpoints.projectId, job.projectId)));
  if (!checkpoint) throw notFound('Compilation checkpoint not found');
  const manifest = checkpointManifestSchema.safeParse(checkpoint.manifest);
  if (!manifest.success) throw notFound('Compilation source snapshot is unavailable');
  const projectEntries = await context.db
    .select()
    .from(entries)
    .where(eq(entries.projectId, job.projectId));
  const paths = buildEntryPaths(projectEntries);
  const sourceCache = new Map<
    string,
    Promise<{ compiled: string; current: string; path: string; entryId: string | null }>
  >();
  let fallback: InverseSyncResult | null = null;
  const points = [{ page: input.page, x: input.x, y: input.y }, ...(input.points ?? [])];
  for (const point of points.slice(0, 6)) {
    const output = await query(['edit', '-o', `${point.page}:${point.x}:${point.y}:document.pdf`]);
    for (const record of parseInverseSyncRecords(output).slice(0, 8)) {
      const file = resolveInversePath(record.input, manifest.data);
      if (!file || !/\.(?:tex|sty|cls|bib)$/i.test(file.path)) continue;
      let source = sourceCache.get(file.path);
      if (!source) {
        if (sourceCache.size >= 4 || file.size > 8 * 1024 * 1024) continue;
        source = (async () => {
          const compiled = (
            await readBoundedObject(context.storage, file.objectKey, 8 * 1024 * 1024)
          ).toString('utf8');
          const currentEntry = projectEntries.find((entry) => entry.id === file.entryId);
          const current =
            currentEntry &&
            job.target === 'accepted' &&
            currentEntry.currentVersionId !== file.versionId
              ? (
                  await readBoundedObject(
                    context.storage,
                    (await getFileWithBlob(context.db, job.projectId, currentEntry.id)).blob
                      .objectKey,
                    8 * 1024 * 1024,
                  )
                ).toString('utf8')
              : compiled;
          return {
            compiled,
            current,
            path: paths.get(file.entryId) ?? file.path,
            entryId: file.entryId,
          };
        })();
        sourceCache.set(file.path, source);
      }
      const content = await source;
      const mapped = sourceSelectionForPdf(
        content.compiled,
        record.line,
        input.text,
        input.before,
        input.after,
      );
      const changed = content.current !== content.compiled;
      const selection = changed
        ? alignSelectionToCompiled(content.compiled, content.current, mapped.selection)
        : mapped.selection;
      const result: InverseSyncResult = {
        path: job.target === 'proposal' ? file.path : content.path,
        entryId: content.entryId,
        line: selection.start.line,
        column: selection.start.column,
        selection,
        confidence: changed ? 'approximate' : mapped.matched ? 'context' : 'exact',
        artifactStale: job.target === 'accepted' && job.sourceRevision < project.sourceRevision,
      };
      if (mapped.matched || !input.text?.trim()) return result;
      fallback ??= result;
    }
  }
  if (!fallback) throw notFound('No project source location found for this PDF selection');
  return fallback;
}
