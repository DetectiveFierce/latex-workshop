import { describe, expect, it } from 'vitest';
import { cleanLatexText } from './latexText';
import { collectMacros, emptyMacroTable } from './latexMacros';
import {
  buildOutline,
  includeCandidates,
  includedPaths,
  localPackagePaths,
  numberOutline,
  preambleOf,
  scanOutline,
  sourceIncludes,
  type OutlineNode,
} from './outlineModel';

/** Run the whole pipeline over one document. */
function outline(source: string, definitions = ''): OutlineNode[] {
  const macros = emptyMacroTable();
  collectMacros(definitions, macros);
  collectMacros(preambleOf(source), macros);
  const flat = scanOutline('main.tex', source, macros).flatMap((event) =>
    event.type === 'node' ? [event.node] : [],
  );
  return numberOutline(buildOutline(flat));
}
const names = (nodes: OutlineNode[]) => nodes.map((node) => node.name);
const body = (text: string) =>
  `\\documentclass{article}\n\\begin{document}\n${text}\n\\end{document}\n`;

// Helpers in the style templates often use: optional scales, delegation and split titles.
const HEADING_HELPERS = String.raw`
\makeatletter
\newcommand{\@mainhead}[2]{\section{#1}\markboth{\normalsize #1}{}}
\newcommand{\mainhead}{\@ifnextchar\bgroup{\@mainheadWithScale}{\@mainheadDefault}}
\newcommand{\@mainheadWithScale}[1]{\@ifnextchar\bgroup{\@mainheadWithScaleAndTitle{#1}}{\@mainhead{#1}{1.0}}}
\newcommand{\@mainheadWithScaleAndTitle}[2]{\@mainhead{#1}{#2}}
\newcommand{\@mainheadDefault}[1]{\@mainhead{#1}{1.0}}
\newcommand{\@mainsub}[3]{\subsection[#2]{#1}\markright{#2}}
\NewDocumentCommand{\mainsub}{O{} m}{\ifstrempty{#1}{\@mainsub{#2}{#2}{1.0}}{\@mainsub{#2}{#1}{1.0}}}
\newcommand{\@twopart}[3]{\section*{\Large\scalebox{#3}[#3]{#1} \hspace{0.25em} - \textcolor{muted}{\large #2}}\vspace{-1em}}
\newcommand{\twopart}{\@ifnextchar\bgroup{\@twopartWithArgs}{\@twopartError}}
\newcommand{\@twopartWithArgs}[1]{\@ifnextchar\bgroup{\@twopartWithSubtitle{#1}}{\@twopart{#1}{}{1.0}}}
\newcommand{\@twopartWithSubtitle}[2]{\@ifnextchar\bgroup{\@twopartWithScale{#1}{#2}}{\@twopart{#1}{#2}{1.0}}}
\newcommand{\@twopartWithScale}[3]{\@twopart{#1}{#2}{#3}}
\makeatother
`;

describe('include resolution', () => {
  it('follows relative TeX includes, ignoring commented and out-of-project paths', () => {
    const text =
      '% \\input{hidden}\n\\input{intro}\n\\include{../appendix}\n\\input{../../outside}\n\\input{macro\\name}\n';
    expect(includedPaths('sections/main.tex', text)).toEqual([
      'sections/intro.tex',
      'appendix.tex',
    ]);
    expect(sourceIncludes('sections/main.tex', text)).toEqual([
      { path: 'sections/intro.tex', line: 2 },
      { path: 'appendix.tex', line: 3 },
    ]);
  });

  it('tries the main folder first because TeX resolves inputs from there', () => {
    expect(includeCandidates('main.tex', 'lib/in_header.tex', 'lib/packages')).toEqual([
      'lib/packages.tex',
      'lib/lib/packages.tex',
    ]);
  });

  it('finds project packages and classes that may define headings', () => {
    expect(localPackagePaths('\\documentclass{notes}\n\\usepackage[a]{mine, other}\n')).toEqual([
      'mine.sty',
      'other.sty',
      'notes.cls',
    ]);
  });
});

