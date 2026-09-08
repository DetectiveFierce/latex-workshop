import { describe, expect, it } from 'vitest';
import { applyLspContentChanges, LatexNavigationIndex } from './latex-navigation.js';

describe('LatexNavigationIndex', () => {
  it('finds command definitions and references across project files', () => {
    const index = new LatexNavigationIndex();
    index.upsert(
      'file:///workspace/macros.sty',
      [
        '% \\newcommand{\\ignored}{no}',
        '\\newcommand{\\projectTitle}[1]{Title: #1}',
        '\\DeclareMathOperator*{\\argmin}{arg min}',
        '\\long\\def\\legacyMacro#1{#1}',
      ].join('\n'),
    );
    index.upsert(
      'file:///workspace/main.tex',
      '\\projectTitle{One}\nText \\projectTitle{Two}.\n$\\argmin_x f(x)$\n\\legacyMacro{x}',
    );

    expect(index.definition('file:///workspace/main.tex', { line: 0, character: 4 })).toEqual([
      {
        uri: 'file:///workspace/macros.sty',
        range: {
          start: { line: 1, character: 12 },
          end: { line: 1, character: 25 },
        },
      },
    ]);
    expect(
      index.references('file:///workspace/main.tex', { line: 1, character: 10 }, false),
    ).toEqual([
      {
        uri: 'file:///workspace/main.tex',
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 13 },
        },
      },
      {
        uri: 'file:///workspace/main.tex',
        range: {
          start: { line: 1, character: 5 },
          end: { line: 1, character: 18 },
        },
      },
    ]);
    expect(
      index.definition('file:///workspace/main.tex', { line: 2, character: 4 })?.[0]?.uri,
    ).toBe('file:///workspace/macros.sty');
    expect(
      index.definition('file:///workspace/main.tex', { line: 3, character: 5 })?.[0]?.uri,
    ).toBe('file:///workspace/macros.sty');
  });

  it('links begin and end names to common environment declaration forms', () => {
    const index = new LatexNavigationIndex();
    index.upsert(
      'file:///workspace/environments.tex',
      '\\newenvironment{callout}{\\quote}{\\endquote}\n\\newtheorem{claim}{Claim}',
    );
    index.upsert(
      'file:///workspace/chapter.tex',
      '\\begin{callout}\nBody\n\\end{callout}\n\\begin{claim}Yes\\end{claim}',
    );

    expect(index.definition('file:///workspace/chapter.tex', { line: 0, character: 9 })).toEqual([
      {
        uri: 'file:///workspace/environments.tex',
        range: {
          start: { line: 0, character: 16 },
          end: { line: 0, character: 23 },
        },
      },
    ]);
    expect(
      index.references('file:///workspace/chapter.tex', { line: 2, character: 8 }, true),
    ).toHaveLength(3);
    expect(
      index.definition('file:///workspace/chapter.tex', { line: 3, character: 9 })?.[0]?.range,
    ).toEqual({
      start: { line: 1, character: 12 },
      end: { line: 1, character: 17 },
    });
  });

  it('falls back for symbols without a project definition and updates unsaved text', () => {
    const index = new LatexNavigationIndex();
    index.upsert('file:///workspace/main.tex', '\\section{Before}');
    expect(index.definition('file:///workspace/main.tex', { line: 0, character: 3 })).toBeNull();

    const changed = applyLspContentChanges(index.text('file:///workspace/main.tex') ?? '', [
      {
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 16 },
        },
        text: '\\newcommand{\\fresh}{value}\n\\fresh',
      },
    ]);
    expect(changed).not.toBeNull();
    index.upsert('file:///workspace/main.tex', changed ?? '');
    expect(index.definition('file:///workspace/main.tex', { line: 1, character: 6 })).toEqual([
      {
        uri: 'file:///workspace/main.tex',
        range: {
          start: { line: 0, character: 12 },
          end: { line: 0, character: 18 },
        },
      },
    ]);
  });
});
