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

  it('is symmetric and total under deterministic fuzzing', () => {
    let state = 0xdecafbad;
    const alphabet = ['a', 'b', ' ', '\n', 'λ', '文', '🧪'];
    const random = () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state;
    };
    const text = () =>
      Array.from({ length: random() % 50 }, () => alphabet[random() % alphabet.length]!).join('');

    for (let run = 0; run < 5_000; run += 1) {
      const base = text();
      const local = text();
      const remote = text();
      expect(mergeText(base, local, remote)).toEqual(mergeText(base, remote, local));
      expect(mergeText(base, base, remote)).toEqual({ clean: true, content: remote });
    }
  });
});
