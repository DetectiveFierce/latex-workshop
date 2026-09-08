import { diffLines } from 'diff';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export type ProposalLineHunk = {
  baseStart: number;
  baseEnd: number;
  baseText: string;
  replacementText: string;
};

export function splitLines(value: string): string[] {
  return value.match(/.*(?:\n|$)/g)?.filter((line) => line.length > 0) ?? [];
}

export function lineCount(value: string): number {
  if (!value) return 0;
  return (value.match(/\n/g)?.length ?? 0) + (value.endsWith('\n') ? 0 : 1);
}

export function diffLineHunks(before: string, after: string): ProposalLineHunk[] {
  const hunks: ProposalLineHunk[] = [];
  let baseLine = 0;
  let removed = '';
  let added = '';
  let start = 0;
  const flush = () => {
    if (!removed && !added) return;
    hunks.push({
      baseStart: start,
      baseEnd: start + lineCount(removed),
      baseText: removed,
      replacementText: added,
    });
    removed = '';
    added = '';
  };
  for (const part of diffLines(before, after)) {
    if (!part.added && !part.removed) {
      flush();
      baseLine += lineCount(part.value);
      continue;
    }
    if (!removed && !added) start = baseLine;
    if (part.removed) {
      removed += part.value;
      baseLine += lineCount(part.value);
    } else if (part.added) added += part.value;
  }
  flush();
  return hunks;
}

export function proposalHunkContentHash(hunk: ProposalLineHunk): string {
  return bytesToHex(
    sha256(
      new TextEncoder().encode(
        `${hunk.baseStart}\0${hunk.baseEnd}\0${hunk.baseText}\0${hunk.replacementText}`,
      ),
    ),
  );
}

function deterministicHunkId(value: string): string {
  const hash = bytesToHex(sha256(new TextEncoder().encode(value)))
    .slice(0, 32)
    .split('');
  hash[12] = '5';
  hash[16] = ['8', '9', 'a', 'b'][Number.parseInt(hash[16] ?? '0', 16) % 4] ?? '8';
  const joined = hash.join('');
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}

export function createFrozenHunks(changeId: string, before: string, after: string) {
  return diffLineHunks(before, after).map((hunk, order) => {
    const contentHash = proposalHunkContentHash(hunk);
    return {
      id: deterministicHunkId(`${changeId}\0${order}\0${contentHash}`),
      changeId,
      ...hunk,
      contentHash,
      order,
    };
  });
}

export function projectAcceptedHunks(
  base: string,
  hunks: readonly Pick<ProposalLineHunk, 'baseStart' | 'baseEnd' | 'replacementText'>[],
): string {
  const lines = splitLines(base);
  let cursor = 0;
  let result = '';
  for (const hunk of [...hunks].sort((left, right) => left.baseStart - right.baseStart)) {
    if (hunk.baseStart < cursor || hunk.baseEnd < hunk.baseStart || hunk.baseEnd > lines.length)
      throw new Error('Invalid or overlapping proposal hunks');
    result += lines.slice(cursor, hunk.baseStart).join('');
    result += hunk.replacementText;
    cursor = hunk.baseEnd;
  }
  return result + lines.slice(cursor).join('');
}
