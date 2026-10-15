import { describe, expect, it } from 'vitest';
import { orderEntriesForDuplication } from './entry-duplication.js';

describe('entry duplication order', () => {
  const entries = [
    { id: 'file', parentId: 'nested', name: 'chapter.tex' },
    { id: 'nested', parentId: 'folder', name: 'drafts' },
    { id: 'folder', parentId: null, name: 'chapters' },
    { id: 'main', parentId: null, name: 'main.tex' },
  ];

  it('duplicates a nested file without treating its omitted parent as corrupt', () => {
    expect(orderEntriesForDuplication(entries, new Set(['file']))).toEqual([entries[0]]);
  });

  it('orders a nested folder before its children and excludes its ancestors and siblings', () => {
    expect(orderEntriesForDuplication(entries, new Set(['nested', 'file']))).toEqual([
      entries[1],
      entries[0],
    ]);
  });

  it('keeps rejection of genuinely missing parents', () => {
    expect(() => orderEntriesForDuplication(entries.slice(0, 2), new Set(['file']))).toThrow(
      'Missing parent',
    );
  });
});
