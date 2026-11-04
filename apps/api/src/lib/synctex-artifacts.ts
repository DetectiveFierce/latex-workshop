import { gunzipSync } from 'node:zlib';
import { idSchema } from '@latex-workshop/contracts';
import type { ObjectStorage } from '@latex-workshop/storage';
import { badRequest, HttpError } from './errors.js';
import { readBoundedObject } from './bounded-object.js';

const MAX_COMPRESSED_BYTES = 16 * 1024 * 1024;
const MAX_INFLATED_BYTES = 128 * 1024 * 1024;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
type SyncArtifact = { data: Buffer; preamble: string };

export class SyncArtifactCache {
  private entries = new Map<string, SyncArtifact>();
  private pending = new Map<
    string,
    { task: Promise<SyncArtifact>; state: { cacheable: boolean } }
  >();
  private bytes = 0;

  clearProject(projectId: string) {
    const prefix = `artifacts/${idSchema.parse(projectId)}/`;
    let clearedEntries = 0;
    let invalidatedInFlight = 0;
    for (const [key, value] of this.entries) {
      if (!key.startsWith(prefix)) continue;
      this.entries.delete(key);
      this.bytes -= value.data.length + Buffer.byteLength(value.preamble);
      clearedEntries += 1;
    }
    // Keep reads registered until they finish so clearing cannot bypass the concurrency
    // bound. Existing callers can finish, but those reads may not refill the cache.
    for (const [key, { state }] of this.pending) {
      if (!key.startsWith(prefix) || !state.cacheable) continue;
      state.cacheable = false;
      invalidatedInFlight += 1;
    }
    return { clearedEntries, invalidatedInFlight };
  }

  async get(key: string, load: () => Promise<Buffer>): Promise<SyncArtifact> {
    const cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached;
    }
    const pending = this.pending.get(key);
    if (pending) return pending.task;
    if (this.pending.size >= 4)
      throw new HttpError(429, 'SYNC_BUSY', 'Source lookup is busy. Try the selection again.');
    const state = { cacheable: true };
    const task: Promise<SyncArtifact> = (async () => {
      const data = await load();
      if (data.length > MAX_COMPRESSED_BYTES) throw badRequest('SyncTeX data is too large');
      let inflated: Buffer;
      try {
        inflated = gunzipSync(data, { maxOutputLength: MAX_INFLATED_BYTES });
      } catch {
        throw badRequest('Invalid or oversized SyncTeX data');
      }
      const prefix = inflated.subarray(0, 1024 * 1024).toString('utf8');
      const end = prefix.indexOf('\nContent:');
      if (end < 0) throw badRequest('SyncTeX preamble is missing or too large');
      const value = { data, preamble: prefix.slice(0, end) };
      const size = data.length + Buffer.byteLength(value.preamble);
      if (!state.cacheable) return value;
      while (this.entries.size >= 8 || this.bytes + size > MAX_CACHE_BYTES) {
        const oldest = this.entries.entries().next().value;
        if (!oldest) break;
        this.entries.delete(oldest[0]);
        this.bytes -= oldest[1].data.length + Buffer.byteLength(oldest[1].preamble);
      }
      this.entries.set(key, value);
      this.bytes += size;
      return value;
    })();
    this.pending.set(key, { task, state });
    try {
      return await task;
    } finally {
      this.pending.delete(key);
    }
  }
}

const caches = new WeakMap<ObjectStorage, SyncArtifactCache>();

export async function getSyncArtifact(storage: ObjectStorage, objectKey: string) {
  let cache = caches.get(storage);
  if (!cache) {
    cache = new SyncArtifactCache();
    caches.set(storage, cache);
  }
  return cache.get(objectKey, () => readBoundedObject(storage, objectKey, MAX_COMPRESSED_BYTES));
}

/** Evicts only disposable build metadata; immutable artifacts and history remain intact. */
export function clearProjectSyncArtifacts(storage: ObjectStorage, projectId: string) {
  idSchema.parse(projectId);
  return (
    caches.get(storage)?.clearProject(projectId) ?? { clearedEntries: 0, invalidatedInFlight: 0 }
  );
}
