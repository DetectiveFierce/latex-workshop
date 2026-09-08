import { describe, expect, it } from 'vitest';
import {
  localAuthJwksUrl,
  publicAppPageUrl,
  publicAuthBasePath,
  publicAuthIssuerUrl,
  publicMcpResourceUrl,
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
