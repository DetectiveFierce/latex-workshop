import { describe, expect, it } from 'vitest';
import { codexCompatibleAuthorizationMetadata } from './oauth-metadata-compat.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe('codexCompatibleAuthorizationMetadata', () => {
  it('disables required authorization-response issuer handling in discovery metadata', () => {
    const result = codexCompatibleAuthorizationMetadata(
      '/.well-known/oauth-authorization-server/latex-workshop/api/auth',
      encoder.encode(
        JSON.stringify({
          issuer: 'https://workshop.example/api/auth',
          authorization_response_iss_parameter_supported: true,
        }),
      ),
    );
    expect(JSON.parse(decoder.decode(result))).toEqual({
      issuer: 'https://workshop.example/api/auth',
      authorization_response_iss_parameter_supported: false,
    });
  });

  it('leaves protected-resource metadata and malformed responses unchanged', () => {
    const protectedResource = encoder.encode('{"resource":"https://workshop.example/api/mcp"}');
    expect(
      codexCompatibleAuthorizationMetadata(
        '/.well-known/oauth-protected-resource/api/mcp',
        protectedResource,
      ),
    ).toBe(protectedResource);
    const malformed = encoder.encode('not json');
    expect(
      codexCompatibleAuthorizationMetadata('/api/auth/.well-known/openid-configuration', malformed),
    ).toBe(malformed);
  });
});
