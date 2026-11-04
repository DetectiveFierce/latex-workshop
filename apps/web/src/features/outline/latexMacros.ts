import { closeOf, maskSource, readGroup, skipSpace } from './latexText';

export const SECTION_LEVELS: Record<string, number> = {
  part: -1,
  chapter: 0,
  addchap: 0,
  section: 1,
  addsec: 1,
  subsection: 2,
  subsubsection: 3,
};
export const THEOREM_NAMES = new Set([
  'theorem',
  'lemma',
  'proposition',
  'corollary',
  'definition',
  'conjecture',
  'claim',
  'example',
  'exercise',
  'problem',
  'question',
  'remark',
  'result',
]);
const SHORT_THEOREM_NAMES: Record<string, string> = {
  thm: 'theorem',
  lem: 'lemma',
  prop: 'proposition',
  cor: 'corollary',
  defn: 'definition',
  conj: 'conjecture',
  prob: 'problem',
  ex: 'example',
  rem: 'remark',
};

/** How the arguments of a command appear at its call site: s star, o optional, m mandatory. */
export type ArgumentSpec = ('s' | 'o' | 'm')[];
export type HeadingCommand = {
  kind: 'heading';
  level: number;
  starred: boolean;
  title: string;
  spec: ArgumentSpec;
  /** A styled title rather than a real sectioning command. */
  styled: boolean;
};
export type TheoremCommand = { kind: 'theorem'; display: string; spec: ArgumentSpec };
export type TheoremEnvironment = {
  display: string;
  counter: string | null;
  within: string | null;
};
type RawCommand = { body: string; spec: ArgumentSpec };

export type MacroTable = {
  commands: Map<string, RawCommand>;
  aliases: Map<string, string>;
  environments: Map<string, TheoremEnvironment>;
  wrappers: Map<string, string>;
  sectionClasses: Map<string, number>;
  titles: string[];
};
export function emptyMacroTable(): MacroTable {
  return {
    commands: new Map(),
    aliases: new Map(),
    environments: new Map(),
    wrappers: new Map(),
    sectionClasses: new Map(),
    titles: [],
  };
}

function specFromCount(count: number, hasOptional: boolean): ArgumentSpec {
  return Array.from({ length: count }, (_, index) => (hasOptional && index === 0 ? 'o' : 'm'));
}

/** xparse argument specs, keeping only the shapes that consume call-site source. */
function specFromXparse(spec: string): ArgumentSpec {
  const result: ArgumentSpec = [];
  for (const match of spec.matchAll(/([a-zA-Z])\s*(\{[^{}]*\})?/g)) {
    const letter = match[1] ?? '';
    if (letter === 's') result.push('s');
    else if (/[oOdD]/.test(letter)) result.push('o');
    else if (/[mrRgG]/.test(letter)) result.push('m');
  }
  return result;
}

function readControlName(text: string, from: number): { name: string; end: number } | null {
  const start = skipSpace(text, from);
  const braced = text[start] === '{';
  const match = /^\\([a-zA-Z@]+)/.exec(text.slice(braced ? start + 1 : start));
  if (!match?.[1]) return null;
  const after = (braced ? start + 1 : start) + match[0].length;
  return { name: match[1], end: braced ? closeOf(text, start) : after };
}

