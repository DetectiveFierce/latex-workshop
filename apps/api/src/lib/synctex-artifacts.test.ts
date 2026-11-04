import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { SyncArtifactCache } from './synctex-artifacts.js';

const artifact = gzipSync(
  'SyncTeX Version:1\nInput:1:/workspace/main.tex\nContent:\n{1\n}1\nPostamble:',
);
describe('immutable SyncTeX artifact cache', () => {
  it('deduplicates concurrent reads and retains a bounded preamble', async () => {
    const cache = new SyncArtifactCache();
    const load = vi.fn(async () => artifact);
    const [first, second] = await Promise.all([
      cache.get('tenant/project/build', load),
      cache.get('tenant/project/build', load),
    ]);
    expect(first).toBe(second);
    expect(first.preamble).toContain('Input:1:/workspace/main.tex');
    expect(await cache.get('tenant/project/build', load)).toBe(first);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('separates immutable builds and evicts old entries', async () => {
    const cache = new SyncArtifactCache();
    const load = vi.fn(async () => artifact);
    for (let index = 0; index < 10; index += 1) await cache.get(`build-${index}`, load);
    await cache.get('build-9', load);
    expect(load).toHaveBeenCalledTimes(10);
    await cache.get('build-0', load);
    expect(load).toHaveBeenCalledTimes(11);
  });

  it('does not retain failed reads', async () => {
    const cache = new SyncArtifactCache();
    await expect(
      cache.get('build', async () => {
        throw new Error('Unavailable');
      }),
    ).rejects.toThrow('Unavailable');
    expect((await cache.get('build', async () => artifact)).data).toBe(artifact);
  });

  it('rejects oversized compressed artifacts and invalid preambles', async () => {
    const cache = new SyncArtifactCache();
    await expect(cache.get('huge', async () => Buffer.alloc(16 * 1024 * 1024 + 1))).rejects.toThrow(
      'too large',
    );
    await expect(cache.get('bad', async () => gzipSync('not SyncTeX'))).rejects.toThrow('preamble');
  });
  it('clears one project while retaining other project artifacts', async () => {
    const cache = new SyncArtifactCache();
    const first = '00000000-0000-4000-8000-000000000001';
    const other = '00000000-0000-4000-8000-000000000002';
    const load = vi.fn(async () => artifact);
    const key = (id: string) => `artifacts/${id}/job/document.synctex.gz`;
    const a = await cache.get(key(first), load);
    const b = await cache.get(key(other), load);
    expect(cache.clearProject(first)).toEqual({ clearedEntries: 1, invalidatedInFlight: 0 });
    expect(await cache.get(key(other), load)).toBe(b);
    expect(await cache.get(key(first), load)).not.toBe(a);
    expect(load).toHaveBeenCalledTimes(3);
    expect(() => cache.clearProject('')).toThrow();
  });

  it('does not let in-flight reads repopulate a cleared project cache', async () => {
    const cache = new SyncArtifactCache();
    const id = '00000000-0000-4000-8000-000000000001';
    let resolveLoad: (value: Buffer) => void = () => {
      throw new Error('load not started');
    };
    const load = vi.fn(
      () =>
        new Promise<Buffer>((resolve) => {
          resolveLoad = resolve;
        }),
    );
    const key = `artifacts/${id}/job/document.synctex.gz`;
    const read = cache.get(key, load);
    expect(cache.clearProject(id)).toEqual({ clearedEntries: 0, invalidatedInFlight: 1 });
    const concurrent = cache.get(key, load);
    resolveLoad(artifact);
    expect(await concurrent).toBe(await read);
    const reload = vi.fn(async () => artifact);
    await cache.get(key, reload);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
