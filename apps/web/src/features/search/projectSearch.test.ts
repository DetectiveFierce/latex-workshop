import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROJECT_SEARCH_OPTIONS,
  projectSearchError,
  replaceProjectSourceMatches,
  searchProjectSources,
} from './projectSearch.js';

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
        startOffset: 0,
        endOffset: 5,
        match: 'Hello',
        preview: 'Hello world',
      },
      {
        entryId: 'main',
        path: 'main.tex',
        line: 2,
        column: 1,
        endColumn: 6,
        startOffset: 12,
        endOffset: 17,
        match: 'hello',
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

  it('supports the same case, whole-word, and regular-expression controls as file search', () => {
    const source = [{ entryId: 'main', path: 'main.tex', content: 'Cat catalog CAT 42' }];
    expect(
      searchProjectSources(source, 'Cat', 500, {
        caseSensitive: true,
        wholeWord: true,
        useRegex: false,
      }).map((result) => result.match),
    ).toEqual(['Cat']);
    expect(
      searchProjectSources(source, '[A-Z]+|\\d+', 500, {
        caseSensitive: true,
        wholeWord: false,
        useRegex: true,
      }).map((result) => result.match),
    ).toEqual(['C', 'CAT', '42']);
    expect(
      projectSearchError('[', { ...DEFAULT_PROJECT_SEARCH_OPTIONS, useRegex: true }),
    ).toBeTruthy();
  });

  it('replaces selected matches from the end and expands regex captures', () => {
    const source = { entryId: 'main', path: 'main.tex', content: 'one-1 one-2' };
    const options = { caseSensitive: true, wholeWord: false, useRegex: true };
    const results = searchProjectSources([source], '(one)-(\\d)', 500, options);
    expect(replaceProjectSourceMatches(source, results, '(one)-(\\d)', '$2:$1', options)).toBe(
      '1:one 2:one',
    );
  });
});
