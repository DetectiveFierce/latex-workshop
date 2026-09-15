import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { requireMcpAuth } from '@better-auth/mcp';
import {
  agentLibraryMutationSchema,
  agentPdfPageRequestSchema,
  agentPdfPageResponseSchema,
  agentProposalLimits,
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
import { listAgentLibraryOrganization, organizeAgentLibrary } from '../lib/agent-library.js';
import {
  mindPalaceEditingGuide,
  mindPalaceEditingGuideUri,
  mindPalaceMcpInstructions,
  mindPalaceMcpServerName,
  mindPalaceMcpServerVersion,
  projectScopeRule,
} from '../lib/mcp-agent-guide.js';
import {
  localAuthJwksUrl,
  protectedResourceMetadataUrl,
  publicAppPageUrl,
  publicAuthIssuerUrl,
  publicRequestUrl,
} from '../lib/public-request-url.js';
import { incrementMetric } from '../lib/operational-metrics.js';
import { isOAuthTokenAfterRevocation } from '../lib/agent-proposal-policy.js';
import { mcpHandlerOptions } from '../lib/mcp-transport.js';
import { mcpToolMetadata } from '../lib/mcp-tool-metadata.js';

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
const agentLibraryToolInputSchema = z.object({
  action: z
    .enum([
      'create_folder',
      'update_folder',
      'trash_folder',
      'create_tag',
      'update_tag',
      'delete_tag',
      'move_project',
      'set_project_tags',
    ])
    .describe(
      'Top-level Library action. Use move_project—not update_folder or propose_structure—to place an existing project in a different Library folder.',
    ),
  idempotencyKey: z
    .uuid()
    .describe('Fresh UUID for this action; reuse only to retry the exact same operation'),
  name: z.string().trim().min(1).max(120).optional().describe('Folder or tag display name'),
  color: z.enum(['slate', 'green', 'cyan', 'blue', 'amber', 'orange', 'magenta', 'red']).optional(),
  parentId: z
    .uuid()
    .nullable()
    .optional()
    .describe('Parent Library folder id; null means a top-level folder'),
  folderId: z
    .uuid()
    .nullable()
    .optional()
    .describe(
      'Library folder id selected from list_projects; for move_project, null moves the project to Library root',
    ),
  tagId: z.uuid().optional().describe('Tag id selected from list_projects'),
  projectId: z.uuid().optional().describe('Granted project id selected from list_projects'),
  tagIds: z
    .array(z.uuid())
    .max(50)
    .optional()
    .describe('Complete desired tag id set for set_project_tags'),
});
const listProjectsOutputSchema = z
  .object({
    manageAccessUrl: z.url(),
    projects: z.array(
      z.object({ id: z.uuid(), name: z.string(), workspaceUrl: z.url() }).passthrough(),
    ),
  })
  .passthrough();
const projectTreeOutputSchema = z
  .object({
    projectId: z.uuid(),
    entries: z.array(
      z
        .object({
          path: z.string(),
          kind: z.enum(['file', 'folder']),
          hash: z.string().nullable(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
const agentProjectSummarySchema = listProjectsOutputSchema.shape.projects.element;
// Output schemas are intentionally concise. The full domain objects are still passed through in
// structuredContent, while keeping tools/list comfortably below connector discovery limits.
const agentProposalSummarySchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    status: z.enum(['draft', 'needs_rebase', 'reviewing', 'resolved', 'rejected']),
    revision: z.number().int().nonnegative(),
  })
  .passthrough();
const compileJobSummarySchema = z
  .object({
    id: z.string(),
    status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
  })
  .passthrough();
const createProjectOutputSchema = z.object({
  project: agentProjectSummarySchema,
  proposal: agentProposalSummarySchema,
  compile: compileJobSummarySchema.nullable(),
  reviewUrl: z.url(),
  nextAction: z.string(),
});
const renameProjectOutputSchema = z.object({ project: agentProjectSummarySchema });
const libraryMutationOutputSchema = z.object({ action: z.string() }).passthrough();
const finishProposalOutputSchema = agentProposalSummarySchema.extend({
  compile: compileJobSummarySchema.nullable(),
  reviewUrl: z.url(),
});
const proposalMutationOutputSchema = agentProposalSummarySchema;
const proposalCompileOutputSchema = z.object({ job: compileJobSummarySchema.nullable() });
const compileProposalOutputSchema = z.object({
  proposal: agentProposalSummarySchema,
  job: compileJobSummarySchema.nullable(),
});
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

function jsonResult(value: Record<string, unknown>, summary: string) {
  return {
    // Keep the model-readable text small. ChatGPT already receives structuredContent, and
    // duplicating large trees, source files, compile logs, or project lists can exceed the
    // connector's response budget before the next tool call is planned.
    content: [{ type: 'text' as const, text: summary }],
    structuredContent: value,
  };
}

function proposalSummary(proposal: z.infer<typeof agentProposalSchema>) {
  return agentProposalSummarySchema.parse(proposal);
}

function compileJobSummary(job: z.infer<typeof compileJobSchema> | null) {
  return job === null ? null : compileJobSummarySchema.parse(job);
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
  const manageAccessUrl = publicAppPageUrl(
    context.config.WEB_ORIGIN,
    context.config.API_ORIGIN,
    '/account#agent-access',
  );
  const workspaceUrl = (projectId: string) =>
    publicAppPageUrl(
      context.config.WEB_ORIGIN,
      context.config.API_ORIGIN,
      `/projects/${projectId}`,
    );
  const projectWithUrl = <T extends { id: string }>(project: T) => ({
    ...project,
    workspaceUrl: workspaceUrl(project.id),
  });
  const server = new McpServer(
    { name: mindPalaceMcpServerName, version: mindPalaceMcpServerVersion },
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
  server.registerTool(
    'list_projects',
    {
      title: 'List Mind Palace LaTeX Workshop projects',
      description:
        'Use this first for every request to read, create, place, move, rename, compile, or edit a Mind Palace LaTeX Workshop project. Also use it again on conversational follow-ups such as "now update it", "that project", "the same paper", or "try again" when earlier messages identified a Mind Palace project, even if the current message omits the product name. These are private site-hosted projects, not local files. Match displayed names and never guess ids. Results include Library folders plus each project folderId/tagIds. Create directly in a folder with create_project(folderId). Move an existing project with organize_library action move_project and destination folderId; null means Library root. If a project is absent, send the user to manageAccessUrl.',
      inputSchema: z.object({}),
      outputSchema: listProjectsOutputSchema,
      ...mcpToolMetadata('read'),
    },
    async () => {
      const [projects, organization] = await Promise.all([
        listGrantedProjects(context, identity),
        listAgentLibraryOrganization(context, identity),
      ]);
      return jsonResult(
        {
          scopeRule: projectScopeRule,
          projectCreationTool: 'create_project',
          manageAccessUrl,
          projects: projects.map(projectWithUrl),
          ...organization,
        },
        `Found ${projects.length} granted projects, ${organization.folders.length} Library folders, and ${organization.tags.length} tags.`,
      );
    },
  );
  server.registerTool(
    'organize_library',
    {
      title: 'Organize the Mind Palace LaTeX Workshop Library',
      description:
        'Use after list_projects for immediate top-level Mind Palace LaTeX Workshop Library metadata changes. To move an existing project between folders, call action=move_project with its projectId and the destination folderId; use folderId=null for Library root, then refresh list_projects to verify. Other actions: create_folder; update_folder to rename/move a Library folder; trash_folder; create_tag; update_tag; delete_tag; set_project_tags. This is distinct from propose_structure, which only changes files/folders inside a project. Use returned ids; operations affecting ungranted projects are refused.',
      inputSchema: agentLibraryToolInputSchema,
      outputSchema: libraryMutationOutputSchema,
      ...mcpToolMetadata('write', { destructive: true, idempotent: false }),
    },
    async (raw) => {
      requireWrite();
      const result = await organizeAgentLibrary(
        context,
        identity,
        agentLibraryMutationSchema.parse(raw),
      );
      return jsonResult(
        result,
        `Completed Mind Palace Library action ${result.action}. Call list_projects again before another organization decision.`,
      );
    },
  );
  server.registerTool(
    'create_project',
    {
      title: 'Create a Mind Palace LaTeX Workshop project or template',
      description:
        'Use this only for a new top-level Mind Palace LaTeX Workshop project or reusable template. Inspect list_projects first. Pass folderId to create it directly in that existing Library folder and tagIds for its initial tags; omit folderId for Library root. Honor the user’s requested folder, otherwise infer placement from the source/template and closely related projects when evidence is strong. Omit sourceProjectId for blank source or pass a granted source to copy. Customize only the returned new-project proposal; metadata is immediate while source remains reviewable.',
      inputSchema: createAgentProjectSchema,
      outputSchema: createProjectOutputSchema,
      ...mcpToolMetadata('write'),
    },
    async (raw, requestContext) => {
      requireWrite();
      const created = await createAgentProject(
        context,
        identity,
        createAgentProjectSchema.parse(raw),
      );
      const compile = await compileReview(created.proposal, requestContext.mcpReq.signal);
      return jsonResult(
        {
          project: projectWithUrl(created.project),
          proposal: proposalSummary(created.proposal),
          compile: compileJobSummary(compile),
          reviewUrl: workspaceUrl(created.project.id),
          nextAction:
            'If the user requested further content customization, mutate and re-finish the returned proposal for this NEW project. Never start or mutate a proposal on sourceProjectId.',
        },
        `Created Mind Palace LaTeX Workshop project "${created.project.name}" with proposal revision ${created.proposal.revision}.`,
      );
    },
  );
  server.registerTool(
    'rename_project',
    {
      title: 'Rename a Mind Palace LaTeX Workshop project or template',
      description:
        'Use this only when the user wants to rename a top-level Mind Palace LaTeX Workshop project or template. This is different from propose_structure, which only renames files or folders inside a project. The metadata rename takes effect immediately.',
      inputSchema: renameAgentProjectSchema,
      outputSchema: renameProjectOutputSchema,
      ...mcpToolMetadata('write'),
    },
    async (raw) => {
      requireWrite();
      const project = await renameAgentProject(
        context,
        identity,
        renameAgentProjectSchema.parse(raw),
      );
      return jsonResult(
        { project: projectWithUrl(project) },
        `Renamed the Mind Palace LaTeX Workshop project to "${project.name}".`,
      );
    },
  );
  server.registerTool(
    'get_project_tree',
    {
      title: 'Inspect a Mind Palace LaTeX Workshop project',
      description:
        'Use this after list_projects to inspect the files inside one Mind Palace LaTeX Workshop project. If the project is only a formatting source for a requested new project or template, treat it as read-only reference material and call create_project after inspection. Returns paths, hashes, versions, and editable flags.',
      inputSchema: getTreeSchema,
      outputSchema: projectTreeOutputSchema,
      ...mcpToolMetadata('read'),
    },
    async (raw) => {
      const { projectId } = getTreeSchema.parse(raw);
      const tree = await getAgentProjectTree(context, identity, projectId);
      return jsonResult(
        { ...tree, scopeRule: projectScopeRule },
        `Inspected ${tree.entries.length} entries in the Mind Palace LaTeX Workshop project. Use the structured tree for paths, versions, and hashes.`,
      );
    },
  );
  server.registerTool(
    'read_text_file',
    {
      title: 'Read a Mind Palace LaTeX Workshop source file',
      description:
        'Use this after inspecting a Mind Palace LaTeX Workshop project to read accepted UTF-8 source. Continue with nextOffset until null. Preserve hash as baseHash when replacing this file in a proposal so accepted-source drift becomes an explicit conflict.',
      inputSchema: readTextFileSchema,
      outputSchema: readTextOutputSchema,
      ...mcpToolMetadata('read'),
    },
    async (raw) => {
      const file = await readAgentTextFile(context, identity, readTextFileSchema.parse(raw));
      return jsonResult(
        file,
        `Read ${file.path} at offset ${file.offset}; ${file.nextOffset === null ? 'the file is complete' : `continue at offset ${file.nextOffset}`}.`,
      );
    },
  );
  server.registerTool(
    'start_proposal',
    {
      title: 'Start a Mind Palace LaTeX Workshop proposal',
      description:
        'Use this to begin reviewable file or folder changes inside an existing Mind Palace LaTeX Workshop project. It cannot create a top-level project or template. If the user requested a new project or template, call create_project and customize the proposal returned by that tool.',
      inputSchema: startAgentProposalSchema,
      outputSchema: proposalMutationOutputSchema,
      ...mcpToolMetadata('write'),
    },
    async (raw) => {
      requireWrite();
      const input = startAgentProposalSchema.parse(raw);
      const proposal = await startAgentProposal(context, identity, input);
      return jsonResult(
        proposalSummary(proposal),
        `Started proposal ${proposal.id} at revision ${proposal.revision}.`,
      );
    },
  );
  server.registerTool(
    'put_proposal_file',
    {
      title: 'Write a Mind Palace LaTeX Workshop proposal file',
      description:
        'Use this to create or replace a complete UTF-8 file inside a Mind Palace LaTeX Workshop proposal. It changes only the reviewable proposal, never accepted source. For a newly created project or template, use the proposal returned by create_project, not its source project.',
      inputSchema: putAgentProposalFileSchema.extend({ proposalId: z.uuid() }),
      outputSchema: proposalMutationOutputSchema,
      ...mcpToolMetadata('write'),
    },
    async (raw) => {
      requireWrite();
      const { proposalId, ...input } = putAgentProposalFileSchema
        .extend({ proposalId: z.uuid() })
        .parse(raw);
      const proposal = await putAgentProposalFile(context, identity, proposalId, {
        ...input,
        ...(input.baseHash === undefined ? {} : { baseHash: input.baseHash }),
      });
      return jsonResult(
        proposalSummary(proposal),
        `Updated proposal ${proposal.id}; the latest revision is ${proposal.revision}.`,
      );
    },
  );
  server.registerTool(
    'propose_structure',
    {
      title: 'Propose Mind Palace LaTeX Workshop structure changes',
      description:
        'Use this to propose file or folder moves, renames, or deletions inside one Mind Palace LaTeX Workshop project. It changes only the reviewable proposal, not accepted source. Use create_project or rename_project for top-level Library items. Use exact paths and chain expectedProposalRevision.',
      inputSchema: proposeAgentStructureSchema.extend({ proposalId: z.uuid() }),
      outputSchema: proposalMutationOutputSchema,
      ...mcpToolMetadata('write'),
    },
    async (raw) => {
      requireWrite();
      const { proposalId, ...input } = proposeAgentStructureSchema
        .extend({ proposalId: z.uuid() })
        .parse(raw);
      const proposal = await proposeAgentStructure(context, identity, proposalId, input);
      return jsonResult(
        proposalSummary(proposal),
        `Updated proposal structure; the latest revision is ${proposal.revision}.`,
      );
    },
  );
  server.registerTool(
    'get_proposal',
    {
      title: 'Get a Mind Palace LaTeX Workshop proposal',
      description:
        'Use this to refresh a durable Mind Palace LaTeX Workshop proposal after a retry, concurrent owner action, or revision conflict. Returns the current revision, status, conflicts, changes, frozen review hunks, and latest compile job id.',
      inputSchema: getProposalSchema,
      outputSchema: proposalMutationOutputSchema,
      ...mcpToolMetadata('read'),
    },
    async (raw) => {
      const { proposalId } = getProposalSchema.parse(raw);
      const proposal = await getAgentClientProposal(context, identity, proposalId);
      return jsonResult(
        proposalSummary(proposal),
        `Proposal ${proposal.id} is ${proposal.status} at revision ${proposal.revision}.`,
      );
    },
  );
  server.registerTool(
    'compile_proposal',
    {
      title: 'Compile a Mind Palace LaTeX Workshop proposal',
      description:
        'Use this to preflight a draft Mind Palace LaTeX Workshop proposal in the hardened, networkless compiler and wait for its result. Returns warnings, errors, diagnostics, and a bounded log. Use get_proposal_compile only after an interrupted or unusually long request.',
      inputSchema: finishAgentProposalSchema,
      outputSchema: compileProposalOutputSchema,
      ...mcpToolMetadata('write'),
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
      return jsonResult(
        { proposal: proposalSummary(proposal), job: compileJobSummary(job) },
        job === null
          ? `Proposal ${proposal.id} has no compile job for revision ${proposal.revision}.`
          : `Proposal ${proposal.id} compile ${job.status} for revision ${proposal.revision}; inspect structured diagnostics.`,
      );
    },
  );
  server.registerTool(
    'get_proposal_compile',
    {
      title: 'Get a Mind Palace LaTeX Workshop compile result',
      description:
        'Use this only to recover an interrupted or timed-out Mind Palace LaTeX Workshop compile wait. Returns the latest proposal compile job, including status, diagnostics, and bounded log. null means this revision has not been compiled.',
      inputSchema: getProposalSchema,
      outputSchema: proposalCompileOutputSchema,
      ...mcpToolMetadata('read'),
    },
    async (raw) => {
      const { proposalId } = getProposalSchema.parse(raw);
      const job = await getAgentProposalCompile(context, identity, proposalId);
      return jsonResult(
        { job: compileJobSummary(job) },
        job === null
          ? `Proposal ${proposalId} has no compile job.`
          : `Proposal ${proposalId} compile is ${job.status}; inspect structured diagnostics.`,
      );
    },
  );
  server.registerTool(
    'get_compile_page_images',
    {
      title: 'Inspect Mind Palace LaTeX Workshop PDF pages',
      description:
        'Use this after a successful Mind Palace LaTeX Workshop proposal compile to inspect one to three specific one-based PDF pages as PNG images. Request additional pages in another call when visual or layout-sensitive work spans more pages.',
      inputSchema: agentPdfPageRequestSchema,
      outputSchema: agentPdfPageResponseSchema,
      ...mcpToolMetadata('read'),
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
      title: 'Finish a Mind Palace LaTeX Workshop proposal',
      description:
        'Use this to submit the latest Mind Palace LaTeX Workshop draft for owner review and automatically compile the frozen revision. Return reviewUrl to the user after a successful handoff. reviewing means ready for review, not accepted. If needs_rebase, reread conflicts, rewrite against current hashes, and finish again.',
      inputSchema: finishAgentProposalSchema,
      outputSchema: finishProposalOutputSchema,
      ...mcpToolMetadata('write'),
    },
    async (raw, requestContext) => {
      requireWrite();
      const { proposalId, ...input } = finishAgentProposalSchema.parse(raw);
      const proposal = await finishAgentProposal(context, identity, proposalId, input);
      const compile = await compileReview(proposal, requestContext.mcpReq.signal);
      const reviewUrl = workspaceUrl(proposal.projectId);
      return jsonResult(
        {
          ...proposalSummary(proposal),
          compile: compileJobSummary(compile),
          reviewUrl,
        },
        `Proposal ${proposal.id} is ${proposal.status} at revision ${proposal.revision}. Owner review: ${reviewUrl}`,
      );
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
              'www-authenticate': `Bearer resource_metadata="${protectedResourceMetadataUrl(resource)}", error="invalid_token"`,
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
        'organize_library',
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
              'www-authenticate': `Bearer resource_metadata="${protectedResourceMetadataUrl(resource)}", error="insufficient_scope", scope="proposals:write"`,
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
          scopes: [...tokenScopes],
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
