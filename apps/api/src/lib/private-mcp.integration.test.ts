import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { loadConfig } from '@latex-workshop/config';
import { agentClientPolicies, checkpoints, oauthClients, users } from '@latex-workshop/db';
import { createContext, type AppContext } from './context.js';
import { createBlankProject } from './project-creation.js';
import { editAgentProject } from './agent-edits.js';
import { getAgentProjectTree, readAgentTextFile } from './agent-proposals.js';
import { registerMcpRoutes } from '../routes/mcp.js';
import { registerHistoryRoutes } from '../routes/history.js';
import { tailnetClientId, tunnelClientId } from './tailnet-auth.js';

const databaseUrl = process.env.AGENT_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('private MCP and atomic edits (PostgreSQL)', () => {
  let context: AppContext;
  const app = Fastify();
  const ownerId = randomUUID();
  const ownerEmail = `private-${ownerId}@example.test`;
  const otherId = randomUUID();
  let projectId: string;
  let otherProjectId: string;
  const tailnetKey = 'a'.repeat(64);
  const tunnelKey = 'b'.repeat(64);
  const identity = { userId: ownerId, clientId: tailnetClientId, clientName: 'Test device' };
  const privateHeaders = {
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2025-06-18',
    'content-type': 'application/json',
    'x-workshop-tailnet-key': tailnetKey,
    'tailscale-user-login': ownerEmail,
  };
  beforeAll(async () => {
    if (!databaseUrl || !new URL(databaseUrl).pathname.startsWith('/agent_regression_'))
      throw new Error('Requires a disposable agent_regression_* database');
    context = createContext({
      ...loadConfig(),
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl,
      REDIS_URL: 'redis://127.0.0.1:6379/14',
      AGENT_MCP_ENABLED: true,
      AGENT_MCP_RESOURCE_URL: 'http://localhost:3001/api/mcp',
      AGENT_MCP_TAILNET_KEY: tailnetKey,
      AGENT_MCP_TUNNEL_KEY: tunnelKey,
      AGENT_MCP_PRIVATE_OWNER_EMAIL: ownerEmail,
    });
    await context.client.unsafe('truncate table users, projects, oauth_clients cascade');
    await context.storage.ensureBucket();
    await context.db.insert(users).values([
      { id: ownerId, name: 'Private owner', email: ownerEmail, emailVerified: true },
      { id: otherId, name: 'Other owner', email: `${otherId}@example.test`, emailVerified: true },
    ]);
    for (const clientId of [tailnetClientId, tunnelClientId]) {
      await context.db
        .insert(oauthClients)
        .values({ id: randomUUID(), clientId, userId: ownerId, redirectUris: [] });
      await context.db
        .insert(agentClientPolicies)
        .values({ userId: ownerId, clientId, allProjects: true });
    }
    projectId = (await createBlankProject(context, ownerId, 'Private test', null)).id;
    otherProjectId = (await createBlankProject(context, otherId, 'Other test', null)).id;
    await registerMcpRoutes(app, context);
    await registerHistoryRoutes(app, context);
  });
  afterAll(async () => {
    await app.close();
    if (!context) return;
    await context.db
      .delete(oauthClients)
      .where(inArray(oauthClients.clientId, [tailnetClientId, tunnelClientId]));
    await context.db.delete(users).where(eq(users.id, ownerId));
    await context.db.delete(users).where(eq(users.id, otherId));
    await Promise.all([context.queue.close(), context.pdfRenderQueue.close()]);
    await context.redis.quit();
    await context.client.end();
  });
  async function rpc(
    method: string,
    params: Record<string, unknown>,
    headers: Record<string, string> = privateHeaders,
  ) {
    return app.inject({
      method: 'POST',
      url: '/api/mcp',
      headers,
      payload: { jsonrpc: '2.0', id: randomUUID(), method, params },
    });
  }
  function message(body: string): unknown {
    const data =
      body
        .split('\n')
        .find((line) => line.startsWith('data:'))
        ?.slice(5)
        .trim() ?? body;
    return JSON.parse(data);
  }
  it('serves noauth discovery only with a valid private transport identity', async () => {
    const response = await rpc('tools/list', {});
    expect(response.statusCode).toBe(200);
    const parsed = z
      .object({
        result: z.object({
          tools: z.array(
            z.object({
              _meta: z.object({ securitySchemes: z.array(z.object({ type: z.string() })) }),
            }),
          ),
        }),
      })
      .parse(message(response.body));
    expect(parsed.result.tools.length).toBeGreaterThan(10);
    expect(
      parsed.result.tools.every((tool) => tool._meta.securitySchemes[0]?.type === 'noauth'),
    ).toBe(true);
    const forged = await rpc(
      'tools/call',
      { name: 'list_projects', arguments: {} },
      { ...privateHeaders, 'x-workshop-tailnet-key': 'forged' },
    );
    expect(forged.statusCode).toBe(401);
    const browser = await rpc(
      'tools/list',
      {},
      { ...privateHeaders, origin: 'https://evil.example' },
    );
    expect(browser.statusCode).toBe(401);
  });
  it('authenticates the hosted tunnel despite an expired user token and preserves tenant isolation', async () => {
    const response = await rpc(
      'tools/call',
      { name: 'list_projects', arguments: {} },
      {
        accept: privateHeaders.accept,
        'content-type': 'application/json',
        'mcp-protocol-version': '2025-06-18',
        'x-workshop-tunnel-key': tunnelKey,
        authorization: 'Bearer expired-user-token',
      },
    );
    expect(response.statusCode).toBe(200);
    const parsed = z
      .object({
        result: z.object({
          structuredContent: z.object({ projects: z.array(z.object({ id: z.string() })) }),
        }),
      })
      .parse(message(response.body));
    expect(parsed.result.structuredContent.projects.map((project) => project.id)).toEqual([
      projectId,
    ]);
    const foreign = await rpc('tools/call', {
      name: 'get_project_tree',
      arguments: { projectId: otherProjectId },
    });
    expect(
      z.object({ result: z.object({ isError: z.boolean() }) }).parse(message(foreign.body)).result
        .isError,
    ).toBe(true);
  });
  it('honors revocation immediately and never recreates revoked policies', async () => {
    await context.db
      .update(agentClientPolicies)
      .set({ tokensRevokedAt: new Date() })
      .where(
        and(
          eq(agentClientPolicies.userId, ownerId),
          eq(agentClientPolicies.clientId, tailnetClientId),
        ),
      );
    expect((await rpc('tools/list', {})).statusCode).toBe(401);
    await context.db
      .delete(agentClientPolicies)
      .where(
        and(
          eq(agentClientPolicies.userId, ownerId),
          eq(agentClientPolicies.clientId, tailnetClientId),
        ),
      );
    expect((await rpc('tools/list', {})).statusCode).toBe(401);
    await context.db
      .insert(agentClientPolicies)
      .values({ userId: ownerId, clientId: tailnetClientId, allProjects: true });
  });
  it('applies one atomic edit, preserves empty folders and the original main file in its checkpoint, and replays safely', async () => {
    const tree = await getAgentProjectTree(context, identity, projectId);
    const file = await readAgentTextFile(context, identity, {
      projectId,
      path: 'main.tex',
      offset: 0,
      limit: 4096,
    });
    const input = {
      projectId,
      expectedSourceRevision: tree.sourceRevision,
      title: 'Regression edit',
      idempotencyKey: randomUUID(),
      files: [
        { path: 'main.tex', content: file.content + '\n% private edit\n', baseHash: file.hash },
      ],
      structure: [{ operation: 'create_folder' as const, targetPath: 'empty-folder' }],
    };
    const result = await editAgentProject(context, identity, input);
    expect(result.applied).toBe(true);
    expect(result.undoCheckpointId).toBeTruthy();
    expect(result.entries.some((entry) => entry.path === 'empty-folder')).toBe(true);
    const [checkpoint] = await context.db
      .select()
      .from(checkpoints)
      .where(eq(checkpoints.id, result.undoCheckpointId ?? randomUUID()));
    expect(checkpoint?.mainFilePath).toBe('main.tex');
    expect(checkpoint?.manifest.find((entry) => entry.path === 'main.tex')?.blobHash).toBe(
      file.hash,
    );
    expect((await editAgentProject(context, identity, input)).replayed).toBe(true);
    await expect(
      editAgentProject(context, identity, { ...input, title: 'Changed payload' }),
    ).rejects.toThrow('different edit');
    await expect(
      editAgentProject(context, identity, { ...input, idempotencyKey: randomUUID() }),
    ).rejects.toThrow('Project changed');
  });
});
