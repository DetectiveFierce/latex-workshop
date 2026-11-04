import { cleanLatexText, closeOf, maskSource, readGroup, skipSpace } from './latexText';
import {
  resolveCommand,
  SECTION_LEVELS,
  textExpansion,
  THEOREM_NAMES,
  type ArgumentSpec,
  type HeadingCommand,
  type MacroTable,
  type TheoremCommand,
  type TheoremEnvironment,
} from './latexMacros';

export type OutlineNode = {
  id: string;
  path: string;
  name: string;
  /** Supporting text: a statement's optional title or a float's caption. */
  detail: string;
  label: string;
  line: number;
  endLine: number;
  category: 'section' | 'equation' | 'figure' | 'table' | 'theorem';
  level: number;
  numbered: boolean;
  number: string;
  /** The theorem counter this object advances, when it has one. */
  counter: string | null;
  within: string | null;
  /** The command that made this heading; a once-used leading one is the document's header. */
  command: string;
  leading: boolean;
  documentTitle: boolean;
  appendix: boolean;
  children: OutlineNode[];
};
/** A body scan yields nodes in order, with includes marking where other files splice in. */
export type OutlineEvent =
  | { type: 'node'; node: OutlineNode }
  | { type: 'include'; target: string; line: number };

const INCLUDE = /\\(?:input|include|subfile|subfileinclude)\s*\{([^}]+)\}/g;
const IMPORT = /\\(?:sub)?(?:import|includefrom|inputfrom)\s*\{([^}]*)\}\s*\{([^}]+)\}/g;
const DEFINERS = new Set([
  'newcommand',
  'renewcommand',
  'providecommand',
  'DeclareRobustCommand',
  'def',
  'gdef',
  'edef',
  'xdef',
  'let',
  'newenvironment',
  'renewenvironment',
  'NewDocumentCommand',
  'RenewDocumentCommand',
  'DeclareDocumentCommand',
  'ProvideDocumentCommand',
  'NewDocumentEnvironment',
  'RenewDocumentEnvironment',
  'DeclareDocumentEnvironment',
  'titleformat',
  'titlespacing',
  'fancyhead',
  'fancyfoot',
  'markboth',
  'markright',
  'addcontentsline',
  'newtcolorbox',
  'newtheorem',
  'AtBeginDocument',
]);
const EQUATIONS = /^(?:equation|align|alignat|gather|multline|flalign|eqnarray)\*?$/;
const FIGURES = /^(?:figure|wrapfigure|sidewaysfigure|subfigure)\*?$/;
const TABLES = /^(?:table|wraptable|sidewaystable|longtable|subtable)\*?$/;
const MAX_SOURCE = 4_000_000;

