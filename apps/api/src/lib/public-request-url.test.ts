import { describe, expect, it } from 'vitest';
import {
  canonicalWellKnownRequestUrl,
  localAuthJwksUrl,
  pathAwareProtectedResourceMetadataPath,
  publicAppPageUrl,
  publicAuthBasePath,
  publicAuthIssuerUrl,
  publicMcpResourceUrl,
  protectedResourceMetadataUrl,
  publicRequestUrl,
  publicWellKnownUrl,
} from './public-request-url.js';

describe('publicRequestUrl', () => {
  it('preserves a public application subpath for internal auth routes', () => {
    expect(
      publicRequestUrl(
        'https://mind-palace/latex-workshop',
        '/api/auth/get-session?disableCookieCache=true',
      ).toString(),
    ).toBe('https://mind-palace/latex-workshop/api/auth/get-session?disableCookieCache=true');
  });

  it('normalizes one separator between the public base and internal route', () => {
    expect(
      publicRequestUrl('https://mind-palace/latex-workshop/', 'api/auth/sign-in').toString(),
    ).toBe('https://mind-palace/latex-workshop/api/auth/sign-in');
  });
});

describe('publicAuthBasePath', () => {
  it('includes the application subpath in the Better Auth router base', () => {
    expect(publicAuthBasePath('https://mind-palace/latex-workshop')).toBe(
      '/latex-workshop/api/auth',
    );
  });

  it('uses the standard auth path when the application is root-hosted', () => {
    expect(publicAuthBasePath('http://localhost:3001/')).toBe('/api/auth');
  });
});

describe('publicAuthIssuerUrl', () => {
  it('keeps a path-mounted deployment in the OAuth issuer URL', () => {
    expect(publicAuthIssuerUrl('https://mind-palace/latex-workshop')).toBe(
      'https://mind-palace/latex-workshop/api/auth',
    );
  });

  it('uses the origin for a root-mounted deployment', () => {
    expect(publicAuthIssuerUrl('http://localhost:3001/')).toBe('http://localhost:3001/api/auth');
  });
});

describe('localAuthJwksUrl', () => {
  it('fetches signing keys through the API loopback route', () => {
    expect(localAuthJwksUrl(3001)).toBe('http://127.0.0.1:3001/api/auth/jwks');
  });
});

describe('publicAppPageUrl', () => {
  it('keeps OAuth pages under the application subpath', () => {
    expect(
      publicAppPageUrl('https://mind-palace', 'https://mind-palace/latex-workshop', '/auth'),
    ).toBe('https://mind-palace/latex-workshop/auth');
    expect(
      publicAppPageUrl(
        'https://mind-palace',
        'https://mind-palace/latex-workshop',
        '/oauth/consent',
      ),
    ).toBe('https://mind-palace/latex-workshop/oauth/consent');
  });

  it('uses the web origin when the API is hosted at root', () => {
    expect(
      publicAppPageUrl('https://workshop.example.com', 'https://workshop.example.com', '/auth'),
    ).toBe('https://workshop.example.com/auth');
  });
});

describe('publicMcpResourceUrl', () => {
  it('places the MCP resource under the public API base', () => {
    expect(publicMcpResourceUrl('https://mind-palace/latex-workshop')).toBe(
      'https://mind-palace/latex-workshop/api/mcp',
    );
    expect(publicMcpResourceUrl('https://workshop.example.com/')).toBe(
      'https://workshop.example.com/api/mcp',
    );
  });
});

describe('path-aware protected resource discovery', () => {
  it('derives the RFC 9728 well-known path from a path-mounted MCP URL', () => {
    expect(pathAwareProtectedResourceMetadataPath('https://mind-palace/latex-workshop')).toBe(
      '/.well-known/oauth-protected-resource/latex-workshop/api/mcp',
    );
  });

  it('routes the path-aware alias to the MCP plugin canonical handler', () => {
    expect(
      canonicalWellKnownRequestUrl(
        'https://mind-palace/latex-workshop',
        '/.well-known/oauth-protected-resource/latex-workshop/api/mcp?probe=1',
      ),
    ).toBe('/.well-known/oauth-protected-resource?probe=1');
  });

  it('routes the root-hosted MCP compatibility alias to the canonical handler', () => {
    expect(
      canonicalWellKnownRequestUrl(
        'https://workshop.example.com',
        '/.well-known/oauth-protected-resource/api/mcp',
      ),
    ).toBe('/.well-known/oauth-protected-resource');
  });

  it('leaves authorization-server discovery paths unchanged', () => {
    expect(
      canonicalWellKnownRequestUrl(
        'https://mind-palace/latex-workshop',
        '/.well-known/oauth-authorization-server/latex-workshop/api/auth',
      ),
    ).toBe('/.well-known/oauth-authorization-server/latex-workshop/api/auth');
  });
});

describe('protectedResourceMetadataUrl', () => {
  it('builds the RFC 9728 path-aware discovery URL for the tunnel resource', () => {
    expect(
      protectedResourceMetadataUrl('https://tunnel-service.example/v1/mcp/tunnel_0123456789abcdef'),
    ).toBe(
      'https://tunnel-service.example/.well-known/oauth-protected-resource/v1/mcp/tunnel_0123456789abcdef',
    );
  });
});

describe('publicWellKnownUrl', () => {
  it('keeps OAuth discovery on the origin even when the API has a subpath', () => {
    expect(
      publicWellKnownUrl(
        'https://mind-palace/latex-workshop',
        '/.well-known/oauth-protected-resource/latex-workshop/api/mcp',
      ).toString(),
    ).toBe('https://mind-palace/.well-known/oauth-protected-resource/latex-workshop/api/mcp');
  });
});
