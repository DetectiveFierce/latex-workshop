import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { requireMcpAuth } from '@better-auth/mcp';
import {
  agentPdfPageRequestSchema,
  agentPdfPageResponseSchema,
  agentProjectTreeSchema,
  agentProposalLimits,
  agentProposalResponseSchema,
  agentProposalSchema,
  compileJobSchema,
  createAgentProjectSchema,
  proposeAgentStructureSchema,
  putAgentProposalFileSchema,
  readTextFileSchema,
  renameAgentProjectSchema,
  startAgentProposalSchema,
} from '@latex-workshop/contracts';
import { agentClientPolicies, oauthClients } from '@latex-workshop/db';
import { and, eq } from 'drizzle-orm';
import type { AppContext } from '../lib/context.js';
import {
  finishAgentProposal,
  getAgentClientProposal,
  getAgentProposalCompile,
  getAgentProjectTree,
  listGrantedProjects,
  proposeAgentStructure,
  putAgentProposalFile,
  readAgentTextFile,
  requestProposalCompilation,
  startAgentProposal,
  waitForAgentProposalCompile,
} from '../lib/agent-proposals.js';
import { renderAgentProposalPdfPages } from '../lib/agent-pdf-pages.js';
import { createAgentProject, renameAgentProject } from '../lib/agent-projects.js';
import {
  editLatexWorkshopProjectPrompt,
  mindPalaceEditingGuide,
  mindPalaceEditingGuideUri,
  mindPalaceMcpInstructions,
  mindPalaceMcpServerName,
  projectScopeRule,
} from '../lib/mcp-agent-guide.js';
import {
  localAuthJwksUrl,
  publicAuthIssuerUrl,
  publicRequestUrl,
} from '../lib/public-request-url.js';
import { incrementMetric } from '../lib/operational-metrics.js';
import { isOAuthTokenAfterRevocation } from '../lib/agent-proposal-policy.js';
import { mcpHandlerOptions } from '../lib/mcp-transport.js';

const finishAgentProposalSchema = z.object({
  proposalId: z.uuid().describe('Proposal id returned by start_proposal'),
  expectedProposalRevision: z
    .number()
    .int()
    .nonnegative()
    .describe('Revision from the immediately preceding proposal response'),
  idempotencyKey: z
    .uuid()
    .describe('Fresh UUID for this request; reuse only to retry the exact same operation'),
});
const getProposalSchema = z.object({
  proposalId: z.uuid().describe('Proposal id returned by start_proposal'),
});
const getTreeSchema = z.object({
  projectId: z.uuid().describe('Project id selected from list_projects'),
});
const editProjectPromptSchema = z.object({
  project: z.string().trim().min(1).max(120).describe('Exact displayed Mind Palace project name'),
  change: z.string().trim().min(1).max(20_000).describe('The user-requested outcome to implement'),
});
const listProjectsOutputSchema = z.object({
  scopeRule: z.string(),
  projectCreationTool: z.literal('create_project'),
  projects: z.array(
    z.object({
      id: z.uuid().describe('Use this id in project-scoped tools'),
      name: z.string().describe('Displayed Mind Palace project name'),
      sourceRevision: z.number().int().nonnegative(),
      compiler: z.enum(['pdflatex', 'xelatex', 'lualatex']),
      isTemplate: z.boolean(),
    }),
  ),
});
const projectTreeOutputSchema = agentProjectTreeSchema.extend({ scopeRule: z.string() });
const agentProjectSummarySchema = listProjectsOutputSchema.shape.projects.element;
const createProjectOutputSchema = z.object({
  project: agentProjectSummarySchema,
  proposal: agentProposalSchema,
  compile: compileJobSchema.nullable(),
  nextAction: z.string(),
});
const renameProjectOutputSchema = z.object({ project: agentProjectSummarySchema });
const finishProposalOutputSchema = agentProposalSchema.extend({
  compile: compileJobSchema.nullable(),
});
const proposalCompileOutputSchema = z.object({ job: compileJobSchema.nullable() });
const readTextOutputSchema = z.object({
  path: z.string(),
  content: z.string(),
  offset: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().nullable(),
  version: z.number().int().nonnegative(),
  hash: z.string().length(64),
});
const tokenClaimsSchema = z
  .object({
    sub: z.string().min(1),
    client_id: z.string().min(1).optional(),
    azp: z.string().min(1).optional(),
    scope: z.union([z.string(), z.array(z.string())]),
    exp: z.number(),
  })
  .passthrough()
  .refine((claims) => claims.client_id !== undefined || claims.azp !== undefined, {
    message: 'Missing OAuth client identity',
  });

