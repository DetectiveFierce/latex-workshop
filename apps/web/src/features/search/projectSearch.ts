export type ProjectSearchSource = {
  entryId: string;
  path: string;
  content: string;
  version?: number;
};

export type ProjectSearchOptions = {
  caseSensitive: boolean;
  wholeWord: boolean;
  useRegex: boolean;
};

export type ProjectSearchResult = {
  entryId: string;
  path: string;
  line: number;
  column: number;
  endColumn: number;
  startOffset: number;
  endOffset: number;
  match: string;
  preview: string;
};

export const DEFAULT_PROJECT_SEARCH_OPTIONS: ProjectSearchOptions = {
  caseSensitive: false,
  wholeWord: false,
  useRegex: false,
};

export const MAX_PROJECT_SEARCH_RESULTS = 500;

export function projectSearchError(rawQuery: string, options: ProjectSearchOptions): string | null {
  if (!rawQuery || !options.useRegex) return null;
  try {
    new RegExp(rawQuery, options.caseSensitive ? 'g' : 'gi');
    return null;
  } catch (error) {
    return error instanceof SyntaxError
      ? error.message.replace(/^Invalid regular expression:\s*/, '')
      : 'Invalid regular expression';
  }
}

export function searchProjectSources(
  sources: ProjectSearchSource[],
  rawQuery: string,
  limit = MAX_PROJECT_SEARCH_RESULTS,
  options: ProjectSearchOptions = DEFAULT_PROJECT_SEARCH_OPTIONS,
): ProjectSearchResult[] {
  if (!rawQuery.trim() || limit <= 0 || projectSearchError(rawQuery, options)) return [];
  const results: ProjectSearchResult[] = [];

  for (const source of sources) {
    const lines = source.content.split(/\r?\n/);
    let lineStartOffset = 0;
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex]!;
      for (const match of matchesInLine(line, rawQuery, options)) {
        results.push({
          entryId: source.entryId,
          path: source.path,
          line: lineIndex + 1,
          column: match.index + 1,
          endColumn: match.index + match.text.length + 1,
          startOffset: lineStartOffset + match.index,
          endOffset: lineStartOffset + match.index + match.text.length,
          match: match.text,
          preview: line,
        });
        if (results.length >= limit) return results;
      }
      lineStartOffset +=
        line.length + newlineLengthAt(source.content, lineStartOffset + line.length);
    }
  }
  return results;
}

export function replaceProjectSourceMatches(
  source: ProjectSearchSource,
  results: ProjectSearchResult[],
  rawQuery: string,
  replacement: string,
  options: ProjectSearchOptions,
): string {
  const matching = results
    .filter((result) => result.entryId === source.entryId)
    .sort((left, right) => right.startOffset - left.startOffset);
  let content = source.content;
  for (const result of matching) {
    const value = replacementForMatch(result.match, rawQuery, replacement, options);
    content = content.slice(0, result.startOffset) + value + content.slice(result.endOffset);
  }
  return content;
}

function matchesInLine(
  line: string,
  query: string,
  options: ProjectSearchOptions,
): Array<{ index: number; text: string }> {
  if (options.useRegex) {
    const expression = new RegExp(query, options.caseSensitive ? 'g' : 'gi');
    const matches: Array<{ index: number; text: string }> = [];
    for (const match of line.matchAll(expression)) {
      const index = match.index;
      const text = match[0];
      if (index === undefined || !text || !hasWordBoundaries(line, index, text.length, options))
        continue;
      matches.push({ index, text });
    }
    return matches;
  }

  const haystack = options.caseSensitive ? line : line.toLocaleLowerCase();
  const needle = options.caseSensitive ? query : query.toLocaleLowerCase();
  const matches: Array<{ index: number; text: string }> = [];
  let offset = 0;
  while (offset <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, offset);
    if (index < 0) break;
    if (hasWordBoundaries(line, index, query.length, options))
      matches.push({ index, text: line.slice(index, index + query.length) });
    offset = index + Math.max(needle.length, 1);
  }
  return matches;
}

function hasWordBoundaries(
  line: string,
  index: number,
  length: number,
  options: ProjectSearchOptions,
) {
  if (!options.wholeWord) return true;
  const before = line[index - 1];
  const after = line[index + length];
  return (!before || !isWordCharacter(before)) && (!after || !isWordCharacter(after));
}

function isWordCharacter(value: string) {
  return /[\p{L}\p{N}_]/u.test(value);
}

function newlineLengthAt(content: string, offset: number) {
  if (content.startsWith('\r\n', offset)) return 2;
  return content[offset] === '\n' ? 1 : 0;
}

function replacementForMatch(
  match: string,
  rawQuery: string,
  replacement: string,
  options: ProjectSearchOptions,
) {
  if (!options.useRegex) return replacement;
  const expression = new RegExp(`^(?:${rawQuery})$`, options.caseSensitive ? '' : 'i');
  return match.replace(expression, replacement);
}
