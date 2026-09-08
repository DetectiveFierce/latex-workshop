import { describe, expect, it } from 'vitest';
import { serializeAuthProxyBody } from './auth-proxy-body.js';

describe('serializeAuthProxyBody', () => {
  it('reconstructs OAuth form bodies after Fastify parsing', () => {
    expect(
      serializeAuthProxyBody('application/x-www-form-urlencoded; charset=utf-8', {
        grant_type: 'authorization_code',
        scope: ['projects:read', 'proposals:write'],
      })?.toString(),
    ).toBe('grant_type=authorization_code&scope=projects%3Aread&scope=proposals%3Awrite');
  });

  it('keeps JSON auth requests as JSON', () => {
    expect(serializeAuthProxyBody('application/json', { email: 'owner@example.test' })).toBe(
      '{"email":"owner@example.test"}',
    );
  });
});
