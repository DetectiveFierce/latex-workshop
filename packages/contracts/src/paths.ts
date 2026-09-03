const invalidName = /[\0/\\]/;

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function isInvalidName(value: string): boolean {
  return value === '.' || value === '..' || invalidName.test(value) || hasControlCharacter(value);
}

export function validateEntryName(name: string): string {
  const normalized = name.normalize('NFC').trim();
  if (!normalized || isInvalidName(normalized)) {
    throw new Error('Invalid file or folder name');
  }
  return normalized;
}

export function normalizeArchivePath(input: string): string {
  const value = input.replaceAll('\\', '/').normalize('NFC');
  if (value.startsWith('/') || /^[A-Za-z]:\//.test(value))
    throw new Error('Absolute paths are not allowed');
  const parts = value.split('/').filter(Boolean);
  if (!parts.length) throw new Error('Unsafe archive path');
  try {
    return parts.map(validateEntryName).join('/');
  } catch {
    throw new Error('Unsafe archive path');
  }
}

export type PathEntry = { id: string; parentId: string | null; name: string };

/** Build canonical relative paths while rejecting corrupt or cyclic trees. */
export function buildEntryPaths(rows: readonly PathEntry[]): Map<string, string> {
  const byId = new Map(rows.map((entry) => [entry.id, entry]));
  const paths = new Map<string, string>();

  const visit = (entry: PathEntry, seen = new Set<string>()): string => {
    const cached = paths.get(entry.id);
    if (cached) return cached;
    if (seen.has(entry.id)) throw new Error('Folder cycle detected');
    seen.add(entry.id);
    const name = validateEntryName(entry.name);
    if (!entry.parentId) {
      paths.set(entry.id, name);
      return name;
    }
    const parent = byId.get(entry.parentId);
    if (!parent) throw new Error('Missing parent');
    const path = `${visit(parent, seen)}/${name}`;
    paths.set(entry.id, path);
    return path;
  };

  for (const entry of rows) visit(entry);
  return paths;
}
