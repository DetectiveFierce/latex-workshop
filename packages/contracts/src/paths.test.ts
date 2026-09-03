import { describe, expect, it } from 'vitest';
import { buildEntryPaths, normalizeArchivePath, validateEntryName } from './paths.js';

describe('path safety', () => {
  it('normalizes safe archive paths', () =>
    expect(normalizeArchivePath('chapters\\one.tex')).toBe('chapters/one.tex'));
  it('normalizes each archive path segment', () =>
    expect(normalizeArchivePath(' chapters / one.tex ')).toBe('chapters/one.tex'));
  it.each(['../secret', '/etc/passwd', 'C:/secret', 'a/../../b'])(
    'rejects unsafe paths',
    (path) => {
      expect(() => normalizeArchivePath(path)).toThrow();
    },
  );
  it('rejects separators in entry names', () => expect(() => validateEntryName('a/b')).toThrow());

  it.each(['line\nbreak', 'carriage\rreturn', 'tab\tname', '\0hidden'])(
    'rejects control characters in entry names',
    (name) => expect(() => validateEntryName(name)).toThrow(),
  );

  it('preserves path-safety invariants under deterministic fuzzing', () => {
    let state = 0xc0ffee;
    const alphabet = ['a', 'Z', '0', '.', '/', '\\', '\0', '\n', 'é', '\u0301', '文', ' '];
    const random = () => {
      state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
      return state;
    };

    for (let run = 0; run < 10_000; run += 1) {
      const input = Array.from(
        { length: random() % 40 },
        () => alphabet[random() % alphabet.length]!,
      ).join('');
      try {
        const normalized = normalizeArchivePath(input);
        expect(normalizeArchivePath(normalized)).toBe(normalized);
        expect(normalized).not.toContain('\\');
        expect(
          [...normalized].every((character) => character >= ' ' && character !== '\u007f'),
        ).toBe(true);
        expect(normalized.startsWith('/')).toBe(false);
        expect(normalized.split('/')).not.toContain('.');
        expect(normalized.split('/')).not.toContain('..');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
    }
  });
});

describe('buildEntryPaths', () => {
  it('builds nested paths independent of input order', () => {
    expect(
      buildEntryPaths([
        { id: 'file', parentId: 'folder', name: 'main.tex' },
        { id: 'folder', parentId: null, name: 'src' },
      ]).get('file'),
    ).toBe('src/main.tex');
  });

  it('rejects missing parents, cycles, and invalid persisted names', () => {
    expect(() => buildEntryPaths([{ id: 'a', parentId: 'missing', name: 'a' }])).toThrow(
      'Missing parent',
    );
    expect(() =>
      buildEntryPaths([
        { id: 'a', parentId: 'b', name: 'a' },
        { id: 'b', parentId: 'a', name: 'b' },
      ]),
    ).toThrow('cycle');
    expect(() => buildEntryPaths([{ id: 'a', parentId: null, name: '../escape' }])).toThrow();
  });
});
