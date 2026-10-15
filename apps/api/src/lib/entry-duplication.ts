import { buildEntryPaths, type PathEntry } from '@latex-workshop/contracts';

export function orderEntriesForDuplication<T extends PathEntry>(
  projectEntries: readonly T[],
  subtreeIds: ReadonlySet<string>,
): T[] {
  // Nested subtree roots still reference ancestors outside the duplicated subtree.
  const paths = buildEntryPaths(projectEntries);
  const depth = (entry: T) => {
    const path = paths.get(entry.id);
    if (!path) throw new Error('Entry path is missing');
    return path.split('/').length;
  };
  return projectEntries
    .filter((entry) => subtreeIds.has(entry.id))
    .sort((left, right) => depth(left) - depth(right));
}
