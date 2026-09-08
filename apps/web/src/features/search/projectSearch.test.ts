import { describe, expect, it } from 'vitest';
import { searchProjectSources } from './projectSearch.js';

const sources = [
  { entryId: 'main', path: 'main.tex', content: 'Hello world\nhello again' },
  { entryId: 'chapter', path: 'chapters/one.tex', content: 'No match\nWorld view' },
];

describe('project source search', () => {
  it('finds every literal match case-insensitively with editor coordinates', () => {
    expect(searchProjectSources(sources, 'hello')).toEqual([
      {
        entryId: 'main',
        path: 'main.tex',
        line: 1,
        column: 1,
        endColumn: 6,
        preview: 'Hello world',
      },
      {
        entryId: 'main',
        path: 'main.tex',
        line: 2,
        column: 1,
        endColumn: 6,
        preview: 'hello again',
      },
    ]);
  });

  it('returns results in project and line order and respects the result limit', () => {
    expect(searchProjectSources(sources, 'world', 1)).toEqual([
      expect.objectContaining({ entryId: 'main', line: 1, column: 7 }),
    ]);
  });

  it('does not treat search text as a regular expression', () => {
    const literal = [{ entryId: 'main', path: 'main.tex', content: 'a+b and ab' }];
    expect(searchProjectSources(literal, 'a+b')).toHaveLength(1);
    expect(searchProjectSources(literal, '   ')).toEqual([]);
  });
});
