import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const nginxConfig = readFileSync(new URL('../../nginx.conf', import.meta.url), 'utf8');

describe('nginx service discovery', () => {
  it('resolves replaceable Docker service containers at request time', () => {
    expect(nginxConfig).toContain('resolver 127.0.0.11 valid=10s ipv6=off;');
    expect(nginxConfig).toContain('set $api_upstream http://api:3001;');
    expect(nginxConfig).toContain('set $language_service_upstream http://language-service:3002;');
    expect(nginxConfig).not.toMatch(/proxy_pass http:\/\/(?:api|language-service):/);
    expect(nginxConfig.match(/proxy_pass \$api_upstream;/g)).toHaveLength(2);
    expect(nginxConfig.match(/proxy_pass \$language_service_upstream;/g)).toHaveLength(1);
  });
});