function resolveTarget(folder: string[], target: string): string | null {
  const parts = [...folder];
  for (const part of target.split('/')) {
    if (part === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else if (part && part !== '.') parts.push(part);
  }
  const resolved = parts.join('/');
  return resolved.endsWith('.tex') ? resolved : `${resolved}.tex`;
}

/** Raw include targets in source order, ignoring comments and computed paths. */
export function rawIncludes(content: string): { target: string; index: number }[] {
  const text = maskSource(content);
  const found = [
    ...[...text.matchAll(INCLUDE)].map((match) => ({ target: match[1], index: match.index })),
    ...[...text.matchAll(IMPORT)].map((match) => ({
      target: `${match[1] ?? ''}${match[2] ?? ''}`,
      index: match.index,
    })),
  ];
  return found
    .flatMap(({ target, index }) => {
      const trimmed = target?.trim();
      return trimmed && !trimmed.includes('\\') && !trimmed.startsWith('/')
        ? [{ target: trimmed, index }]
        : [];
    })
    .sort((left, right) => left.index - right.index);
}

/** Resolve includes within the project; paths never escape the project root. */
export function sourceIncludes(path: string, content: string): { path: string; line: number }[] {
  const folder = path.split('/').slice(0, -1);
  return rawIncludes(content).flatMap(({ target, index }) => {
    const resolved = resolveTarget(folder, target);
    return resolved ? [{ path: resolved, line: content.slice(0, index).split('\n').length }] : [];
  });
}
export function includedPaths(path: string, content: string): string[] {
  return sourceIncludes(path, content).map((include) => include.path);
}

/**
 * TeX resolves an \input against the main file's folder, while subfiles and hand-written paths
 * often read relative to the including file, so both are tried in that order.
 */
export function includeCandidates(mainPath: string, fromPath: string, target: string): string[] {
  const folderOf = (path: string) => path.split('/').slice(0, -1);
  const candidates = [
    resolveTarget(folderOf(mainPath), target),
    resolveTarget(folderOf(fromPath), target),
  ];
  return [...new Set(candidates.filter((path): path is string => Boolean(path)))];
}

/** Project packages and classes a file loads, which may define its sectioning commands. */
export function localPackagePaths(content: string): string[] {
  const text = maskSource(content);
  const names: string[] = [];
  for (const match of text.matchAll(
    /\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g,
  )) {
    for (const name of (match[1] ?? '').split(',')) names.push(`${name.trim()}.sty`);
  }
  const documentClass = /\\documentclass\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/.exec(text)?.[1];
  if (documentClass) names.push(`${documentClass.trim()}.cls`);
  return names;
}

/** The part of a file before \begin{document}, or all of it for a fragment or package. */
export function preambleOf(content: string): string {
  const start = /\\begin\s*\{document\}/.exec(maskSource(content));
  return start ? content.slice(0, start.index) : content;
}

function makeNode(
  path: string,
  line: number,
  endLine: number,
  fields: Partial<OutlineNode> & Pick<OutlineNode, 'name' | 'category'>,
): OutlineNode {
  return {
    id: `${path}:${line}:${fields.category}:${fields.name}`,
    path,
    detail: '',
    label: '',
    line,
    endLine,
    level: 0,
    numbered: false,
    number: '',
    counter: null,
    within: null,
    command: '',
    leading: false,
    documentTitle: false,
    appendix: false,
    children: [],
    ...fields,
  };
}

function readCallArguments(
  text: string,
  from: number,
  spec: ArgumentSpec,
): { args: string[]; end: number; starred: boolean } {
  const args: string[] = [];
  let end = from;
  let starred = false;
  for (const type of spec) {
    if (type === 's') {
      if (text[skipSpace(text, end)] === '*') {
        starred = true;
        end = skipSpace(text, end) + 1;
      }
      args.push('');
      continue;
    }
    const group = readGroup(text, end, type === 'o' ? '[' : '{');
    if (group) end = group.end;
    args.push(group?.value ?? '');
  }
  return { args, end, starred };
}

type Scan = {
  path: string;
  text: string;
  macros: MacroTable;
  expand: (name: string) => string | undefined;
  titles: Set<string>;
  lineOf: (offset: number) => number;
  secnumdepth: number;
  appendix: boolean;
  /** Offset of the body's start, to tell whether prose precedes a heading. */
  bodyStart: number;
  seenHeading: boolean;
  events: OutlineEvent[];
};

function buildLineIndex(text: string): (offset: number) => number {
  const starts = [0];
  for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) {
    starts.push(index + 1);
  }
  return (offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if ((starts[middle] ?? 0) <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
}

/** True when nothing a reader would see comes before this offset in the body. */
function hasOnlyBoilerplateBefore(scan: Scan, offset: number): boolean {
  const before = scan.text.slice(scan.bodyStart, offset);
  const stripped = before.replace(/\\[a-zA-Z@]+\*?(?:\s*\[[^\]]*\])*(?:\s*\{[^{}]*\})*/g, ' ');
  return !/[A-Za-z0-9]/.test(stripped);
}

function labelNear(text: string, from: number): string {
  return /^\s*\\label\s*\{([^}]+)\}/.exec(text.slice(from, from + 240))?.[1] ?? '';
}

