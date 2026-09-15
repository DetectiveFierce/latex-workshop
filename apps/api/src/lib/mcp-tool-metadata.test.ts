import { describe, expect, it } from 'vitest';
import { mcpToolMetadata } from './mcp-tool-metadata.js';

describe('mcpToolMetadata', () => {
  it('advertises bounded private read access', () => {
    expect(mcpToolMetadata('read')).toEqual({
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: {
        securitySchemes: [{ type: 'oauth2', scopes: ['projects:read'] }],
      },
    });
  });

  it('advertises proposal write access without marking accepted source as destructive', () => {
    expect(mcpToolMetadata('write')).toEqual({
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: {
        securitySchemes: [{ type: 'oauth2', scopes: ['projects:read', 'proposals:write'] }],
      },
    });
  });

  it('can conservatively mark mixed organization mutations destructive and non-idempotent', () => {
    expect(mcpToolMetadata('write', { destructive: true, idempotent: false }).annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
  });
});