describe('title cleaning', () => {
  it.each([
    ['\\textbf{Chapter 1}', 'Chapter 1'],
    ['\\textcolor{red}{\\emph{Risk}} bounds', 'Risk bounds'],
    [
      '\\Large\\scalebox{1.0}[1.0]{Limits} \\hspace{0.25em} - \\textcolor{muted}{\\large Series}',
      'Limits - Series',
    ],
    ['Part 1 --- Unit 1', 'Part 1 — Unit 1'],
    ['The Smith--Jones Estimator', 'The Smith–Jones Estimator'],
    ['First Topic \\& Second Topic', 'First Topic & Second Topic'],
    ['\\texorpdfstring{$\\sigma$-algebras}{Sigma algebras}', 'Sigma algebras'],
    ['$\\sigma$-algebras and $L^p$', 'σ-algebras and L^p'],
    ['Intro\\label{sec:intro}\\footnote{Later}', 'Intro'],
    ['Erd\\H{o}s and G\\"odel', 'Erdos and Gödel'],
    ['\\href{https://example.test}{Sources}', 'Sources'],
    ['One\\\\Two~Three', 'One Two Three'],
  ])('reduces %s', (source, expected) => {
    expect(cleanLatexText(source)).toBe(expected);
  });

  it('expands plain text macros', () => {
    expect(cleanLatexText('\\mytitle', (name) => (name === 'mytitle' ? 'Course' : undefined))).toBe(
      'Course',
    );
  });
});

describe('sections', () => {
  it('numbers standard sections and nests by level', () => {
    const nodes = outline(body('\\section{One}\n\\subsection{Inner}\n\\section{Two}'));
    expect(nodes.map((node) => [node.number, node.name])).toEqual([
      ['1', 'One'],
      ['2', 'Two'],
    ]);
    expect(nodes[0]?.children[0]).toMatchObject({ number: '1.1', name: 'Inner' });
  });

  it('ignores the preamble, macro bodies, comments, verbatim and \\iffalse blocks', () => {
    const source = String.raw`\documentclass{article}
\section{In the preamble}
\begin{document}
% \section{Commented}
\newcommand{\later}{\section{In a definition}}
\begin{verbatim}
\section{Verbatim}
\end{verbatim}
\iffalse
\section{Disabled}
\fi
\section{Real}
\end{document}
`;
    expect(names(outline(source))).toEqual(['Real']);
  });

  it('reads multi-line titles and prefers the short optional title', () => {
    const nodes = outline(body('\\section[Short]{A very\nlong title}\n\\section{Two\nlines}'));
    expect(names(nodes)).toEqual(['Short', 'Two lines']);
  });

  it('strips markup from titles and attaches the following label', () => {
    const nodes = outline(body('\\section{\\textbf{Chapter 1}}\\label{sec:one}\n\\section{Two}'));
    expect(nodes[0]).toMatchObject({ name: 'Chapter 1', label: 'sec:one' });
  });

  it('does not make paragraphs into sections', () => {
    expect(names(outline(body('\\section{Real}\n\\paragraph{Run-in}\nText.')))).toEqual(['Real']);
  });

  it('honours starred headings, secnumdepth and appendices', () => {
    const nodes = outline(
      body(
        '\\section{A}\n\\section*{B}\n\\setcounter{secnumdepth}{0}\n\\section{C}\n\\setcounter{secnumdepth}{3}\n\\appendix\n\\section{D}\n\\subsection{E}',
      ),
    );
    expect(nodes.map((node) => node.number)).toEqual(['1', '', '', 'A']);
    expect(nodes[3]?.children[0]?.number).toBe('A.1');
  });

  it('ranks levels so documents starting below \\section still read from the top', () => {
    const nodes = outline(body('\\subsection{One}\n\\subsubsection{Inner}'));
    expect(nodes[0]).toMatchObject({ number: '1', level: 1 });
    expect(nodes[0]?.children[0]?.number).toBe('1.1');
  });

  it('ends a section before the next one at its level', () => {
    const nodes = outline(body('\\section{One}\nText\n\\section{Two}\nMore'));
    expect(nodes[0]).toMatchObject({ line: 3, endLine: 4 });
    expect(nodes[1]?.line).toBe(5);
  });
});

