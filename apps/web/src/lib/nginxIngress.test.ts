import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const nginxConfig = readFileSync(new URL('../../nginx.conf', import.meta.url), 'utf8');

describe('Mind Palace ingress routes', () => {
  it.each(['/auth', '/oauth/consent'])(
    'serves the stripped %s SPA route without redirecting',
    (path) => {
      const escapedPath = path.replace('/', '\\/');
      const location = nginxConfig.match(
        new RegExp(`location = ${escapedPath} \\{(?<body>[^}]*)\\}`, 'u'),
      );

      expect(location?.groups?.body).toContain('try_files /index.html =404;');
      expect(location?.groups?.body).not.toContain('return 308');
    },
  );
});
