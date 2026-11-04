import { describe, expect, it } from 'vitest';
import {
  includedPaths,
  mergeIncludedOutline,
  numberOutline,
  sourceIncludes,
  symbolsToOutline,
  type SourceSymbol,
} from './outlineModel';

const symbol = (
  name: string,
  line: number,
  endLine: number,
  children: SourceSymbol[] = [],
  detail = '',
): SourceSymbol => ({ name, line, endLine, children, detail, kind: 2 });

describe('project source outline', () => {
  it('follows relative TeX includes, ignoring commented and out-of-project paths', () => {
    const text =
      '% \\input{hidden}\n\\input{intro}\n\\include{../appendix}\n\\input{../../outside}\n\\input{macro\\name}';
    expect(includedPaths('sections/main.tex', text)).toEqual([
      'sections/intro.tex',
      'appendix.tex',
    ]);
    expect(sourceIncludes('sections/main.tex', text)).toEqual([
      { path: 'sections/intro.tex', line: 2 },
      { path: 'appendix.tex', line: 3 },
    ]);
  });

  it('preserves hierarchical TexLab symbols, compiled object names, and labels', () => {
    const text = '\\section{Risk}\n\\begin{equation}\n\\label{eq:risk}\nx=y\n\\end{equation}\n';
    const nodes = symbolsToOutline('risk.tex', text, [
      symbol('Risk', 1, 5, [symbol('Equation (2.3)', 2, 5, [], 'eq:risk')]),
    ]);
    expect(nodes[0]?.category).toBe('section');
    expect(nodes[0]?.children[0]).toMatchObject({
      name: 'Equation (2.3)',
      label: 'eq:risk',
      category: 'equation',
      line: 2,
      endLine: 5,
    });
    expect(numberOutline(nodes)[0]?.children[0]?.name).toBe('Equation (2.3)');
    expect(numberOutline(nodes)[0]?.children[0]?.number).toBe('');
  });

  it('inserts included chapters in document order and reparents their subsections', () => {
    const own = symbolsToOutline(
      'main.tex',
      '\\section{First}\ntext\n\\input{middle}\n\\section{Last}',
      [symbol('First', 1, 3), symbol('Last', 4, 4)],
    );
    const middle = symbolsToOutline('middle.tex', '\\section{Middle}\n\\subsection{Detail}', [
      symbol('Middle', 1, 2, [symbol('Detail', 2, 2)]),
    ]);
    const numbered = numberOutline(mergeIncludedOutline(own, [{ line: 3, nodes: middle }]));
    expect(numbered.map((node) => [node.name, node.number])).toEqual([
      ['First', '1'],
      ['Middle', '2'],
      ['Last', '3'],
    ]);
    expect(numbered[1]?.children[0]).toMatchObject({
      name: 'Detail',
      number: '2.1',
      path: 'middle.tex',
    });
  });

  it('keeps starred headings unnumbered', () => {
    const nodes = numberOutline(
      symbolsToOutline('main.tex', '\\section*{Abstract}\n\\section{Start}', [
        symbol('Abstract', 1, 1),
        symbol('Start', 2, 2),
      ]),
    );
    expect(nodes.map((node) => node.number)).toEqual(['', '1']);
  });
});
