import { describe, expect, it } from 'vitest';
import {
  createFrozenHunks,
  diffLineHunks,
  lineCount,
  projectAcceptedHunks,
  splitLines,
} from './proposal-hunks.js';

describe('proposal line hunks', () => {
  it('splits lines while preserving trailing newlines', () => {
    expect(splitLines('alpha\nbeta\n')).toEqual(['alpha\n', 'beta\n']);
    expect(splitLines('alpha\nbeta')).toEqual(['alpha\n', 'beta']);
    expect(splitLines('')).toEqual([]);
    expect(lineCount('alpha\nbeta\n')).toBe(2);
    expect(lineCount('alpha')).toBe(1);
  });

  it('creates non-overlapping hunks for separated edits', () => {
    const before = 'alpha\nbeta\ngamma\ndelta\n';
    const after = 'alpha\nBETA\ngamma\nDELTA\n';
    const hunks = diffLineHunks(before, after);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toEqual({
      baseStart: 1,
      baseEnd: 2,
      baseText: 'beta\n',
      replacementText: 'BETA\n',
    });
    expect(hunks[1]?.baseStart).toBeGreaterThanOrEqual(hunks[0]?.baseEnd ?? 0);
    expect(projectAcceptedHunks(before, hunks.slice(0, 1))).toBe('alpha\nBETA\ngamma\ndelta\n');
    expect(projectAcceptedHunks(before, hunks)).toBe(after);
  });

  it('assigns deterministic stable ids and content hashes to frozen hunks', () => {
    const first = createFrozenHunks('11111111-1111-4111-8111-111111111111', 'a\nb\n', 'A\nb\n');
    const second = createFrozenHunks('11111111-1111-4111-8111-111111111111', 'a\nb\n', 'A\nb\n');
    expect(first).toEqual(second);
    expect(first[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(first[0]?.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('treats whole-file creation and deletion as a single hunk', () => {
    expect(diffLineHunks('', 'hello\n')).toEqual([
      { baseStart: 0, baseEnd: 0, baseText: '', replacementText: 'hello\n' },
    ]);
    expect(diffLineHunks('hello\n', '')).toEqual([
      { baseStart: 0, baseEnd: 1, baseText: 'hello\n', replacementText: '' },
    ]);
  });

  it('rejects overlapping or out-of-range hunk projections', () => {
    expect(() =>
      projectAcceptedHunks('one\ntwo\n', [
        { baseStart: 0, baseEnd: 2, replacementText: '' },
        { baseStart: 1, baseEnd: 2, replacementText: 'x\n' },
      ]),
    ).toThrow('overlapping');
  });
});
