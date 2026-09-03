import type { PdfSyncResult, SourceSelection, SyncTexRecord } from '@latex-workshop/contracts';

const numericKeys = new Set([
  'Page',
  'x',
  'y',
  'h',
  'v',
  'W',
  'H',
  'D',
  'Line',
  'Column',
  'Offset',
]);

export function parseSyncTexRecords(output: string): SyncTexRecord[] {
  const records: Array<Record<string, string>> = [];
  let current: Record<string, string> = {};
  const flush = () => {
    if (Object.keys(current).length) records.push(current);
    current = {};
  };
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line || /^SyncTeX result (?:begin|end)$/.test(line)) continue;
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (key === 'Output' && Object.keys(current).length) flush();
    current[key] = value;
  }
  flush();
  return records.flatMap((record) => {
    for (const key of numericKeys) {
      if (record[key] !== undefined && !Number.isFinite(Number(record[key]))) return [];
    }
    const page = Number(record.Page);
    const x = Number(record.x);
    const y = Number(record.y);
    if (
      !Number.isInteger(page) ||
      page < 1 ||
      page > 100_000 ||
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      Math.abs(x) > 10_000_000 ||
      Math.abs(y) > 10_000_000
    )
      return [];
    const optionalNumber = (key: string) =>
      record[key] === undefined || record[key] === '' ? null : Number(record[key]);
    const line = optionalNumber('Line');
    const column = optionalNumber('Column');
    const offset = optionalNumber('Offset');
    if (
      [line, column, offset].some(
        (value) => value !== null && (!Number.isInteger(value) || value < 0),
      ) ||
      ['W', 'H', 'D'].some((key) => {
        const value = optionalNumber(key);
        return value !== null && (value < 0 || value > 10_000_000);
      })
    )
      return [];
    return [
      {
        page,
        x,
        y,
        h: optionalNumber('h'),
        v: optionalNumber('v'),
        W: optionalNumber('W'),
        H: optionalNumber('H'),
        D: optionalNumber('D'),
        input: record.Input ?? null,
        line,
        column,
        before: record.Before ?? null,
        offset,
        middle: record.Middle ?? null,
        after: record.After ?? null,
      } satisfies SyncTexRecord,
    ];
  });
}

export function recordToPdfResult(
  record: SyncTexRecord,
  input: {
    artifactStale: boolean;
    sourceFileChangedSinceCompile: boolean;
    selectedText: string;
    usedContext: boolean;
  },
): PdfSyncResult {
  const boxX = record.h ?? record.x;
  const boxBaseline = record.v ?? record.y;
  const boxHeight = Math.max(0, record.H ?? 0);
  const depth = Math.max(0, record.D ?? 0);
  const width = Math.max(1, record.W ?? 1);
  const height = Math.max(1, boxHeight + depth);
  const container = !printableSelection(input.selectedText);
  return {
    point: { page: record.page, x: Math.max(0, record.x), y: Math.max(0, record.y) },
    rect: {
      page: record.page,
      x: Math.max(0, boxX),
      y: Math.max(0, boxBaseline - boxHeight),
      width,
      height,
    },
    path: normalizeSyncPath(record.input),
    line: record.line,
    column: record.column,
    matchKind: container ? 'container' : input.usedContext ? 'text' : 'point',
    confidence: input.sourceFileChangedSinceCompile
      ? 'approximate'
      : input.usedContext
        ? 'context'
        : 'exact',
    artifactStale: input.artifactStale,
    sourceFileChangedSinceCompile: input.sourceFileChangedSinceCompile,
    selectedText: input.selectedText || null,
  };
}

