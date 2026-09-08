export function publicRequestUrl(publicBaseUrl: string, internalUrl: string): URL {
  const base = publicBaseUrl.replace(/\/+$/, '');
  const path = internalUrl.startsWith('/') ? internalUrl : `/${internalUrl}`;
  return new URL(`${base}${path}`);
}

export function publicAuthBasePath(publicBaseUrl: string): string {
  const pathname = new URL(publicBaseUrl).pathname.replace(/\/+$/, '');
  return `${pathname === '/' ? '' : pathname}/api/auth`;
}

export function publicAuthIssuerUrl(publicBaseUrl: string): string {
  return new URL(publicAuthBasePath(publicBaseUrl), new URL(publicBaseUrl).origin).href;
}

export function localAuthJwksUrl(apiPort: number): string {
  return `http://127.0.0.1:${apiPort}/api/auth/jwks`;
}

export function publicAppPageUrl(webOrigin: string, apiOrigin: string, path: string): string {
  const origin = new URL(webOrigin).origin;
  const basePath = new URL(apiOrigin).pathname.replace(/\/+$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${origin}${basePath === '/' ? '' : basePath}${suffix}`;
}

export function publicMcpResourceUrl(apiOrigin: string): string {
  return `${apiOrigin.replace(/\/+$/, '')}/api/mcp`;
}

/** RFC 8414 / RFC 9728 discovery is origin-rooted even when the app lives under a subpath. */
export function publicWellKnownUrl(apiOrigin: string, rawUrl: string): URL {
  return new URL(rawUrl, new URL(apiOrigin).origin);
}