function pushHeading(
  scan: Scan,
  command: string,
  level: number,
  starred: boolean,
  rawTitle: string,
  styled: boolean,
  offset: number,
  end: number,
) {
  const name = cleanLatexText(rawTitle, scan.expand);
  if (!name) return;
  const documentTitle =
    /\\(?:my|the|@)?title\b/.test(rawTitle) || scan.titles.has(name.toLocaleLowerCase());
  const numbered = !starred && !styled && level >= 0 && level <= scan.secnumdepth;
  const leading = !scan.seenHeading && hasOnlyBoilerplateBefore(scan, offset);
  scan.seenHeading = true;
  scan.events.push({
    type: 'node',
    node: makeNode(scan.path, scan.lineOf(offset), scan.lineOf(end), {
      name,
      category: 'section',
      level,
      numbered,
      label: /\\label\s*\{([^}]+)\}/.exec(rawTitle)?.[1] ?? labelNear(scan.text, end),
      command: `${command}${starred ? '*' : ''}`,
      leading,
      documentTitle,
      appendix: scan.appendix,
    }),
  });
}

function pushStatement(
  scan: Scan,
  environment: TheoremEnvironment,
  offset: number,
  closeEnd: number,
  title: string,
  label: string,
) {
  scan.events.push({
    type: 'node',
    node: makeNode(scan.path, scan.lineOf(offset), scan.lineOf(closeEnd), {
      name: cleanLatexText(environment.display, scan.expand),
      category: 'theorem',
      detail: cleanLatexText(title, scan.expand),
      label,
      counter: environment.counter,
      within: environment.within,
    }),
  });
}

function statementEnvironment(name: string, macros: MacroTable): TheoremEnvironment | null {
  const seen = new Set<string>();
  let current = name;
  while (!seen.has(current)) {
    seen.add(current);
    const known = macros.environments.get(current);
    if (known) return known;
    const inner = macros.wrappers.get(current);
    if (!inner) break;
    current = inner;
  }
  const base = current.replace(/\*$/, '');
  if (!THEOREM_NAMES.has(base) || macros.wrappers.has(current)) return null;
  // Package-defined statements: amsthm preambles elsewhere, or a class that provides them.
  return {
    display: `${base.charAt(0).toUpperCase()}${base.slice(1)}`,
    counter: current.endsWith('*') ? null : base,
    within: null,
  };
}

function endOfEnvironment(text: string, name: string, from: number): number {
  const pattern = new RegExp(
    `\\\\(begin|end)\\s*\\{${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}`,
    'g',
  );
  pattern.lastIndex = from;
  let depth = 1;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    depth += match[1] === 'begin' ? 1 : -1;
    if (depth === 0) return match.index + match[0].length;
  }
  return text.length;
}

function scanEnvironment(scan: Scan, name: string, offset: number, inner: number): number {
  const end = endOfEnvironment(scan.text, name, inner);
  const body = scan.text.slice(inner, end);
  const label = /\\label\s*\{([^}]+)\}/.exec(body)?.[1] ?? '';
  const category: OutlineNode['category'] | null = EQUATIONS.test(name)
    ? 'equation'
    : FIGURES.test(name)
      ? 'figure'
      : TABLES.test(name)
        ? 'table'
        : null;
  if (category === 'equation') {
    // An unlabelled display is ordinary prose; only referable equations join the outline.
    if (label) {
      scan.events.push({
        type: 'node',
        node: makeNode(scan.path, scan.lineOf(offset), scan.lineOf(end), {
          name: 'Equation',
          category,
          label,
        }),
      });
    }
    return inner;
  }
  if (category) {
    const caption = /\\caption\*?\s*(?:\[[^\]]*\])?\s*\{/.exec(body);
    const captionText = caption
      ? readGroup(body, caption.index + caption[0].length - 1, '{')?.value
      : undefined;
    if (caption || label) {
      const display = category === 'figure' ? 'Figure' : 'Table';
      scan.events.push({
        type: 'node',
        node: makeNode(scan.path, scan.lineOf(offset), scan.lineOf(end), {
          name: display,
          category,
          label,
          detail: cleanLatexText(captionText ?? '', scan.expand),
          counter: display.toLowerCase(),
        }),
      });
    }
    return end;
  }
  const statement = statementEnvironment(name, scan.macros);
  if (!statement) return inner;
  const optional =
    scan.text[skipSpace(scan.text, inner)] === '[' ? readGroup(scan.text, inner, '[') : null;
  pushStatement(scan, statement, offset, end, optional?.value ?? '', label);
  return inner;
}

