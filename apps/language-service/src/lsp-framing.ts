const HEADER_SEPARATOR = Buffer.from('\r\n\r\n');

export const MAX_LSP_HEADER_BYTES = 8 * 1024;
export const MAX_LSP_MESSAGE_BYTES = 8 * 1024 * 1024;

export class LspFrameError extends Error {
  override readonly name = 'LspFrameError';
}

/**
 * Incrementally decodes Language Server Protocol messages from a byte stream.
 *
 * The decoder rejects malformed and oversized frames before retaining an
 * unbounded buffer. Callers should terminate the offending child process when
 * this throws because stream synchronization can no longer be guaranteed.
 */
export class LspFrameDecoder {
  private buffered = Buffer.alloc(0);

  constructor(
    private readonly maxMessageBytes = MAX_LSP_MESSAGE_BYTES,
    private readonly maxHeaderBytes = MAX_LSP_HEADER_BYTES,
  ) {}

  push(chunk: Uint8Array): string[] {
    if (chunk.byteLength === 0) return [];
    this.buffered = Buffer.concat([this.buffered, chunk]);
    const messages: string[] = [];

    while (this.buffered.byteLength > 0) {
      const boundary = this.buffered.indexOf(HEADER_SEPARATOR);
      if (boundary < 0) {
        if (this.buffered.byteLength > this.maxHeaderBytes) {
          throw new LspFrameError('LSP header exceeds the configured limit');
        }
        break;
      }
      if (boundary > this.maxHeaderBytes) {
        throw new LspFrameError('LSP header exceeds the configured limit');
      }

      const header = this.buffered.subarray(0, boundary).toString('ascii');
      const lengths = header
        .split('\r\n')
        .map((line) => line.match(/^Content-Length:\s*(\d+)\s*$/i)?.[1])
        .filter((value): value is string => value !== undefined);
      if (lengths.length !== 1) {
        throw new LspFrameError('LSP frame must contain exactly one Content-Length header');
      }

      const length = Number(lengths[0]);
      if (!Number.isSafeInteger(length) || length < 0 || length > this.maxMessageBytes) {
        throw new LspFrameError('LSP message exceeds the configured limit');
      }

      const frameEnd = boundary + HEADER_SEPARATOR.byteLength + length;
      if (this.buffered.byteLength < frameEnd) break;
      messages.push(
        this.buffered.subarray(boundary + HEADER_SEPARATOR.byteLength, frameEnd).toString('utf8'),
      );
      this.buffered = this.buffered.subarray(frameEnd);
    }

    return messages;
  }
}
