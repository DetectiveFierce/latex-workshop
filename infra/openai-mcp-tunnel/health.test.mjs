import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const run = promisify(execFile);
const composePath = fileURLToPath(new URL('./compose.yml', import.meta.url));

// Exercise the actual Compose probe with the pinned image. A live local listener
// must not make a tunnel with no successful OpenAI poll look connected.
test('tunnel health requires readiness and a recent control-plane poll', async (t) => {
  const { stdout } = await run(
    'docker',
    ['compose', '-f', composePath, 'config', '--format', 'json'],
    {
      env: {
        ...process.env,
        OPENAI_TUNNEL_ID: 'tunnel_00000000000000000000000000000000',
        PRIVATE_MCP_URL: 'https://example.invalid/mcp',
        CADDY_ROOT_CA_PATH: '/etc/ssl/certs/ca-certificates.crt',
        TUNNEL_IMAGE_TAG: '0.0.16',
      },
    },
  );
  const service = JSON.parse(stdout).services['tunnel-client'];
  const [kind, executable, ...probe] = service.healthcheck.test;
  assert.equal(kind, 'CMD');

  let readyStatus = 200;
  let metricsStatus = 200;
  let metrics = '';
  const server = createServer((request, response) => {
    if (request.url === '/metrics') {
      response.writeHead(metricsStatus).end(metrics);
    } else {
      response.writeHead(request.url === '/readyz' ? readyStatus : 200).end('ready');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  assert.equal(probe.length, 1);
  probe[0] = `http://127.0.0.1:${address.port}`;

  const now = Math.floor(Date.now() / 1000);

  for (const fixture of [
    { name: 'no polls', metric: '0', expected: 1 },
    { name: 'recent successful poll', metric: String(now), expected: 0 },
    { name: 'scientific timestamp', metric: now.toExponential(), expected: 0 },
    { name: 'stale poll', metric: String(now - 120), expected: 1 },
    { name: 'future timestamp', metric: String(now + 120), expected: 1 },
    { name: 'malformed timestamp', metric: 'NaN', expected: 1 },
    { name: 'missing poll metric', metric: null, expected: 1 },
    { name: 'unready MCP', metric: String(now), ready: 503, expected: 1 },
    { name: 'unavailable metrics', metric: String(now), metrics: 503, expected: 1 },
  ]) {
    await t.test(fixture.name, async () => {
      readyStatus = fixture.ready ?? 200;
      metricsStatus = fixture.metrics ?? 200;
      metrics =
        fixture.metric === null
          ? ''
          : `commands_poll_last_successful_timestamp_seconds ${fixture.metric}\n`;
      let exitCode = 0;
      try {
        await run('docker', [
          'run',
          '--rm',
          '--network=host',
          '--entrypoint',
          executable,
          service.image,
          ...probe,
        ]);
      } catch (error) {
        exitCode = error.code;
      }
      assert.equal(exitCode, fixture.expected);
    });
  }
});
