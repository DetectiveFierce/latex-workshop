import { describe, expect, it } from 'vitest';
import {
  parseInverseSyncRecords,
  resolveInversePath,
  sourceSelectionForPdf,
} from './inverse-sync.js';
import { alignSelectionToCompiled } from './synctex.js';

describe('inverse SyncTeX results', () => {
  it('accepts actual Graybill-Deal edit output without PDF coordinates and with an unknown column', () => {
    expect(
      parseInverseSyncRecords(
        'SyncTeX result begin\nOutput:document.pdf\nInput:/workspace/./chapters/chapter01-common-mean-problem.tex\nLine:45\nColumn:-1\nOffset:0\nContext:\nSyncTeX result end',
      ),
    ).toEqual([
      { input: '/workspace/./chapters/chapter01-common-mean-problem.tex', line: 45, column: null },
    ]);
  });

  it('retains multiple source candidates and drops invalid lines or columns', () => {
    expect(
      parseInverseSyncRecords(
        'Input:bad.tex\nLine:NaN\nInput:first.tex\nLine:10\nColumn:-1\nInput:bad.tex\nLine:2\nColumn:-4\nInput:second.tex\nLine:20\nColumn:7',
      ),
    ).toEqual([
      { input: 'first.tex', line: 10, column: null },
      { input: 'second.tex', line: 20, column: 7 },
    ]);
  });

  it('resolves only canonical project paths, including subfile parent segments', () => {
    const manifest = [
      { path: 'chapters/first/common.tex' },
      { path: 'chapters/second/common.tex' },
    ];
    expect(resolveInversePath('/workspace/./chapters/first/../second/common.tex', manifest)).toBe(
      manifest[1],
    );
    expect(resolveInversePath('common.tex', manifest)).toBeNull();
    expect(resolveInversePath('/usr/share/chapters/second/common.tex', manifest)).toBeNull();
    expect(resolveInversePath('/workspace/../../chapters/second/common.tex', manifest)).toBeNull();
  });
});

describe('PDF text to source selection', () => {
  it('uses a prose clause when inline mathematics differs from the LaTeX source', () => {
    const source =
      'The parameter of interest is the common mean $\\mu \\in \\mathbb{R}$.\n' +
      '\n'.repeat(15) +
      'End of paragraph.';
    const mapped = sourceSelectionForPdf(
      source,
      17,
      'The parameter of interest is the common mean μ ∈ R',
    );
    expect(mapped.matched).toBe(true);
    expect(mapped.selection.start.line).toBe(1);
  });

  it('centers the token budget around the source line even with very dense preceding text', () => {
    const source = 'padding '.repeat(10_000) + '\nTarget source sentence.\nEnd';
    const mapped = sourceSelectionForPdf(source, 2, 'Target source sentence');
    expect(mapped.matched).toBe(true);
    expect(mapped.selection.start.line).toBe(2);
  });
  it('matches wrapped typeset prose through LaTeX formatting commands', () => {
    const source =
      '\\section{Model}\nThe \\textbf{common mean} normal model\nis our starting point.\nOther text.';
    const result = sourceSelectionForPdf(
      source,
      3,
      'common mean normal model is our starting point',
    );
    expect(result.matched).toBe(true);
    expect(result.selection.start).toEqual({ line: 2, column: 13 });
    expect(result.selection.end).toEqual({ line: 3, column: 22 });
  });

  it('uses surrounding context to distinguish repeated phrases', () => {
    const source = 'Old target passage ignored\n\nNew target passage wanted';
    expect(
      sourceSelectionForPdf(source, 1, 'target passage', 'New ', ' wanted').selection.start.line,
    ).toBe(3);
  });

  it('handles ligatures and Unicode across thousands of lines', () => {
    const lines = Array.from({ length: 8_000 }, (_, index) => `Background line ${index}.`);
    lines[7_120] = 'The efficient office estimator is admissible.';
    const result = sourceSelectionForPdf(lines.join('\n'), 7_120, 'eﬃcient oﬃce estimator');
    expect(result.matched).toBe(true);
    expect(result.selection.start.line).toBe(7_121);
  });

  it('selects and clamps the source line when rendered math cannot be matched as text', () => {
    const result = sourceSelectionForPdf('Heading\n\\begin{align} x &= y \\end{align}', 500, '∫∞');
    expect(result.matched).toBe(false);
    expect(result.selection.start).toEqual({ line: 2, column: 1 });
    expect(result.selection.end.line).toBe(2);
  });

  it('maps a stale PDF selection through lines inserted since compilation', () => {
    const compiled = 'Heading\nThe target passage is here.\nEnd';
    const current = 'New line\nAnother insertion\n' + compiled;
    const selected = sourceSelectionForPdf(compiled, 2, 'target passage').selection;
    expect(alignSelectionToCompiled(compiled, current, selected).start).toEqual({
      line: 4,
      column: 5,
    });
  });
});
