import { clear, createStore, del, entries, get, set } from 'idb-keyval';

/** One rendered first page per project. Replaced only when a newer compile exists. */
export type CachedThumbnail = { jobId: string; blob: Blob; width: number; savedAt: number };
export type VisibleThumbnail = { jobId: string; url: string; width: number };

const MAX_ENTRIES = 400;
const store = () => createStore('latex-workshop-thumbnails', 'thumbnails');
/** Object URLs stay valid across route changes, so returning to the library paints immediately. */
const memory = new Map<string, VisibleThumbnail>();

function parseThumbnail(value: unknown): CachedThumbnail | null {
  if (typeof value !== 'object' || value === null) return null;
  const { jobId, blob, width, savedAt } = value as Record<string, unknown>;
  return typeof jobId === 'string' &&
    blob instanceof Blob &&
    typeof width === 'number' &&
    typeof savedAt === 'number'
    ? { jobId, blob, width, savedAt }
    : null;
}

function remember(projectId: string, thumbnail: Pick<CachedThumbnail, 'jobId' | 'blob' | 'width'>) {
  const previous = memory.get(projectId);
  const visible = {
    jobId: thumbnail.jobId,
    url: URL.createObjectURL(thumbnail.blob),
    width: thumbnail.width,
  };
  memory.set(projectId, visible);
  if (previous) URL.revokeObjectURL(previous.url);
  return visible;
}

export function peekThumbnail(projectId: string): VisibleThumbnail | null {
  return memory.get(projectId) ?? null;
}

/** Browsers without usable IndexedDB simply render again, so storage failures stay quiet. */
export async function loadThumbnail(projectId: string): Promise<VisibleThumbnail | null> {
  const known = memory.get(projectId);
  if (known) return known;
  try {
    const cached = parseThumbnail(await get(projectId, store()));
    if (!cached) return null;
    return memory.get(projectId) ?? remember(projectId, cached);
  } catch {
    return null;
  }
}

async function evictOldest() {
  const all = await entries<string, unknown>(store());
  if (all.length <= MAX_ENTRIES) return;
  const oldest = all
    .map(([key, value]) => ({ key, savedAt: parseThumbnail(value)?.savedAt ?? 0 }))
    .sort((left, right) => left.savedAt - right.savedAt)
    .slice(0, all.length - MAX_ENTRIES);
  await Promise.all(oldest.map(({ key }) => del(key, store())));
}

export async function saveThumbnail(
  projectId: string,
  jobId: string,
  blob: Blob,
  width: number,
): Promise<VisibleThumbnail> {
  const visible = remember(projectId, { jobId, blob, width });
  try {
    await set(projectId, { jobId, blob, width, savedAt: Date.now() }, store());
    await evictOldest();
  } catch {
    // The in-memory copy still serves this session.
  }
  return visible;
}

/** A shared browser must not keep one account's previews after it signs out. */
export async function clearThumbnails(): Promise<void> {
  for (const { url } of memory.values()) URL.revokeObjectURL(url);
  memory.clear();
  try {
    await clear(store());
  } catch {
    // Nothing further to clear.
  }
}
