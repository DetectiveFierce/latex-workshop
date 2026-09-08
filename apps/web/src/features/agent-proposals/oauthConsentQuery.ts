export type ParsedOAuthConsentQuery = {
  oauthQuery: string;
  clientId: string;
  clientName: string;
  scopes: string[];
};

const preservedConsentKey = 'latex-workshop:oauth-consent-query';

export function captureOAuthConsentQuery(pathname: string, search: string) {
  if (!pathname.endsWith('/oauth/consent')) return;
  const raw = search.startsWith('?') ? search.slice(1) : search;
  const params = new URLSearchParams(raw);
  if (!params.get('client_id') || !params.get('sig')) return;
  sessionStorage.setItem(preservedConsentKey, raw);
}

export function preservedOAuthConsentQuery(search: string): string {
  return sessionStorage.getItem(preservedConsentKey) ?? search;
}

export function oauthAuthorizationQuery(search: string): string | null {
  const params = new URLSearchParams(search);
  const nested = params.get('oauth_query');
  if (nested) return nested;
  if (!params.get('client_id') || !params.get('sig')) return null;
  return search.startsWith('?') ? search.slice(1) : search;
}

export function clearPreservedOAuthConsentQuery() {
  sessionStorage.removeItem(preservedConsentKey);
}

export function parseOAuthConsentQuery(search: string): ParsedOAuthConsentQuery {
  const params = new URLSearchParams(search);
  const nested = params.get('oauth_query');
  const raw = nested ?? (search.startsWith('?') ? search.slice(1) : search);
  const signed = new URLSearchParams(raw);
  const clientId = signed.get('client_id') ?? '';
  return {
    oauthQuery: raw,
    clientId,
    clientName: signed.get('client_name') ?? clientId,
    scopes: (signed.get('scope') ?? '').split(/\s+/).filter(Boolean),
  };
}
