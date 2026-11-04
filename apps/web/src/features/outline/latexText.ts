/** Blank comments, verbatim bodies and \iffalse blocks, keeping every offset and line intact. */
export function maskSource(source: string): string {
  const blank = (text: string) => text.replace(/[^\n]/g, ' ');
  const withoutComments = source.replace(/(^|[^\\])((?:\\\\)*)%[^\n]*/g, (match, lead, slashes) => {
    const kept = `${lead as string}${slashes as string}`;
    return kept + blank(match.slice(kept.length));
  });
  return withoutComments
    .replace(
      /\\begin\s*\{(verbatim\*?|lstlisting|minted|comment|Verbatim)\}[\s\S]*?\\end\s*\{\1\}/g,
      blank,
    )
    .replace(/\\iffalse\b[\s\S]*?\\fi\b/g, blank);
}

/** Offset just past the group opening at `open`, or -1 when it never closes. */
export function closeOf(text: string, open: number, opener = '{', closer = '}'): number {
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    const char = text[index];
    if (char === '\\') {
      index++;
    } else if (char === opener) {
      depth++;
    } else if (char === closer && --depth === 0) {
      return index + 1;
    }
  }
  return -1;
}

export function skipSpace(text: string, from: number): number {
  let index = from;
  while (index < text.length && /\s/.test(text[index] ?? '')) index++;
  return index;
}

/** Read `[opt]` or `{arg}` at `from`; returns the inner text and the offset after it. */
export function readGroup(
  text: string,
  from: number,
  opener: '{' | '[',
): { value: string; end: number } | null {
  const start = skipSpace(text, from);
  if (text[start] !== opener) return null;
  const end = closeOf(text, start, opener, opener === '{' ? '}' : ']');
  return end < 0 ? null : { value: text.slice(start + 1, end - 1), end };
}

const SYMBOLS: Record<string, string> = {
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  epsilon: 'ε',
  varepsilon: 'ε',
  theta: 'θ',
  lambda: 'λ',
  mu: 'μ',
  pi: 'π',
  rho: 'ρ',
  sigma: 'σ',
  tau: 'τ',
  phi: 'φ',
  chi: 'χ',
  omega: 'ω',
  Gamma: 'Γ',
  Delta: 'Δ',
  Theta: 'Θ',
  Lambda: 'Λ',
  Sigma: 'Σ',
  Phi: 'Φ',
  Omega: 'Ω',
  infty: '∞',
  times: '×',
  cdot: '·',
  leq: '≤',
  le: '≤',
  geq: '≥',
  ge: '≥',
  neq: '≠',
  ne: '≠',
  in: '∈',
  to: '→',
  rightarrow: '→',
  sum: '∑',
  int: '∫',
  dots: '…',
  ldots: '…',
  cdots: '…',
  textendash: '–',
  textemdash: '—',
  S: '§',
  P: '¶',
  LaTeX: 'LaTeX',
  TeX: 'TeX',
  textbackslash: '\\',
};
const COMBINING: Record<string, string> = {
  "'": '́',
  '`': '̀',
  '^': '̂',
  '"': '̈',
  '~': '̃',
};
/** Commands whose arguments never belong in a title. */
const DROP_ARGUMENTS: Record<string, number> = {
  label: 1,
  footnote: 1,
  thanks: 1,
  index: 1,
  cite: 1,
  hspace: 1,
  vspace: 1,
  phantom: 1,
  vphantom: 1,
  hphantom: 1,
  color: 1,
  rule: 2,
  fontsize: 2,
  markboth: 2,
  markright: 1,
  addcontentsline: 3,
  setcounter: 2,
  addtocounter: 2,
  thispagestyle: 1,
  pagestyle: 1,
  newpage: 0,
};
/** Commands that wrap their visible text behind leading arguments. */
const KEEP_LAST_OF: Record<string, number> = {
  textcolor: 2,
  colorbox: 2,
  fcolorbox: 3,
  href: 2,
  hyperref: 1,
  hypertarget: 2,
  hyperlink: 2,
  texorpdfstring: 2,
  scalebox: 2,
  resizebox: 3,
  rotatebox: 2,
  raisebox: 2,
  makebox: 1,
  parbox: 2,
  setlength: 2,
};
const MAX_TITLE = 400;

function readCommandArgument(text: string, from: number): { value: string; end: number } | null {
  let end = from;
  for (;;) {
    const optional = readGroup(text, end, '[');
    if (!optional) break;
    end = optional.end;
  }
  return readGroup(text, end, '{');
}

function cleanOnce(source: string, expand: (name: string) => string | undefined, depth: number) {
  let output = '';
  let index = 0;
  while (index < source.length && output.length < MAX_TITLE) {
    const char = source[index] ?? '';
    if (char === '{' || char === '}' || char === '$') {
      index++;
    } else if (char === '~') {
      output += ' ';
      index++;
    } else if (char !== '\\') {
      output += char;
      index++;
    } else {
      const next = source[index + 1] ?? '';
      const accent = COMBINING[next];
      if (/[a-zA-Z@]/.test(next)) {
        const name = /^[a-zA-Z@]+\*?/.exec(source.slice(index + 1))?.[0] ?? '';
        let end = index + 1 + name.length;
        const plain = name.replace(/\*$/, '');
        const expansion = depth < 4 ? expand(plain) : undefined;
        if (expansion !== undefined) {
          output += cleanOnce(expansion, expand, depth + 1);
        } else if (plain in SYMBOLS) {
          output += `${SYMBOLS[plain] ?? ''}`;
          if (/^[a-zA-Z]+$/.test(plain) && source[end] === ' ') output += ' ';
        } else if (plain in DROP_ARGUMENTS) {
          for (let count = DROP_ARGUMENTS[plain] ?? 0; count > 0; count--) {
            const argument = readCommandArgument(source, end);
            if (argument) end = argument.end;
          }
        } else if (plain in KEEP_LAST_OF) {
          let last = '';
          for (let count = KEEP_LAST_OF[plain] ?? 0; count > 0; count--) {
            const argument = readCommandArgument(source, end);
            if (!argument) break;
            last = argument.value;
            end = argument.end;
          }
          output += cleanOnce(last, expand, depth + 1);
        } else if (/^q?quad$/.test(plain)) {
          output += ' ';
        } else {
          const argument = readGroup(source, end, '{');
          if (argument && source[end] === '{') {
            output += cleanOnce(argument.value, expand, depth + 1);
            end = argument.end;
          }
        }
        index = end;
      } else if (accent) {
        const letter = /^\{?([a-zA-Z])\}?/.exec(source.slice(index + 2));
        if (letter?.[1]) {
          output += `${letter[1]}${accent}`.normalize('NFC');
          index += 2 + letter[0].length;
        } else index += 2;
      } else {
        output += /[&%$#_{}]/.test(next) ? next : ' ';
        index += 2;
      }
    }
  }
  return output;
}

/** Reduce LaTeX source to the readable text a table of contents would show. */
export function cleanLatexText(
  source: string,
  expand: (name: string) => string | undefined = () => undefined,
): string {
  return cleanOnce(source, expand, 0)
    .replace(/---/g, '—')
    .replace(/--/g, '–')
    .replace(/``/g, '“')
    .replace(/''/g, '”')
    .replace(/\s+/g, ' ')
    .trim();
}
