import { describe, expect, it } from 'vitest';
import { publicAuthBasePath, publicRequestUrl } from './public-request-url.js';

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