function theoremDisplay(name: string, fallback?: string): string {
  const word = SHORT_THEOREM_NAMES[name] ?? name;
  const text = fallback?.trim() || word;
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

function collectCommands(text: string, table: MacroTable) {
  for (const match of text.matchAll(
    /\\(?:re)?(?:newcommand|providecommand)\*?|\\DeclareRobustCommand\*?/g,
  )) {
    const control = readControlName(text, match.index + match[0].length);
    if (!control) continue;
    const count = readGroup(text, control.end, '[');
    const optional = count ? readGroup(text, count.end, '[') : null;
    const body = readGroup(text, optional?.end ?? count?.end ?? control.end, '{');
    if (!body) continue;
    table.commands.set(control.name, {
      body: body.value,
      spec: specFromCount(Number(count?.value ?? 0) || 0, Boolean(optional)),
    });
  }
  for (const match of text.matchAll(/\\(?:g|e|x)?def\s*\\([a-zA-Z@]+)((?:#\d)*)\s*\{/g)) {
    const open = match.index + match[0].length - 1;
    const close = closeOf(text, open);
    if (close < 0 || !match[1]) continue;
    table.commands.set(match[1], {
      body: text.slice(open + 1, close - 1),
      spec: specFromCount((match[2]?.length ?? 0) / 2, false),
    });
  }
  for (const match of text.matchAll(
    /\\(?:New|Renew|Declare|Provide)(?:Expandable)?DocumentCommand/g,
  )) {
    const control = readControlName(text, match.index + match[0].length);
    if (!control) continue;
    const spec = readGroup(text, control.end, '{');
    const body = spec ? readGroup(text, spec.end, '{') : null;
    if (spec && body) {
      table.commands.set(control.name, { body: body.value, spec: specFromXparse(spec.value) });
    }
  }
  for (const match of text.matchAll(/\\let\s*\\([a-zA-Z@]+)\s*=?\s*\\([a-zA-Z@]+)/g)) {
    if (match[1] && match[2]) table.aliases.set(match[1], match[2]);
  }
}

function collectSectionClasses(text: string, table: MacroTable) {
  for (const match of text.matchAll(/\\@startsection\s*\{([a-zA-Z@]+)\}\s*\{(-?\d+)\}/g)) {
    if (match[1]) table.sectionClasses.set(match[1], Number(match[2]));
  }
  for (const match of text.matchAll(
    /\\titleclass\s*\{?\\([a-zA-Z@]+)\}?\s*\{[^}]*\}\s*\[(-?\d)\]/g,
  )) {
    if (match[1]) table.sectionClasses.set(match[1], Number(match[2]) + 1);
  }
  for (const match of text.matchAll(
    /\\DeclareSectionCommand\s*\[[^\]]*level=(-?\d+)[^\]]*\]\s*\{([a-zA-Z@]+)\}/g,
  )) {
    if (match[2]) table.sectionClasses.set(match[2], Number(match[1]));
  }
}

function collectEnvironments(text: string, table: MacroTable) {
  for (const match of text.matchAll(
    /\\newtheorem(\*?)\s*\{([^}]+)\}\s*(?:\[([^\]]+)\])?\s*\{((?:[^{}]|\{[^{}]*\})*)\}\s*(?:\[([^\]]+)\])?/g,
  )) {
    if (!match[2]) continue;
    table.environments.set(match[2], {
      display: match[4] ?? theoremDisplay(match[2]),
      counter: match[1] ? null : (match[3] ?? match[2]),
      within: match[5] ?? (match[3] ? (table.environments.get(match[3])?.within ?? null) : null),
    });
  }
  for (const match of text.matchAll(/\\declaretheorem\s*(?:\[([^\]]*)\])?\s*\{([^}]+)\}/g)) {
    if (!match[2]) continue;
    const display = /name\s*=\s*\{?([^,}\]]+)/.exec(match[1] ?? '')?.[1];
    table.environments.set(match[2], {
      display: display?.trim() || theoremDisplay(match[2]),
      counter: match[2],
      within: /within\s*=\s*(\w+)/.exec(match[1] ?? '')?.[1] ?? null,
    });
  }
  // tcolorbox environments only count as outline objects when named like a statement.
  for (const match of text.matchAll(/\\(?:re)?newtcolorbox\s*(\[[^\]]*\])?\s*\{([^}]+)\}/g)) {
    const name = match[2] ?? '';
    const canonical = SHORT_THEOREM_NAMES[name] ?? name;
    if (!THEOREM_NAMES.has(canonical)) continue;
    table.environments.set(name, {
      display: theoremDisplay(name),
      counter: /auto counter|use counter/.test(match[1] ?? '') ? name : null,
      within: null,
    });
  }
  for (const match of text.matchAll(
    /\\(?:re)?newtcbtheorem\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}\s*\{([^}]*)\}/g,
  )) {
    if (!match[1]) continue;
    table.environments.set(match[1], {
      display: match[2] || theoremDisplay(match[1]),
      counter: match[1],
      within: null,
    });
  }
  // Wrapper environments inherit the statement they open.
  for (const match of text.matchAll(
    /\\(?:(?:re)?newenvironment\s*\{([^}]+)\}(?:\s*\[\d\])?(?:\s*\[[^\]]*\])?|(?:New|Renew|Declare|Provide)DocumentEnvironment\s*\{([^}]+)\}\s*\{[^}]*\})\s*\{/g,
  )) {
    const name = match[1] ?? match[2];
    const open = match.index + match[0].length - 1;
    const close = closeOf(text, open);
    if (!name || close < 0) continue;
    const inner = /\\begin\s*\{([^}]+)\}/.exec(text.slice(open, close))?.[1];
    if (inner && inner !== name) table.wrappers.set(name, inner);
  }
}

