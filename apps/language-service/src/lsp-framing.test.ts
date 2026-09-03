import { describe, expect, it } from 'vitest';
import { LspFrameDecoder, LspFrameError } from './lsp-framing.js';

function frame(body: string): Buffer {
  return Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

describe('LspFrameDecoder', () => {
  it('decodes concatenated UTF-8 messages at every byte boundary', () => {
    const bodies = ['{"id":1}', '{"message":"λ文🧪"}', ''];
    const bytes = Buffer.concat(bodies.map(frame));

    for (let split = 0; split <= bytes.byteLength; split += 1) {
      const decoder = new LspFrameDecoder();
      expect([
        ...decoder.push(bytes.subarray(0, split)),
        ...decoder.push(bytes.subarray(split)),
      ]).toEqual(bodies);
    }
  });

  it.each([
    'Missing: 1\r\n\r\n',
    'Content-Length: 1\r\nContent-Length: 1\r\n\r\na',
    'Content-Length: nope\r\n\r\n',
  ])('rejects malformed framing: %j', (input) => {
    expect(() => new LspFrameDecoder().push(Buffer.from(input))).toThrow(LspFrameError);
  });

  it('rejects oversized headers and bodies before buffering their payloads', () => {
    expect(() => new LspFrameDecoder(10, 8).push(Buffer.from('123456789'))).toThrow(
      'header exceeds',
    );
    expect(() => new LspFrameDecoder(10).push(Buffer.from('Content-Length: 11\r\n\r\n'))).toThrow(
      'message exceeds',
    );
  });

  it('survives deterministic fuzzed chunk boundaries without losing frames', () => {
    let state = 0x5eed1234;
    const random = () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state;
    };

    for (let run = 0; run < 500; run += 1) {
      const bodies = Array.from({ length: 1 + (random() % 8) }, (_, index) =>
        JSON.stringify({ run, index, value: `${random()}-λ-${random()}` }),
      );
      const bytes = Buffer.concat(bodies.map(frame));
      const decoder = new LspFrameDecoder();
      const decoded: string[] = [];
      for (let offset = 0; offset < bytes.byteLength; ) {
        const size = 1 + (random() % 31);
        decoded.push(...decoder.push(bytes.subarray(offset, offset + size)));
        offset += size;
      }
      expect(decoded).toEqual(bodies);
    }
  });
});
