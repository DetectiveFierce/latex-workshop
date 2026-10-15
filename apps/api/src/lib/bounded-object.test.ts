import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { readBoundedObject } from './bounded-object.js';

describe('synchronization object reads', () => {
  const storage = (stream: Readable, contentLength?: number) => ({
    getStream: async () => ({
      stream,
      contentLength,
      contentRange: undefined,
      contentType: undefined,
      etag: undefined,
    }),
  });
  it('enforces the actual streamed size even when metadata understates it', async () => {
    const stream = Readable.from([Buffer.from('first'), Buffer.from('second')]);
    await expect(readBoundedObject(storage(stream, 1), 'source', 8)).rejects.toThrow('too large');
    expect(stream.destroyed).toBe(true);
  });

  it('rejects an oversized declared length and closes the stream', async () => {
    const stream = Readable.from([Buffer.from('text')]);
    await expect(readBoundedObject(storage(stream, 500), 'source', 8)).rejects.toThrow('too large');
    expect(stream.destroyed).toBe(true);
  });

  it('reads a valid immutable artifact once', async () => {
    expect(
      (
        await readBoundedObject(storage(Readable.from([Buffer.from('text')])), 'source', 8)
      ).toString(),
    ).toBe('text');
  });
});