describe('custom section commands', () => {
  it('follows chains of helper commands to the sectioning command they call', () => {
    const nodes = outline(
      body('\\mainhead{Limits}\n\\mainsub{Known case}\n\\mainsub[Short]{Long name}'),
      HEADING_HELPERS,
    );
    expect(names(nodes)).toEqual(['Limits']);
    expect(nodes[0]?.number).toBe('1');
    expect(names(nodes[0]?.children ?? [])).toEqual(['Known case', 'Long name']);
    expect(nodes[0]?.children[0]?.number).toBe('1.1');
  });

  it('combines arguments in a command whose title uses several of them', () => {
    const nodes = outline(
      body('\\twopart{Limits}{Series}\n\\twopart{Next}{Topic}'),
      HEADING_HELPERS,
    );
    expect(names(nodes)).toEqual(['Limits - Series', 'Next - Topic']);
    expect(nodes[0]?.number).toBe('');
  });

  it('understands wrappers with fixed text, xparse, \\def, \\let and \\@startsection', () => {
    const definitions = String.raw`
\newcommand{\lecture}[2]{\section{Lecture #1: #2}}
\NewDocumentCommand{\topic}{s m}{\subsection{#2}}
\def\problemset#1{\section*{Problem Set #1}}
\let\mysec\section
\makeatletter\newcommand{\sidenote}{\@startsection{sidenote}{2}{0pt}{1ex}{1ex}{\bfseries}}\makeatother
`;
    const nodes = outline(
      body(
        '\\lecture{3}{\\emph{Limits}}\n\\topic{Series}\n\\sidenote{Aside}\n\\problemset{4}\n\\mysec{Plain}',
      ),
      definitions,
    );
    expect(names(nodes)).toEqual(['Lecture 3: Limits', 'Problem Set 4', 'Plain']);
    expect(names(nodes[0]?.children ?? [])).toEqual(['Series', 'Aside']);
  });

  it('detects styled title commands, but not inline emphasis', () => {
    const definitions = String.raw`
\newcommand{\pagehead}[1]{\noindent{\Large\bfseries #1}\par\vspace{.46em}}
\newcommand{\newpart}[1]{\newpage\pagehead{#1}}
\newcommand{\highlight}[1]{\textcolor{accent}{\heavy #1}\xspace}
\newcommand{\tint}[1]{\textcolor{accenttwo}{#1}}
`;
    const nodes = outline(
      body('\\newpart{Part one}\nSee \\highlight{this} and \\tint{that}.\n\\newpart{Part two}'),
      definitions,
    );
    expect(names(nodes)).toEqual(['Part one', 'Part two']);
  });

  it('survives recursive definitions', () => {
    const definitions = '\\newcommand{\\a}{\\b}\\newcommand{\\b}{\\a}';
    expect(names(outline(body('\\a{One}\n\\section{Two}'), definitions))).toEqual(['Two']);
  });
});

describe('document headers', () => {
  const titled = String.raw`\newcommand{\mytitle}{TITLE PLACEHOLDER}
\renewcommand{\mytitle}{Course -- Notes}
`;
  it('drops a heading that prints the document title macro', () => {
    const source = body(
      '\\thispagestyle{firstpage}\n\\begingroup\n\\setcounter{secnumdepth}{0}\n\\mainhead{\\mytitle}{1.25}\n\\endgroup\n\\setcounter{secnumdepth}{2}\n\\section{Sets}',
    );
    expect(names(outline(source, HEADING_HELPERS + titled))).toEqual(['Sets']);
  });

  it('drops a heading whose text matches \\title', () => {
    const source =
      '\\documentclass{article}\n\\title{The \\textbf{Book}}\n\\begin{document}\n\\section*{The Book}\n\\section{One}\n\\end{document}\n';
    expect(names(outline(source))).toEqual(['One']);
  });

  it('drops a leading once-used unnumbered title', () => {
    const definitions = '\\newcommand{\\pagehead}[1]{\\noindent{\\Large\\bfseries #1}\\par}';
    const source = body('\\pagehead{First Topic}\nRecall the definition.\n\\section{Next}');
    expect(names(outline(source, definitions))).toEqual(['Next']);
  });

  it('keeps an opening heading when prose precedes it or the command repeats', () => {
    expect(names(outline(body('Intro text.\n\\section*{One}\n\\section{Two}')))).toEqual([
      'One',
      'Two',
    ]);
    expect(names(outline(body('\\section*{One}\n\\section*{Two}')))).toEqual(['One', 'Two']);
    expect(names(outline(body('\\section{Only numbered}\n\\section{Two}')))).toEqual([
      'Only numbered',
      'Two',
    ]);
  });
});