function collectTitles(text: string, table: MacroTable) {
  const title = /\\title\s*(?:\[[^\]]*\])?\s*\{/.exec(text);
  if (title) {
    const value = readGroup(text, title.index + title[0].length - 1, '{')?.value;
    if (value) table.titles.push(value);
  }
  const pdfTitle = /pdftitle\s*=\s*\{/.exec(text);
  if (pdfTitle) {
    const value = readGroup(text, pdfTitle.index + pdfTitle[0].length - 1, '{')?.value;
    if (value) table.titles.push(value);
  }
}

/** Record every definition in preamble-level source. Later definitions replace earlier ones. */
export function collectMacros(source: string, table: MacroTable): void {
  const text = maskSource(source);
  collectCommands(text, table);
  collectSectionClasses(text, table);
  collectEnvironments(text, table);
  collectTitles(text, table);
}

const FONT_SIZE = /\\(?:large|Large|LARGE|huge|Huge)\b/;
const BOLD = /\\(?:bfseries|textbf)\b/;
const BLOCK_BREAK = /\\(?:par\b|bigskip|medskip|vspace|newpage|clearpage)|\\\\/;

function substituteArguments(template: string, args: string[]): string {
  return template.replace(/#(\d)/g, (hash, digit) => args[Number(digit) - 1] ?? hash);
}

/**
 * Follow a command's definition to what it finally produces, so `\newpart` → `\pagehead` or
 * `\mainhead` → `\@mainhead` → `\section` all resolve. The visit list
 * stops recursive definitions and depth keeps pathological chains bounded.
 */
export function resolveCommand(
  name: string,
  table: MacroTable,
  visited: Set<string> = new Set(),
): HeadingCommand | TheoremCommand | null {
  const alias = table.aliases.get(name);
  if (alias && !table.commands.has(name)) {
    const builtin = SECTION_LEVELS[alias];
    if (builtin !== undefined) {
      return {
        kind: 'heading',
        level: builtin,
        starred: false,
        title: '#2',
        spec: ['o', 'm'],
        styled: false,
      };
    }
    return resolveCommand(alias, table, visited);
  }
  const definition = table.commands.get(name);
  if (!definition || visited.has(name) || visited.size > 16) return null;
  visited.add(name);
  const body = definition.body;
  const custom = table.sectionClasses.get(name);
  if (custom !== undefined) {
    return {
      kind: 'heading',
      level: custom,
      starred: false,
      title: '#2',
      spec: ['o', 'm'],
      styled: false,
    };
  }
  const pattern = /\\([a-zA-Z@]+)(\*?)/g;
  for (let match = pattern.exec(body); match; match = pattern.exec(body)) {
    const called = match[1] ?? '';
    const start = match.index + match[0].length;
    const level = SECTION_LEVELS[called];
    if (level !== undefined) {
      const short = readGroup(body, start, '[');
      const long = readGroup(body, short?.end ?? start, '{');
      if (long) {
        return {
          kind: 'heading',
          level,
          starred: match[2] === '*',
          title: short?.value || long.value,
          spec: definition.spec,
          styled: false,
        };
      }
    }
    if (table.commands.has(called) || table.aliases.has(called)) {
      const inner = resolveCommand(called, table, new Set(visited));
      if (inner?.kind === 'heading') {
        const args: string[] = [];
        let end = start;
        for (const type of inner.spec) {
          const group = readGroup(body, end, type === 'o' ? '[' : '{');
          if (type === 'm' && !group) break;
          args.push(group?.value ?? '');
          if (group) end = group.end;
        }
        // A call without arguments delegates, so the caller's own arguments feed the target.
        return {
          ...inner,
          title: substituteArguments(inner.title, args),
          spec: [
            ...definition.spec,
            ...inner.spec.slice(Math.max(args.length, definition.spec.length)),
          ],
        };
      }
    }
  }
  const canonical = SHORT_THEOREM_NAMES[name] ?? name;
  if (THEOREM_NAMES.has(canonical) && /\\(?:ref)?stepcounter/.test(body)) {
    return { kind: 'theorem', display: theoremDisplay(name), spec: definition.spec };
  }
  // A title the author styled by hand: large or bold text that stands on its own line.
  const titleArgument = definition.spec.lastIndexOf('m') + 1;
  if (
    titleArgument > 0 &&
    definition.spec.length <= 2 &&
    body.includes(`#${titleArgument}`) &&
    BLOCK_BREAK.test(body) &&
    (FONT_SIZE.test(body) || BOLD.test(body))
  ) {
    return {
      kind: 'heading',
      level: 1,
      starred: true,
      title: `#${titleArgument}`,
      spec: definition.spec,
      styled: true,
    };
  }
  return null;
}

/** A zero-argument definition that is plain text, used to read titles such as `\doctitle`. */
export function textExpansion(name: string, table: MacroTable): string | undefined {
  const definition = table.commands.get(name);
  return definition && definition.spec.length === 0 ? definition.body : undefined;
}