function scanCommand(
  scan: Scan,
  name: string,
  starText: string,
  offset: number,
  after: number,
): number {
  const { text, macros } = scan;
  if (DEFINERS.has(name)) return skipDefinition(text, name, after);
  if (name === 'appendix') {
    scan.appendix = true;
    return after;
  }
  if (name === 'setcounter') {
    const counter = readGroup(text, after, '{');
    const value = counter ? readGroup(text, counter.end, '{') : null;
    if (counter?.value === 'secnumdepth' && value) scan.secnumdepth = Number(value.value) || 0;
    return value?.end ?? after;
  }
  const builtin = SECTION_LEVELS[name];
  if (builtin !== undefined) {
    const short = readGroup(text, after, '[');
    const long = readGroup(text, short?.end ?? after, '{');
    if (!long) return after;
    const starred = starText === '*' || name.startsWith('add');
    pushHeading(scan, name, builtin, starred, short?.value || long.value, false, offset, long.end);
    return long.end;
  }
  const resolved: HeadingCommand | TheoremCommand | null = resolveCommand(name, macros);
  if (!resolved) return after;
  const call = readCallArguments(text, after, resolved.spec);
  if (resolved.kind === 'theorem') {
    const title = call.args.find(Boolean) ?? '';
    pushStatement(
      scan,
      { display: resolved.display, counter: name, within: null },
      offset,
      call.end,
      title,
      labelNear(text, call.end),
    );
    return call.end;
  }
  const title = resolved.title.replace(/#(\d)/g, (_, digit) => call.args[Number(digit) - 1] ?? '');
  pushHeading(
    scan,
    name,
    resolved.level,
    resolved.starred || call.starred || starText === '*',
    title,
    resolved.styled,
    offset,
    call.end,
  );
  return call.end;
}

/** Definitions may mention \section without producing one, so their bodies are never scanned. */
function skipDefinition(text: string, name: string, after: number): number {
  let end = after;
  if (name === 'let') {
    return (
      after + (/^\s*\\[a-zA-Z@]+\s*=?\s*\\?[a-zA-Z@]*/.exec(text.slice(after))?.[0].length ?? 0)
    );
  }
  if (/def$/.test(name)) {
    const open = text.indexOf('{', after);
    const close = open >= 0 ? closeOf(text, open) : -1;
    return close > 0 ? close : after;
  }
  const control = /^\s*\{?\\[a-zA-Z@]+\}?/.exec(text.slice(end));
  if (control) end += control[0].length;
  for (let groups = 0; groups < 8; groups++) {
    const start = skipSpace(text, end);
    const opener = text[start];
    if (opener !== '{' && opener !== '[') break;
    const close = closeOf(text, start, opener, opener === '{' ? '}' : ']');
    if (close < 0) break;
    end = close;
  }
  return end;
}

/**
 * Bold lines that stand alone act as headings in documents with no sectioning commands, such as
 * `\noindent\textbf{Part 1}\hfill\textit{Reading}\par`. Requiring two keeps a
 * single bold line, or a run-in label with text after it, from becoming a section.
 */
function scanHandWrittenHeadings(scan: Scan, envRanges: [number, number][]) {
  const pattern =
    /(?:^|\n)[ \t]*(?:\\noindent\s*)?(?:\\hypertarget\s*\{[^}]*\}\s*\{\s*)?(?:\\textbf\s*\{|\{\s*(?:\\(?:large|Large|LARGE)\s*)?\\bfseries\s)/g;
  const found: { offset: number; end: number; title: string }[] = [];
  for (let match = pattern.exec(scan.text); match; match = pattern.exec(scan.text)) {
    const offset = match.index + (match[0].startsWith('\n') ? 1 : 0);
    const open = scan.text.lastIndexOf('{', match.index + match[0].length - 1);
    if (envRanges.some(([start, end]) => offset > start && offset < end)) continue;
    const close = closeOf(scan.text, open);
    if (close < 0) continue;
    const title = scan.text.slice(open + 1, close - 1).replace(/^\s*\\bfseries\s*/, '');
    const rest = (/^[^\n]*/.exec(scan.text.slice(close))?.[0] ?? '').replace(/^\s*\}/, '');
    const standsAlone = /^\s*(?:\\hfill\b.*|\\par\b.*|\\\\.*|\\(?:small|med|big)skip\b.*)?$/.test(
      rest,
    );
    const name = cleanLatexText(title, scan.expand);
    if (!standsAlone || !name || name.length > 70 || /[.:;,?]$/.test(name)) continue;
    found.push({ offset, end: close, title });
  }
  if (found.length < 2) return;
  const nodes = found.map(({ offset, end, title }) => ({
    type: 'node' as const,
    node: makeNode(scan.path, scan.lineOf(offset), scan.lineOf(end), {
      name: cleanLatexText(title, scan.expand),
      category: 'section',
      level: 1,
      command: 'bold',
      appendix: false,
    }),
  }));
  const ordered = [...scan.events, ...nodes];
  scan.events = ordered.sort((left, right) => eventLine(left) - eventLine(right));
}

function eventLine(event: OutlineEvent): number {
  return event.type === 'node' ? event.node.line : event.line;
}

/** Scan one file's body. Definitions are collected separately, before any file is scanned. */
export function scanOutline(path: string, source: string, macros: MacroTable): OutlineEvent[] {
  const limited = source.length > MAX_SOURCE ? source.slice(0, MAX_SOURCE) : source;
  const text = maskSource(limited);
  const start = /\\begin\s*\{document\}/.exec(text);
  const bodyStart = start ? start.index + start[0].length : 0;
  const expand = (name: string) => textExpansion(name, macros);
  const scan: Scan = {
    path,
    text,
    macros,
    expand,
    titles: new Set(
      macros.titles.map((title) => cleanLatexText(title, expand).toLocaleLowerCase()),
    ),
    lineOf: buildLineIndex(limited),
    secnumdepth: 3,
    appendix: false,
    bodyStart,
    seenHeading: false,
    events: [],
  };
  const envRanges: [number, number][] = [];
  const pattern = /\\begin\s*\{([^}]+)\}|\\([a-zA-Z@]+)(\*?)/g;
  pattern.lastIndex = bodyStart;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const after = match.index + match[0].length;
    if (match[1]) {
      if (match[1] !== 'document') {
        envRanges.push([match.index, endOfEnvironment(text, match[1], after)]);
        pattern.lastIndex = scanEnvironment(scan, match[1], match.index, after);
      }
      continue;
    }
    const name = match[2] ?? '';
    if (/^(?:input|include|subfile|subfileinclude)$/.test(name)) {
      const target = readGroup(text, after, '{');
      if (target && !target.value.includes('\\')) {
        scan.events.push({
          type: 'include',
          target: target.value.trim(),
          line: scan.lineOf(match.index),
        });
      }
      pattern.lastIndex = target?.end ?? after;
      continue;
    }
    pattern.lastIndex = scanCommand(scan, name, match[3] ?? '', match.index, after);
  }
  if (!scan.seenHeading) scanHandWrittenHeadings(scan, envRanges);
  closeSections(scan);
  return scan.events;
}

