const invalidName = /[\0/\\]/;

export function validateEntryName(name: string): string {
  const normalized = name.normalize('NFC').trim();
  if (!normalized || normalized === '.' || normalized === '..' || invalidName.test(normalized)) {
    throw new Error('Invalid file or folder name');
  }
  return normalized;
}

export function normalizeArchivePath(input: string): string {
  const value = input.replaceAll('\\', '/').normalize('NFC');
  if (value.startsWith('/') || /^[A-Za-z]:\//.test(value))
    throw new Error('Absolute paths are not allowed');
  const parts = value.split('/').filter(Boolean);
  if (
    !parts.length ||
    parts.some((part) => part === '.' || part === '..' || invalidName.test(part))
  ) {
    throw new Error('Unsafe archive path');
  }
  return parts.join('/');
}