function jsonResult(value: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function scopesFromClaims(claims: z.infer<typeof tokenClaimsSchema>): string[] {
  return Array.isArray(claims.scope) ? claims.scope : claims.scope.split(/\s+/).filter(Boolean);
}

async function createServer(context: AppContext, claims: unknown) {
  const parsed = tokenClaimsSchema.parse(claims);
  const clientId = parsed.client_id ?? parsed.azp;
  if (!clientId) throw new Error('OAuth client identity is missing');
  const [client] = await context.db
    .select({ name: oauthClients.name })
    .from(oauthClients)
    .where(eq(oauthClients.clientId, clientId))
    .limit(1);
  const identity = { userId: parsed.sub, clientId, clientName: client?.name ?? clientId };
  const scopes = new Set(scopesFromClaims(parsed));
  const requireWrite = () => {
    if (!scopes.has('proposals:write')) throw new Error('The proposals:write scope is required');
  };
  const server = new McpServer(
    { name: mindPalaceMcpServerName, version: '0.5.0' },
    { instructions: mindPalaceMcpInstructions },
  );

  const compileReview = async (
    proposal: z.infer<typeof agentProposalSchema>,
    signal?: AbortSignal,
  ) => {
    if (proposal.status !== 'reviewing') return null;
    const queued = await requestProposalCompilation(context, identity, proposal.id, {
      expectedProposalRevision: proposal.revision,
      idempotencyKey: randomUUID(),
    });
    if (!queued.compileJobId) return null;
    return waitForAgentProposalCompile(context, identity, proposal.id, queued.compileJobId, signal);
  };

  server.registerResource(
    'agent-editing-guide',
    mindPalaceEditingGuideUri,
    {
      title: 'How to manage and edit Mind Palace LaTeX Workshop projects',
      description:
        'Authoritative top-level project/template scope rules, proposal workflow, compile results, and owner handoff.',
      mimeType: 'text/markdown',
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: mindPalaceEditingGuide }],
    }),
  );
  server.registerPrompt(
    'edit_latex_workshop_project',
    {
      title: 'Edit a Mind Palace LaTeX Workshop project',
      description:
        'Resolve a site-hosted project, implement a requested change as a compiled proposal, and hand it to the owner for review.',
      argsSchema: editProjectPromptSchema,
    },
    ({ project, change }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: editLatexWorkshopProjectPrompt(project, change),
          },
        },
      ],
    }),
  );

  server.registerTool(
    'list_projects',
    {
      title: 'List granted projects',
      description:
        'START HERE. Projects and templates are top-level Library items, not files. If the user asks to create/add/make a new project or template, inspect any referenced source as needed and then MUST call create_project; NEVER start_proposal on the source and NEVER create a .tex file there. If asked to rename a top-level item, use rename_project. This result repeats the mandatory scope rule and identifies templates with isTemplate=true.',
      inputSchema: z.object({}),
      outputSchema: listProjectsOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async () =>
      jsonResult({
        scopeRule: projectScopeRule,
        projectCreationTool: 'create_project',
        projects: await listGrantedProjects(context, identity),
      }),
  );
  server.registerTool(
    'create_project',
    {
      title: 'Create NEW TOP-LEVEL project or template',
      description:
        'THE ONLY TOOL that creates a top-level project or template. A template is NOT a .tex file. For a blank project, omit sourceProjectId and use isTemplate=false. For a normal project copied from a template, pass its id and use isTemplate=false. For a new reusable template, use isTemplate=true and optionally pass a source project id. Example: “new template Homework based on MA 711” means name=Homework, sourceProjectId=<MA 711>, isTemplate=true. Further placeholder edits MUST target the returned proposal/new projectId, never MA 711. Metadata is immediate; seeded source awaits acceptance. No confirmation is required.',
      inputSchema: createAgentProjectSchema,
      outputSchema: createProjectOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (raw, requestContext) => {
      requireWrite();
      const created = await createAgentProject(
        context,
        identity,
        createAgentProjectSchema.parse(raw),
      );
      return jsonResult({
        ...created,
        compile: await compileReview(created.proposal, requestContext.mcpReq.signal),
        nextAction:
          'If the user requested further content customization, mutate and re-finish the returned proposal for this NEW project. Never start or mutate a proposal on sourceProjectId.',
      });
    },
  );
  server.registerTool(
    'rename_project',
    {
      title: 'Rename TOP-LEVEL project or template',
      description:
        'THE ONLY TOOL for renaming a top-level project/template Library item. This is different from propose_structure, which only renames files/folders inside a project. Renaming takes effect immediately without a proposal or confirmation.',
      inputSchema: renameAgentProjectSchema,
      outputSchema: renameProjectOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (raw) => {
      requireWrite();
      const project = await renameAgentProject(
        context,
        identity,
        renameAgentProjectSchema.parse(raw),
      );
      return jsonResult({ project });
    },
  );
  server.registerTool(
    'get_project_tree',
    {
      title: 'Get project tree',
      description:
        'Inspect files inside one project. If this project is only a formatting source for a requested NEW project/template, treat it as read-only reference material and call create_project after inspection; NEVER start_proposal on this source. Returns paths, hashes/versions, and editable flags.',
      inputSchema: getTreeSchema,
      outputSchema: projectTreeOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async (raw) => {
      const { projectId } = getTreeSchema.parse(raw);
      return jsonResult({
        ...(await getAgentProjectTree(context, identity, projectId)),
        scopeRule: projectScopeRule,
      });
    },
  );
  server.registerTool(
    'read_text_file',
    {
      title: 'Read source file',
      description:
        'Read accepted UTF-8 source from a Mind Palace project. Continue with nextOffset until null. Preserve hash as baseHash when replacing this file in a proposal so accepted-source drift becomes an explicit conflict.',
      inputSchema: readTextFileSchema,
      outputSchema: readTextOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async (raw) =>
      jsonResult(await readAgentTextFile(context, identity, readTextFileSchema.parse(raw))),
  );
  server.registerTool(
    'start_proposal',
    {
      title: 'Start proposal',
      description:
        'Edit FILES/FOLDERS INSIDE an existing project only. This tool CANNOT create a top-level project or template. If the user said create/add/make a new project/template, do not call this on the source project—call create_project, then customize the proposal returned by create_project.',
      inputSchema: startAgentProposalSchema,
      outputSchema: agentProposalSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (raw) => {
      requireWrite();
      const input = startAgentProposalSchema.parse(raw);
      return jsonResult(await startAgentProposal(context, identity, input));
    },
  );
  server.registerTool(
    'put_proposal_file',
    {
      title: 'Put proposal file',
      description:
        'Create or replace a UTF-8 FILE INSIDE the proposal’s existing project. This never creates a top-level project/template. content must be the complete file. For a newly created project/template, use the proposal returned by create_project—not a proposal on its sourceProjectId.',
      inputSchema: putAgentProposalFileSchema.extend({ proposalId: z.uuid() }),
      outputSchema: agentProposalSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (raw) => {
      requireWrite();
      const { proposalId, ...input } = putAgentProposalFileSchema
        .extend({ proposalId: z.uuid() })
        .parse(raw);
      return jsonResult(
        await putAgentProposalFile(context, identity, proposalId, {
          ...input,
          ...(input.baseHash === undefined ? {} : { baseHash: input.baseHash }),
        }),
      );
    },
  );
  server.registerTool(
    'propose_structure',
    {
      title: 'Propose source structure changes',
      description:
        'Change FILE/FOLDER structure INSIDE one existing project only. This cannot create or rename a top-level project/template; use create_project or rename_project for those operations. Use exact paths and chain expectedProposalRevision. Binary-containing subtrees cannot be changed.',
      inputSchema: proposeAgentStructureSchema.extend({ proposalId: z.uuid() }),
      outputSchema: agentProposalSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async (raw) => {
      requireWrite();
      const { proposalId, ...input } = proposeAgentStructureSchema
        .extend({ proposalId: z.uuid() })
        .parse(raw);
      return jsonResult(await proposeAgentStructure(context, identity, proposalId, input));
    },
  );
  server.registerTool(
    'get_proposal',
    {
      title: 'Get proposal',
      description:
        'Refresh the durable proposal after a retry, concurrent owner action, or revision conflict. Returns current revision, status, conflicts, changes, frozen review hunks, and latest compile job id.',
      inputSchema: getProposalSchema,
      outputSchema: agentProposalSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async (raw) => {
      const { proposalId } = getProposalSchema.parse(raw);
      return jsonResult(await getAgentClientProposal(context, identity, proposalId));
    },
  );
  server.registerTool(
    'compile_proposal',
    {
      title: 'Compile proposal',
      description:
        'Queue a hardened, networkless compilation and wait for its result. Returns the terminal compile job whenever it becomes available, including warnings, errors, diagnostics, and bounded log. Use get_proposal_compile only to recover after an interrupted or unusually long request.',
      inputSchema: finishAgentProposalSchema,
      outputSchema: agentProposalResponseSchema.extend({ job: compileJobSchema.nullable() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (raw, requestContext) => {
      requireWrite();
      const { proposalId, ...input } = finishAgentProposalSchema.parse(raw);
      const proposal = await requestProposalCompilation(context, identity, proposalId, input);
      const job = proposal.compileJobId
        ? await waitForAgentProposalCompile(
            context,
            identity,
            proposalId,
            proposal.compileJobId,
            requestContext.mcpReq.signal,
          )
        : null;
      return jsonResult({ proposal, job });
    },
  );
  server.registerTool(
    'get_proposal_compile',
    {
      title: 'Get proposal compile result',
      description:
        'Recovery tool for an interrupted or timed-out automatic compile wait. Returns the latest proposal compile job, including status, diagnostics, and bounded log. null means this revision has not been compiled.',
      inputSchema: getProposalSchema,
      outputSchema: proposalCompileOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async (raw) => {
      const { proposalId } = getProposalSchema.parse(raw);
      return jsonResult({ job: await getAgentProposalCompile(context, identity, proposalId) });
    },
  );
  server.registerTool(
    'get_compile_page_images',
    {
      title: 'Get compiled PDF page images',
      description:
        'Render one to three specific one-based pages from an exact succeeded proposal compile and return them as ascending PNG image blocks. Use this after compile_proposal or finish_proposal to visually inspect layout; request additional pages in another call.',
      inputSchema: agentPdfPageRequestSchema,
      outputSchema: agentPdfPageResponseSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async (raw, requestContext) => {
      const input = agentPdfPageRequestSchema.parse(raw);
      const rendered = await renderAgentProposalPdfPages(
        context,
        identity,
        input,
        requestContext.mcpReq.signal,
      );
      const structuredContent = {
        compileJobId: rendered.compileJobId,
        pages: rendered.pages.map((page) => ({ page: page.page, mimeType: 'image/png' as const })),
      };
      return {
        content: rendered.pages.flatMap((page) => [
          { type: 'text' as const, text: `PDF page ${page.page}` },
          { type: 'image' as const, data: page.data.toString('base64'), mimeType: 'image/png' },
        ]),
        structuredContent,
      };
    },
  );
  server.registerTool(
    'finish_proposal',
    {
      title: 'Finish proposal',
      description:
        'Submit the latest draft for owner review, automatically compile the frozen review revision, and return all available warnings/errors in compile. reviewing is a successful handoff, not acceptance. If needs_rebase, reread conflicts, rewrite against current hashes, and finish again.',
      inputSchema: finishAgentProposalSchema,
      outputSchema: finishProposalOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (raw, requestContext) => {
      requireWrite();
      const { proposalId, ...input } = finishAgentProposalSchema.parse(raw);
      const proposal = await finishAgentProposal(context, identity, proposalId, input);
      return jsonResult({
        ...proposal,
        compile: await compileReview(proposal, requestContext.mcpReq.signal),
      });
    },
  );
  return server;
}

function toWebRequest(context: AppContext, request: FastifyRequest): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers))
    if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  const body = request.body === undefined ? undefined : JSON.stringify(request.body);
  return new Request(publicRequestUrl(context.config.API_ORIGIN, request.raw.url ?? '/api/mcp'), {
    method: request.method,
    headers,
    ...(body === undefined ? {} : { body }),
  });
}

async function sendWebResponse(response: Response, reply: import('fastify').FastifyReply) {
  reply.code(response.status);
  for (const [key, value] of response.headers.entries()) reply.header(key, value);
  return reply.send(Buffer.from(await response.arrayBuffer()));
}

export async function registerMcpRoutes(app: FastifyInstance, context: AppContext) {
  if (!context.config.AGENT_MCP_ENABLED) return;
  const resource = context.config.AGENT_MCP_RESOURCE_URL;
  if (!resource) throw new Error('AGENT_MCP_RESOURCE_URL is required');
  const issuer = publicAuthIssuerUrl(context.config.API_ORIGIN);
  const mcpHandler = createMcpHandler(async (requestContext) => {
    const claims = requestContext.authInfo?.extra?.claims;
    return createServer(context, claims);
  }, mcpHandlerOptions);
  const protectedHandler = requireMcpAuth(
    context.auth,
    async (request, claims) => {
      const accessToken = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      const clientId = String(claims.client_id ?? claims.azp ?? 'unknown');
      const userId = String(claims.sub ?? 'unknown');
      const [policy] = await context.db
        .select({ tokensRevokedAt: agentClientPolicies.tokensRevokedAt })
        .from(agentClientPolicies)
        .where(
          and(eq(agentClientPolicies.userId, userId), eq(agentClientPolicies.clientId, clientId)),
        )
        .limit(1);
      const issuedAt = typeof claims.iat === 'number' ? claims.iat : undefined;
      if (!policy || !isOAuthTokenAfterRevocation(issuedAt, policy.tokensRevokedAt))
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32001, message: 'Access token is expired or revoked' },
            id: null,
          }),
          {
            status: 401,
            headers: {
              'content-type': 'application/json',
              'www-authenticate': `Bearer resource_metadata="${new URL('/.well-known/oauth-protected-resource/api/mcp', resource).href}", error="invalid_token"`,
            },
          },
        );
      const body = await request
        .clone()
        .json()
        .catch(() => null);
      const toolName = z
        .object({ method: z.literal('tools/call'), params: z.object({ name: z.string() }) })
        .safeParse(body);
      const writes = new Set([
        'create_project',
        'rename_project',
        'start_proposal',
        'put_proposal_file',
        'propose_structure',
        'compile_proposal',
        'finish_proposal',
      ]);
      const kind = toolName.success && writes.has(toolName.data.params.name) ? 'write' : 'read';
      const tokenScopes = new Set(
        typeof claims.scope === 'string'
          ? claims.scope.split(/\s+/).filter(Boolean)
          : Array.isArray(claims.scope)
            ? claims.scope.filter((scope): scope is string => typeof scope === 'string')
            : [],
      );
      if (kind === 'write' && !tokenScopes.has('proposals:write')) {
        incrementMetric('latex_mcp_requests_total', {
          kind,
          outcome: 'insufficient_scope',
        });
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32001, message: 'The proposals:write scope is required' },
            id: null,
          }),
          {
            status: 403,
            headers: {
              'content-type': 'application/json',
              'www-authenticate': `Bearer resource_metadata="${new URL('/.well-known/oauth-protected-resource/api/mcp', resource).href}", error="insufficient_scope", scope="proposals:write"`,
            },
          },
        );
      }
      const window = Math.floor(Date.now() / 60_000);
      const key = `mcp-rate:${userId}:${clientId}:${kind}:${window}`;
      const count = await context.redis.incr(key);
      if (count === 1) await context.redis.expire(key, 70);
      const maximum =
        kind === 'write'
          ? context.config.AGENT_MCP_WRITES_PER_MINUTE
          : context.config.AGENT_MCP_READS_PER_MINUTE;
      if (count > maximum) {
        incrementMetric('latex_mcp_requests_total', { kind, outcome: 'rate_limited' });
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Rate limit exceeded' },
            id: null,
          }),
          { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '60' } },
        );
      }
      incrementMetric('latex_mcp_requests_total', { kind, outcome: 'allowed' });
      return mcpHandler.fetch(request, {
        ...(body === null ? {} : { parsedBody: body }),
        authInfo: {
          token: accessToken,
          clientId: String(claims.client_id ?? claims.azp ?? ''),
          scopes: typeof claims.scope === 'string' ? claims.scope.split(/\s+/) : [],
          ...(typeof claims.exp === 'number' ? { expiresAt: claims.exp } : {}),
          resource: new URL(resource),
          extra: { claims },
        },
      });
    },
    {
      issuer,
      // Verify the public issuer, but fetch its keys over loopback. Path-mounted self-hosts may
      // not be able to resolve their external hostname from inside the API container.
      jwksUrl: localAuthJwksUrl(context.config.API_PORT),
      resource,
      requiredScopes: ['projects:read'],
      challengeScopes: ['projects:read', 'proposals:write'],
    },
  );
  app.post(
    '/api/mcp',
    { bodyLimit: agentProposalLimits.maxFileBytes + 64 * 1024 },
    async (request, reply) =>
      sendWebResponse(await protectedHandler(toWebRequest(context, request)), reply),
  );
  app.addHook('onClose', async () => mcpHandler.close());
}