/** A section runs until the next one at its level or above, or to the end of its file. */
function closeSections(scan: Scan) {
  const lastLine = scan.lineOf(scan.text.length);
  const sections = scan.events.flatMap((event) =>
    event.type === 'node' && event.node.category === 'section' ? [event.node] : [],
  );
  sections.forEach((node, index) => {
    const next = sections.slice(index + 1).find((later) => later.level <= node.level);
    node.endLine = next ? Math.max(node.line, next.line - 1) : lastLine;
  });
}

/** A once-used leading title, or anything matching the document's title, is not a section. */
function withoutDocumentHeader(nodes: OutlineNode[]): OutlineNode[] {
  const sections = nodes.filter((node) => node.category === 'section');
  const first = sections[0];
  const uses = (command: string) => sections.filter((node) => node.command === command).length;
  return nodes.filter((node) => {
    if (node.category !== 'section') return true;
    if (node.documentTitle) return false;
    return !(
      node === first &&
      node.leading &&
      !node.numbered &&
      sections.length > 1 &&
      uses(node.command) === 1
    );
  });
}

/** Levels become ranks so a document that starts at \subsection still reads from the top. */
function rankLevels(nodes: OutlineNode[]): OutlineNode[] {
  const levels = [
    ...new Set(nodes.flatMap((node) => (node.category === 'section' ? [node.level] : []))),
  ].sort((left, right) => left - right);
  return nodes.map((node) =>
    node.category === 'section' ? { ...node, level: levels.indexOf(node.level) + 1 } : node,
  );
}

