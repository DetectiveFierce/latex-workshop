import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { endSessionOnServerFailure } from './server-process.js';

describe('endSessionOnServerFailure', () => {
  it('ends the session on a broken pipe instead of throwing', () => {
    const stdin = new EventEmitter();
    const endSession = vi.fn();
    endSessionOnServerFailure(new EventEmitter(), stdin, endSession);
    const brokenPipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    expect(() => stdin.emit('error', brokenPipe)).not.toThrow();
    expect(endSession).toHaveBeenCalledTimes(1);
  });

  it('ends the session when the server cannot start', () => {
    const server = new EventEmitter();
    const endSession = vi.fn();
    endSessionOnServerFailure(server, new EventEmitter(), endSession);
    const missing = Object.assign(new Error('spawn texlab ENOENT'), { code: 'ENOENT' });
    expect(() => server.emit('error', missing)).not.toThrow();
    expect(endSession).toHaveBeenCalledTimes(1);
  });
});
