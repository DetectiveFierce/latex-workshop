import { describe, expect, it } from 'vitest';
import { mergeText } from './text-merge.js';

describe('mergeText', () => {
  it('accepts identical and one-sided changes', () => {
    expect(mergeText('abc', 'abc', 'axc')).toEqual({ clean: true, content: 'axc' });
    expect(mergeText('abc', 'axc', 'abc')).toEqual({ clean: true, content: 'axc' });
    expect(mergeText('abc', 'axc', 'axc')).toEqual({ clean: true, content: 'axc' });
  });

  it('merges disjoint changes', () => {
    expect(mergeText('alpha beta gamma', 'ALPHA beta gamma', 'alpha beta GAMMA')).toEqual({
      clean: true,
      content: 'ALPHA beta GAMMA',
    });
  });

  it('rejects overlapping changes', () => {
    expect(mergeText('alpha beta', 'alpha BETA', 'alpha BEST')).toEqual({
      clean: false,
      content: null,
    });
  });

  it('rejects competing insertions at the same position', () => {
    expect(mergeText('ab', 'a-local-b', 'a-remote-b')).toEqual({
      clean: false,
      content: null,
    });
  });
});
