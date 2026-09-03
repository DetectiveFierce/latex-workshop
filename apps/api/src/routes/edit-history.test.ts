import { describe, expect, it } from 'vitest';
import { sha256 } from '../lib/domain.js';
import { applyPatch, makePatch, reconstructHistoryContent } from './edit-history.js';

describe('edit history patches', () => {
  it('stores a compact offset patch for insertions and replacements', () => {
    expect(applyPatch('alpha beta', makePatch('alpha beta', 'alpha brave beta'))).toBe(
      'alpha brave beta',
    );
    expect(applyPatch('alpha beta', makePatch('alpha beta', 'alpha gamma'))).toBe('alpha gamma');
    expect(makePatch('unchanged', 'unchanged')).toEqual([]);
  });

  it('reconstructs a branch from a bounded snapshot chain and validates every hash', () => {
    const snapshot = 'A';
    const middle = 'A → B';
    const final = 'A → B → C';
    const chain = [
      {
        beforeHash: sha256(snapshot),
        afterHash: sha256(middle),
        patch: makePatch(snapshot, middle),
      },
      {
        beforeHash: sha256(middle),
        afterHash: sha256(final),
        patch: makePatch(middle, final),
      },
    ];
    expect(reconstructHistoryContent(snapshot, sha256(snapshot), chain)).toBe(final);
    expect(() => reconstructHistoryContent('corrupt', sha256(snapshot), chain)).toThrow(
      'snapshot hash mismatch',
    );
    expect(() =>
      reconstructHistoryContent(snapshot, sha256(snapshot), [
        { ...chain[0]!, beforeHash: sha256('wrong') },
      ]),
    ).toThrow('patch base mismatch');
  });
});