/** Build the tree from nodes in document order; objects nest under the open section. */
export function buildOutline(flat: OutlineNode[]): OutlineNode[] {
  const roots: OutlineNode[] = [];
  const open: OutlineNode[] = [];
  const used = new Map<string, number>();
  for (const original of rankLevels(withoutDocumentHeader(flat))) {
    const seen = used.get(original.id) ?? 0;
    used.set(original.id, seen + 1);
    const node = {
      ...original,
      id: seen ? `${original.id}:${seen}` : original.id,
      children: [],
    };
    if (node.category === 'section') {
      while (open.length && (open.at(-1)?.level ?? 0) >= node.level) open.pop();
    }
    (open.at(-1)?.children ?? roots).push(node);
    if (node.category === 'section') open.push(node);
  }
  return roots;
}

/** Section and object numbers follow source order, the way LaTeX's counters would. */
export function numberOutline(nodes: OutlineNode[]): OutlineNode[] {
  const counters = new Map<string, number>();
  const flat: OutlineNode[] = [];
  const visit = (items: OutlineNode[]) =>
    items.forEach((item) => {
      flat.push(item);
      visit(item.children);
    });
  visit(nodes);
  const numberedLevels = flat.flatMap((node) =>
    node.category === 'section' && node.numbered ? [node.level] : [],
  );
  const base = numberedLevels.length ? Math.min(...numberedLevels) : 1;
  const sections = [0, 0, 0, 0, 0, 0];
  let appendixStarted = false;
  let topNumber = '';
  const number = (node: OutlineNode): OutlineNode => {
    let value = '';
    if (node.category === 'section' && node.numbered) {
      const index = Math.min(sections.length - 1, Math.max(0, node.level - base));
      if (node.appendix && !appendixStarted) {
        appendixStarted = true;
        sections.fill(0);
      }
      sections[index] = (sections[index] ?? 0) + 1;
      sections.fill(0, index + 1);
      const parts = sections.slice(0, index + 1).map(String);
      if (node.appendix) parts[0] = String.fromCharCode(64 + Math.min(26, sections[0] ?? 1));
      value = parts.join('.');
      if (index === 0) {
        topNumber = value;
        for (const key of counters.keys()) if (key.startsWith('within:')) counters.delete(key);
      }
    } else if (node.counter) {
      const key = node.within ? `within:${node.counter}` : node.counter;
      const next = (counters.get(key) ?? 0) + 1;
      counters.set(key, next);
      value = node.within && topNumber ? `${topNumber}.${next}` : String(next);
    }
    return { ...node, number: value, children: node.children.map(number) };
  };
  return nodes.map(number);
}
