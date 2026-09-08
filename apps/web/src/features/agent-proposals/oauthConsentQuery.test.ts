import { describe, expect, it } from 'vitest';
import { oauthAuthorizationQuery, parseOAuthConsentQuery } from './oauthConsentQuery';

describe('parseOAuthConsentQuery', () => {
  it('reads client_id from the signed consent query on the page URL', () => {
    const parsed = parseOAuthConsentQuery(
      '?client_id=gdAMnQLlNiPJKMrUZuEMMQsqxLZcnMQK&client_name=Pi+coding+agent&scope=projects%3Aread+proposals%3Awrite&sig=abc&exp=1',
    );
    expect(parsed.clientId).toBe('gdAMnQLlNiPJKMrUZuEMMQsqxLZcnMQK');
    expect(parsed.clientName).toBe('Pi coding agent');
    expect(parsed.scopes).toEqual(['projects:read', 'proposals:write']);
    expect(parsed.oauthQuery).toContain('client_id=');
    expect(parsed.oauthQuery).toContain('sig=abc');
  });

  it('unwraps a nested oauth_query from the login redirect', () => {
    const inner = 'client_id=abc123&scope=projects%3Aread&sig=xyz&exp=9';
    const parsed = parseOAuthConsentQuery(
      `?next=%2Faccount&oauth_query=${encodeURIComponent(inner)}`,
    );
    expect(parsed.clientId).toBe('abc123');
    expect(parsed.oauthQuery).toBe(inner);
  });
});

describe('oauthAuthorizationQuery', () => {
  it('preserves a signed direct OAuth login query', () => {
    expect(oauthAuthorizationQuery('?client_id=codex&scope=projects%3Aread&sig=abc')).toBe(
      'client_id=codex&scope=projects%3Aread&sig=abc',
    );
  });

  it('unwraps a query preserved across the login redirect', () => {
    const inner = 'client_id=codex&sig=abc';
    expect(oauthAuthorizationQuery(`?oauth_query=${encodeURIComponent(inner)}`)).toBe(inner);
  });

  it('rejects ordinary authentication page queries', () => {
    expect(oauthAuthorizationQuery('?next=%2Fprojects')).toBeNull();
  });
});