describe('hand-written headings', () => {
  // Worksheets often have no sectioning commands at all.
  const homework =
    body(String.raw`\noindent\textbf{Part 1 --- Unit 1}\hfill\textit{Reading: Sections 1--2}\par\smallskip
\begin{problem}[Book 1.1; p. 2]
\textbf{Claim} inside a statement.
\end{problem}

\noindent\textbf{Part 2 --- Unit 2}\hfill\textit{Reading}\par\smallskip
Some \textbf{bold words} in a sentence.

\textbf{Hint.} Run-in label with text after it.

\noindent\hypertarget{ref:sources}{\textbf{Sources}}\par
A reference.`);

  it('treats standalone bold lines as sections and keeps statements beneath them', () => {
    const nodes = outline(homework);
    expect(names(nodes)).toEqual(['Part 1 — Unit 1', 'Part 2 — Unit 2', 'Sources']);
    expect(nodes[0]?.children[0]).toMatchObject({
      name: 'Problem',
      number: '1',
      detail: 'Book 1.1; p. 2',
    });
  });

  it('needs more than one, and never overrides real sections', () => {
    expect(outline(body('\\noindent\\textbf{Only one}\\par\nText.'))).toEqual([]);
    expect(
      names(outline(body('\\section{Real}\n\\textbf{First}\\par\nText.\n\n\\textbf{Second}\\par'))),
    ).toEqual(['Real']);
  });
});

describe('statements and floats', () => {
  it('reads statement names and counters from \\newtheorem', () => {
    const definitions = String.raw`
\newtheorem{thm}{Theorem}[section]
\newtheorem{lem}[thm]{Lemma}
\newtheorem*{note}{Note}
`;
    const nodes = outline(
      body(
        '\\section{A}\n\\begin{thm}[Main]\\label{thm:a}\nX\n\\end{thm}\n\\begin{lem}\nY\n\\end{lem}\n\\begin{note}\nZ\n\\end{note}\n\\section{B}\n\\begin{thm}\nW\n\\end{thm}',
      ),
      definitions,
    );
    expect(
      nodes[0]?.children.map((node) => [node.name, node.number, node.detail, node.label]),
    ).toEqual([
      ['Theorem', '1.1', 'Main', 'thm:a'],
      ['Lemma', '1.2', '', ''],
      ['Note', '', '', ''],
    ]);
    expect(nodes[1]?.children[0]?.number).toBe('2.1');
  });

  it('follows wrapper environments and ignores decorative boxes', () => {
    const definitions = String.raw`
\newtheorem{problem}{Problem}
\NewDocumentEnvironment{pagedproblem}{o}{\IfValueTF{#1}{\begin{problem}[#1]}{\begin{problem}}}{\end{problem}\clearpage}
\newtcolorbox{definition}[1][]{title={Definition}}
\newtcolorbox{idea}{title=Main idea}
`;
    const nodes = outline(
      body(
        '\\section{A}\n\\begin{pagedproblem}[Book 1.2]\nX\n\\end{pagedproblem}\n\\begin{definition}[Compact]\nY\n\\end{definition}\n\\begin{idea}\nZ\n\\end{idea}',
      ),
      definitions,
    );
    expect(nodes[0]?.children.map((node) => [node.name, node.number, node.detail])).toEqual([
      ['Problem', '1', 'Book 1.2'],
      ['Definition', '', 'Compact'],
    ]);
  });

  it('lists only labelled equations and captions floats without their inner markup', () => {
    const nodes = outline(
      body(
        '\\section{A}\n\\begin{equation}\nx\n\\end{equation}\n\\begin{equation}\\label{eq:risk}\ny\n\\end{equation}\n\\begin{figure}\n\\caption{The \\emph{risk} curve}\\label{fig:risk}\n\\end{figure}\n\\begin{table}\n\\caption[Short]{Long}\n\\end{table}',
      ),
    );
    expect(
      nodes[0]?.children.map((node) => [
        node.category,
        node.name,
        node.number,
        node.detail,
        node.label,
      ]),
    ).toEqual([
      ['equation', 'Equation', '', '', 'eq:risk'],
      ['figure', 'Figure', '1', 'The risk curve', 'fig:risk'],
      ['table', 'Table', '1', 'Long', ''],
    ]);
  });

  it('skips proofs, and treats statements in macros as definitions', () => {
    const source = body(
      '\\newcommand{\\x}{\\begin{theorem}a\\end{theorem}}\n\\section{A}\n\\begin{proof}\nP\n\\end{proof}',
    );
    expect(outline(source)[0]?.children).toEqual([]);
  });
});
