export type ProjectSearchSource = {
  entryId: string;
  path: string;
  content: string;
};

export type ProjectSearchResult = {
  entryId: string;
  path: string;
  line: number;
  column: number;
  endColumn: number;
  preview: string;
};

export const MAX_PROJECT_SEARCH_RESULTS = 500;

export function searchProjectSources(
  sources: ProjectSearchSource[],
  rawQuery: string,
  limit = MAX_PROJECT_SEARCH_RESULTS,
): ProjectSearchResult[] {
  const query = rawQuery.trim();
  if (!query || limit <= 0) return [];
  const needle = query.toLocaleLowerCase();
  const results: ProjectSearchResult[] = [];

  for (const source of sources) {
    const lines = source.content.split(/\r?\n/);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex]!;
      const haystack = line.toLocaleLowerCase();
      let offset = 0;
      while (offset <= haystack.length - needle.length) {
        const match = haystack.indexOf(needle, offset);
        if (match < 0) break;
        results.push({
          entryId: source.entryId,
          path: source.path,
          line: lineIndex + 1,
          column: match + 1,
          endColumn: match + query.length + 1,
          preview: line.trim() || line,
        });
        if (results.length >= limit) return results;
        offset = match + Math.max(needle.length, 1);
      }
    }
  }
  return results;
}