export function normalizeSyncPath(value: string | null) {
  return value?.replace(/^.*?\/workspace\//, '').replace(/^\.\//, '') ?? null;
}

export function findSyncTexInput(syncText: string, path: string) {
  const normalized = normalizeSyncPath(path);
  for (const line of syncText.split(/\r?\n/)) {
    const match = line.match(/^Input:\d+:(.*)$/);
    if (match && normalizeSyncPath(match[1]!) === normalized) return match[1]!;
  }
  return path;
}

export function contentHint(selected: string, before = '', after = ''): string | null {
  const words = (value: string) => value.match(/[\p{L}\p{N}][\p{L}\p{N}_.:-]*/gu) ?? [];
  const middle = words(selected)[0];
  const previous = words(before).at(-1) ?? '';
  const next = words(after)[0] ?? '';
  if (!middle) return null;
  const offset = Math.max(0, selected.indexOf(middle));
  return `${previous}/${offset}:${middle}/${next}`;
}

export function printableSelection(value: string) {
  return Boolean(value.match(/[\p{L}\p{N}]/u)) && !/^\\(?:begin|end)\b/.test(value.trim());
}

export function rankSyncRecords(
  records: SyncTexRecord[],
  input: { path: string; line: number; pageHint?: number; selectedText?: string },
) {
  const selectedText = input.selectedText;
  return records
    .map((record, order) => {
      let score = -order;
      if (normalizeSyncPath(record.input) === normalizeSyncPath(input.path)) score += 1_000;
      if (input.pageHint && record.page === input.pageHint) score += 300;
      if (record.line !== null) score += Math.max(0, 200 - Math.abs(record.line - input.line));
      if (
        selectedText &&
        [record.before, record.middle, record.after].some((value) => value?.includes(selectedText))
      )
        score += 150;
      return { record, score, order };
    })
    .sort((left, right) => right.score - left.score || left.order - right.order)
    .map(({ record }) => record);
}

export function alignSelectionToCompiled(
  currentSource: string,
  compiledSource: string,
  selection: SourceSelection,
): SourceSelection {
  if (currentSource === compiledSource) return selection;
  const selected = selection.text || sliceSelection(currentSource, selection);
  const currentOffset = offsetAt(currentSource, selection.start);
  const expected = currentSource.length
    ? Math.round((currentOffset / currentSource.length) * compiledSource.length)
    : 0;
  const occurrences = selected ? findOccurrences(compiledSource, selected, 500) : [];
  let compiledOffset: number | null = null;
  if (occurrences.length) {
    const beforeToken = words(selection.before ?? '').at(-1);
    const afterToken = words(selection.after ?? '')[0];
    compiledOffset = occurrences
      .map((offset) => {
        const vicinityBefore = compiledSource.slice(Math.max(0, offset - 200), offset);
        const vicinityAfter = compiledSource.slice(
          offset + selected.length,
          offset + selected.length + 200,
        );
        const contextScore =
          (beforeToken && vicinityBefore.includes(beforeToken) ? 1_000 : 0) +
          (afterToken && vicinityAfter.includes(afterToken) ? 1_000 : 0);
        return { offset, score: contextScore - Math.abs(offset - expected) };
      })
      .sort((left, right) => right.score - left.score)[0]!.offset;
  }
  if (compiledOffset === null) {
    const currentLines = currentSource.split('\n');
    const compiledLines = compiledSource.split('\n');
    const lineIndex = selection.start.line - 1;
    const anchors: Array<{ distance: number; currentLine: number; compiledLine: number }> = [];
    for (let distance = 0; distance <= 200; distance += 1) {
      for (const candidate of [lineIndex - distance, lineIndex + distance]) {
        const line = currentLines[candidate]?.trim();
        if (!line) continue;
        const matches = compiledLines.flatMap((value, index) =>
          value.trim() === line ? [index] : [],
        );
        if (matches.length === 1)
          anchors.push({ distance, currentLine: candidate, compiledLine: matches[0]! });
      }
      if (anchors.length) break;
    }
    const anchor = anchors[0];
    const estimatedLine = anchor
      ? anchor.compiledLine + (lineIndex - anchor.currentLine)
      : Math.round((lineIndex / Math.max(1, currentLines.length - 1)) * (compiledLines.length - 1));
    const line = Math.max(0, Math.min(compiledLines.length - 1, estimatedLine));
    compiledOffset = offsetAt(compiledSource, {
      line: line + 1,
      column: Math.min(selection.start.column, (compiledLines[line]?.length ?? 0) + 1),
    });
  }
  const start = positionAt(compiledSource, compiledOffset);
  const end = positionAt(compiledSource, compiledOffset + selected.length);
  const lineContent = compiledSource.split('\n')[start.line - 1] ?? '';
  return {
    start,
    end,
    text: selected,
    before: lineContent.slice(0, start.column - 1),
    after: lineContent.slice(end.line === start.line ? end.column - 1 : lineContent.length),
  };
}

export function structuralSourceAnchors(
  source: string,
  selection: SourceSelection,
): SourceSelection[] {
  if (printableSelection(selection.text) && !selection.text.trim().startsWith('\\'))
    return [selection];
  const offset = offsetAt(source, selection.start);
  const ranges: Array<{ start: number; end: number }> = [];
  const commandStart = source.lastIndexOf('\\', offset);
  if (commandStart >= 0) {
    const command = source.slice(commandStart, offset + 200).match(/^\\[A-Za-z@]+\*?\s*\{/);
    if (command) {
      const brace = commandStart + command[0].lastIndexOf('{');
      const end = matchingBrace(source, brace);
      if (end > brace && offset <= end) ranges.push({ start: brace + 1, end });
    }
  }
  const begin = source.lastIndexOf('\\begin{', offset);
  if (begin >= 0) {
    const nameEnd = source.indexOf('}', begin + 7);
    if (nameEnd >= 0) {
      const name = source.slice(begin + 7, nameEnd);
      const end = source.indexOf(`\\end{${name}}`, nameEnd + 1);
      if (end >= offset) ranges.push({ start: nameEnd + 1, end });
    }
  }
  ranges.push({ start: Math.max(0, offset - 300), end: Math.min(source.length, offset + 300) });
  const anchors: SourceSelection[] = [];
  const seen = new Set<number>();
  for (const range of ranges) {
    const fragment = source.slice(range.start, range.end);
    const candidates = [...fragment.matchAll(/[\p{L}\p{N}]+/gu)]
      .map((match) => ({ match, startOffset: range.start + match.index }))
      .sort(
        (left, right) => Math.abs(left.startOffset - offset) - Math.abs(right.startOffset - offset),
      );
    for (const { match, startOffset } of candidates) {
      if (seen.has(startOffset)) continue;
      if (source[startOffset - 1] === '\\') continue;
      const text = match[0];
      if (/^(?:begin|end|label|ref|cite)$/i.test(text)) continue;
      seen.add(startOffset);
      anchors.push(selectionAt(source, startOffset, text));
      if (anchors.length >= 4) return anchors;
    }
  }
  return anchors.length ? anchors : [selection];
}

export function unionSyncResults(results: PdfSyncResult[]): PdfSyncResult | null {
  const first = results[0];
  if (!first) return null;
  const samePage = results.filter((result) => result.rect.page === first.rect.page);
  const left = Math.min(...samePage.map((result) => result.rect.x));
  const top = Math.min(...samePage.map((result) => result.rect.y));
  const right = Math.max(...samePage.map((result) => result.rect.x + result.rect.width));
  const bottom = Math.max(...samePage.map((result) => result.rect.y + result.rect.height));
  return {
    ...first,
    rect: { page: first.rect.page, x: left, y: top, width: right - left, height: bottom - top },
    matchKind: results.length > 1 ? 'container' : first.matchKind,
  };
}

function words(value: string) {
  return value.match(/[\p{L}\p{N}][\p{L}\p{N}_.:-]*/gu) ?? [];
}

function findOccurrences(source: string, value: string, limit: number) {
  const offsets: number[] = [];
  let from = 0;
  while (offsets.length < limit) {
    const offset = source.indexOf(value, from);
    if (offset < 0) break;
    offsets.push(offset);
    from = offset + Math.max(1, value.length);
  }
  return offsets;
}

function offsetAt(source: string, position: { line: number; column: number }) {
  const lines = source.split('\n');
  let offset = 0;
  for (let index = 0; index < Math.min(lines.length, position.line - 1); index += 1)
    offset += lines[index]!.length + 1;
  return Math.min(source.length, offset + Math.max(0, position.column - 1));
}

function positionAt(source: string, offset: number) {
  const prefix = source.slice(0, Math.max(0, Math.min(source.length, offset)));
  const lines = prefix.split('\n');
  return { line: lines.length, column: lines.at(-1)!.length + 1 };
}

function selectionAt(source: string, offset: number, text: string): SourceSelection {
  const start = positionAt(source, offset);
  const end = positionAt(source, offset + text.length);
  const line = source.split('\n')[start.line - 1] ?? '';
  return {
    start,
    end,
    text,
    before: line.slice(0, start.column - 1),
    after: line.slice(end.column - 1),
  };
}

function sliceSelection(source: string, selection: SourceSelection) {
  return source.slice(offsetAt(source, selection.start), offsetAt(source, selection.end));
}

function matchingBrace(source: string, open: number) {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{' && source[index - 1] !== '\\') depth += 1;
    if (source[index] === '}' && source[index - 1] !== '\\') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}
