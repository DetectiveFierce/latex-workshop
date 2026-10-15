import type { SourceSelection } from '@latex-workshop/contracts';

export type InverseSyncRecord = { input: string; line: number; column: number | null };

export function parseInverseSyncRecords(output: string): InverseSyncRecord[] {
  if (output.length > 256 * 1024) return [];
  const records: InverseSyncRecord[] = [];
  let current: Record<string, string> = {};
  const flush = () => {
    const line = Number(current.Line);
    const column = current.Column === undefined ? -1 : Number(current.Column);
    if (
      records.length < 256 &&
      current.Input &&
      current.Input.length <= 1_024 &&
      Number.isSafeInteger(line) &&
      line > 0 &&
      line <= 10_000_000 &&
      Number.isSafeInteger(column) &&
      column >= -1 &&
      column <= 10_000_000
    )
      records.push({ input: current.Input, line, column: column > 0 ? column : null });
    current = {};
  };
  for (const raw of output.split(/\r?\n/)) {
    if (records.length >= 256) break;
    const separator = raw.indexOf(':');
    if (separator < 1) continue;
    const key = raw.slice(0, separator);
    if ((key === 'Output' || key === 'Input') && current.Input) flush();
    current[key] = raw.slice(separator + 1).trim();
  }
  flush();
  return records;
}

export function resolveInversePath<T extends { path: string }>(
  input: string,
  manifest: readonly T[],
) {
  const value = input.replaceAll('\\', '/');
  const workspace = value.indexOf('/workspace/');
  const relative = workspace >= 0 ? value.slice(workspace + '/workspace/'.length) : value;
  if (relative.startsWith('/') || /^[A-Za-z]:/.test(relative)) return null;
  const parts: string[] = [];
  for (const part of relative.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  const path = parts.join('/');
  return manifest.find((entry) => entry.path === path) ?? null;
}

type Token = { word: string; start: number; end: number };
const wordPattern = /[\p{L}\p{N}]+/gu;
const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase('en-US');
function tokens(value: string, source = false): Token[] {
  const pattern = source ? /\\[A-Za-z@]+\*?|%[^\n]*|[\p{L}\p{N}]+/gu : wordPattern;
  return Array.from(value.matchAll(pattern)).flatMap((match) =>
    source && /^[\\%]/.test(match[0])
      ? []
      : [{ word: normalize(match[0]), start: match.index, end: match.index + match[0].length }],
  );
}

export function sourceSelectionForPdf(
  source: string,
  line: number,
  text = '',
  before = '',
  after = '',
): { selection: SourceSelection; matched: boolean } {
  const lineStarts = [0];
  for (let index = 0; index < source.length; index += 1)
    if (source[index] === '\n') lineStarts.push(index + 1);
  const anchor = Math.max(0, Math.min(lineStarts.length - 1, line - 1));
  const anchorOffset = lineStarts[anchor] ?? 0;
  const windowStart = Math.max(lineStarts[Math.max(0, anchor - 80)] ?? 0, anchorOffset - 32_768);
  const windowEnd = Math.min(lineStarts[anchor + 81] ?? source.length, anchorOffset + 32_768);
  const window = source.slice(windowStart, windowEnd);
  const position = (offset: number) => {
    const bounded = Math.max(0, Math.min(source.length, offset));
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if ((lineStarts[middle] ?? 0) <= bounded) low = middle;
      else high = middle - 1;
    }
    return { line: low + 1, column: bounded - (lineStarts[low] ?? 0) + 1 };
  };
  const selected = tokens(text).slice(0, 256);
  const windowTokens = tokens(window, true);
  const anchorToken = windowTokens.findIndex((token) => token.start >= anchorOffset - windowStart);
  const firstToken = Math.max(0, (anchorToken < 0 ? windowTokens.length : anchorToken) - 4_096);
  const candidates = windowTokens.slice(firstToken, firstToken + 8_192);
  const previous = tokens(before)
    .slice(-6)
    .map((token) => token.word);
  const following = tokens(after)
    .slice(0, 6)
    .map((token) => token.word);
  let best: { start: number; end: number; score: number } | null = null;
  if (selected.length) {
    for (let index = 0; index < candidates.length; index += 1) {
      if (!selected.every((token, offset) => candidates[index + offset]?.word === token.word))
        continue;
      const start = candidates[index];
      const end = candidates[index + selected.length - 1];
      if (!start || !end) continue;
      const candidateLine = position(windowStart + start.start).line;
      let score = -Math.abs(candidateLine - line);
      for (let offset = 0; offset < previous.length; offset += 1)
        if (candidates[index - previous.length + offset]?.word === previous[offset]) score += 100;
      for (let offset = 0; offset < following.length; offset += 1)
        if (candidates[index + selected.length + offset]?.word === following[offset]) score += 100;
      if (!best || score > best.score)
        best = { start: windowStart + start.start, end: windowStart + end.end, score };
    }
  }
  // Rendered math and user-defined commands can break a full phrase match.
  // Retain a distinctive prose clause instead of falling back to a paragraph's
  // final SyncTeX line, often many lines after the highlighted sentence.
  if (!best && selected.length >= 3) {
    for (let offset = 0; offset < Math.min(8, selected.length - 2); offset += 1) {
      for (let index = 0; index < candidates.length; index += 1) {
        let length = 0;
        while (
          length < 32 &&
          selected[offset + length]?.word === candidates[index + length]?.word &&
          selected[offset + length] &&
          candidates[index + length]
        )
          length += 1;
        if (length < 3) continue;
        const start = candidates[index];
        const end = candidates[index + length - 1];
        if (!start || !end) continue;
        const score = length * 1_000 - Math.abs(position(windowStart + start.start).line - line);
        if (!best || score > best.score)
          best = { start: windowStart + start.start, end: windowStart + end.end, score };
      }
    }
  }
  const start = best?.start ?? anchorOffset;
  const end = best?.end ?? Math.max(start, (lineStarts[anchor + 1] ?? source.length + 1) - 1);
  return {
    matched: Boolean(best),
    selection: {
      start: position(start),
      end: position(end),
      text: source.slice(start, end).slice(0, 2_000),
      before: source.slice(Math.max(0, start - 200), start),
      after: source.slice(end, end + 200),
    },
  };
}
