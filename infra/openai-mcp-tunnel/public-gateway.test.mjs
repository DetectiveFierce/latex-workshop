import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const run = promisify(execFile);
const nginxImage =
  'nginx:1.29-alpine@sha256:5616878291a2eed594aee8db4dade5878cf7edcb475e59193904b198d9b830de';
const nodeImage =
  'node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e';

test('public MCP gateway exposes OAuth and MCP without private transport privileges', async (t) => {
  const network = `workshop-gateway-test-${randomUUID()}`;
  const api = `${network}-api`;
  const gateway = `${network}-nginx`;
  const directory = await mkdtemp(join(tmpdir(), 'workshop-gateway-test-'));
  t.after(async () => {
    await Promise.allSettled([
      run('docker', ['rm', '-f', api]),
      run('docker', ['rm', '-f', gateway]),
    ]);
    await run('docker', ['network', 'rm', network]).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(
    join(directory, 'api.mjs'),
    `import { createServer } from 'node:http';
createServer((request,response)=>{
  const authorized=request.headers.authorization==='Bearer fixture-token';
  response.writeHead(request.url==='/api/mcp'&&!authorized?401:200,{'Content-Type':'application/json'});
  response.end(JSON.stringify({path:request.url,headers:request.headers}));
}).listen(3001,'0.0.0.0');`,
  );
  await run('docker', ['network', 'create', network]);
  await run('docker', [
    'run',
    '-d',
    '--name',
    api,
    '--network',
    network,
    '--network-alias',
    'latex-workshop-api-1',
    '-v',
    `${directory}:/fixture:ro`,
    nodeImage,
    'node',
    '/fixture/api.mjs',
  ]);
  const configuration = fileURLToPath(new URL('../../apps/web/public-mcp.conf', import.meta.url));
  await run('docker', [
    'run',
    '-d',
    '--name',
    gateway,
    '--network',
    network,
    '-p',
    '127.0.0.1::8090',
    '-v',
    `${configuration}:/etc/nginx/nginx.conf:ro`,
    nginxImage,
  ]);
  const { stdout } = await run('docker', ['inspect', gateway]);
  const binding = JSON.parse(stdout)[0].NetworkSettings.Ports['8090/tcp'][0];
  const origin = `http://127.0.0.1:${binding.HostPort}`;
  await t.test('listener becomes ready', async () => {
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        ready = (await fetch(`${origin}/health/live`)).ok;
      } catch {
        /* container startup */
      }
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(ready);
  });
  for (const path of [
    '/',
    '/latex-workshop/',
    '/api/v1/projects',
    '/api/mcp/private',
    '/latex-workshop/api/mcp/private',
    '/api/auth/sign-in/email',
    '/api/auth/get-session',
  ]) {
    await t.test(`keeps ${path} private`, async () => {
      assert.equal((await fetch(origin + path)).status, 404);
    });
  }
  await t.test(
    'strips forged private credentials while preserving bearer authentication',
    async () => {
      const headers = {
        'X-Workshop-Tunnel-Key': 'forged-tunnel-key',
        'X-Workshop-Tailnet-Key': 'forged-tailnet-key',
        'Tailscale-User-Login': 'owner@example.test',
      };
      assert.equal(
        (await fetch(`${origin}/latex-workshop/api/mcp`, { method: 'POST', headers })).status,
        401,
      );
      const response = await fetch(`${origin}/latex-workshop/api/mcp`, {
        method: 'POST',
        headers: { ...headers, Authorization: 'Bearer fixture-token' },
      });
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.equal(data.path, '/api/mcp');
      assert.equal(data.headers.authorization, 'Bearer fixture-token');
      for (const name of [
        'x-workshop-tunnel-key',
        'x-workshop-tailnet-key',
        'tailscale-user-login',
      ]) {
        assert.equal(data.headers[name], undefined);
      }
    },
  );
  for (const path of [
    '/.well-known/oauth-protected-resource/latex-workshop/api/mcp',
    '/.well-known/oauth-authorization-server/latex-workshop/api/auth',
    '/latex-workshop/api/auth/oauth2/register',
    '/latex-workshop/api/auth/oauth2/token',
    '/latex-workshop/api/auth/oauth2/authorize',
    '/latex-workshop/api/auth/jwks',
    '/latex-workshop/api/auth/oauth2/userinfo',
  ]) {
    await t.test(`routes ${path}`, async () => {
      assert.equal((await fetch(origin + path)).status, 200);
    });
  }
});
