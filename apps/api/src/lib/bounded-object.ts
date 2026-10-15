import type { ObjectStorage } from '@latex-workshop/storage';
import { badRequest } from './errors.js';

export async function readBoundedObject(
  storage: Pick<ObjectStorage, 'getStream'>,
  key: string,
  maximumBytes: number,
): Promise<Buffer> {
  const result = await storage.getStream(key);
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    if (result.contentLength !== undefined && result.contentLength > maximumBytes)
      throw badRequest('Synchronization data is too large');
    for await (const chunk of result.stream) {
      if (!Buffer.isBuffer(chunk)) throw badRequest('Invalid synchronization data');
      bytes += chunk.length;
      if (bytes > maximumBytes) throw badRequest('Synchronization data is too large');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, bytes);
  } finally {
    result.stream.destroy();
  }
}
