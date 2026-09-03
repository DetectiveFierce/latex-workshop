import { describe, expect, it } from 'vitest';
import { normalizeArchivePath, validateEntryName } from './paths.js';

describe('path safety', () => {
  it('normalizes safe archive paths', () =>
    expect(normalizeArchivePath('chapters\\one.tex')).toBe('chapters/one.tex'));
  it.each(['../secret', '/etc/passwd', 'C:/secret', 'a/../../b'])(
    'rejects unsafe paths',
    (path) => {
      expect(() => normalizeArchivePath(path)).toThrow();
    },
  );
  it('rejects separators in entry names', () => expect(() => validateEntryName('a/b')).toThrow());
});
