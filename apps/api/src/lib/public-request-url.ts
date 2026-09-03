export function publicRequestUrl(publicBaseUrl: string, internalUrl: string): URL {
  const base = publicBaseUrl.replace(/\/+$/, '');
  const path = internalUrl.startsWith('/') ? internalUrl : `/${internalUrl}`;
  return new URL(`${base}${path}`);
}

export function publicAuthBasePath(publicBaseUrl: string): string {
  const pathname = new URL(publicBaseUrl).pathname.replace(/\/+$/, '');
  return `${pathname === '/' ? '' : pathname}/api/auth`;
}
