export type TextMergeResult = { clean: true; content: string } | { clean: false; content: null };

type TextChange = { start: number; end: number; insert: string };

function changeFromBase(base: string, updated: string): TextChange | null {
  if (base === updated) return null;

  let start = 0;
  const prefixLimit = Math.min(base.length, updated.length);
  while (start < prefixLimit && base[start] === updated[start]) start += 1;

  let baseEnd = base.length;
  let updatedEnd = updated.length;
  while (baseEnd > start && updatedEnd > start && base[baseEnd - 1] === updated[updatedEnd - 1]) {
    baseEnd -= 1;
    updatedEnd -= 1;
  }

  return { start, end: baseEnd, insert: updated.slice(start, updatedEnd) };
}

/**
 * Conservatively merges one contiguous edit from each side of a common base.
 * Ambiguous or overlapping edits are deliberately rejected for user review.
 */
export function mergeText(base: string, local: string, remote: string): TextMergeResult {
  if (local === remote) return { clean: true, content: local };
  if (local === base) return { clean: true, content: remote };
  if (remote === base) return { clean: true, content: local };

  const localChange = changeFromBase(base, local)!;
  const remoteChange = changeFromBase(base, remote)!;
  const sameStart = localChange.start === remoteChange.start;
  const disjoint =
    !sameStart && (localChange.end <= remoteChange.start || remoteChange.end <= localChange.start);
  if (!disjoint) return { clean: false, content: null };

  const changes = [localChange, remoteChange].sort((a, b) => b.start - a.start);
  let content = base;
  for (const change of changes)
    content = `${content.slice(0, change.start)}${change.insert}${content.slice(change.end)}`;
  return { clean: true, content };
}
