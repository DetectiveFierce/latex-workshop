import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { requireMcpAuth } from '@better-auth/mcp';
import {
  editAgentProjectSchema,
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
import { agentClientPolicies, oauthClients, users } from '@latex-workshop/db';
import { and, eq } from 'drizzle-orm';
import type { AppContext } from '../lib/context.js';
import {
  acceptRemainingProposalItems,
  requireGrantedProject,
  reconcileProposalCompilation,
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
import { editAgentProject } from '../lib/agent-edits.js';
import { compileAgentProject, getAgentProjectCompile } from '../lib/agent-compiles.js';
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
  reachableProtectedResourceMetadataUrl,
  rewriteMcpResourceMetadataChallenge,
  publicAppPageUrl,
  publicAuthIssuerUrl,
  publicRequestUrl,
} from '../lib/public-request-url.js';
import { incrementMetric } from '../lib/operational-metrics.js';
import { isOAuthTokenAfterRevocation } from '../lib/agent-proposal-policy.js';
import { mcpHandlerOptions } from '../lib/mcp-transport.js';
import { mcpToolMetadata } from '../lib/mcp-tool-metadata.js';
import { trustedPrivateMcpClient } from '../lib/tailnet-auth.js';

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
    manageAccessUrl: z.string(),
    projects: z.array(
      z.object({ id: z.string(), name: z.string(), workspaceUrl: z.string() }).passthrough(),
    ),
  })
  .passthrough();
const projectTreeOutputSchema = z
  .object({
    projectId: z.string(),
    sourceRevision: z.number().int().nonnegative(),
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
  applied: z.boolean(),
  project: agentProjectSummarySchema,
  proposal: agentProposalSummarySchema,
  compile: compileJobSummarySchema.nullable(),
  reviewUrl: z.string(),
  nextAction: z.string(),
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

async function createServer(context: AppContext, claims: unknown, privateAccess = false) {
  const toolMetadata: typeof mcpToolMetadata = (kind, options) =>
    mcpToolMetadata(kind, options, privateAccess ? 'private' : 'oauth');
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
        'Live editing, undo, follow-up refresh, optional review, project/template scope, and compile instructions.',
      mimeType: 'text/markdown',
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: mindPalaceEditingGuide }],
    }),
  );
  server.registerTool(
    'get_editing_guide',
    {
      title: 'Learn all Workshop editing capabilities',
      description:
        'Read the complete Mind Palace LaTeX Workshop live-edit, undo, refresh, compile, project creation and optional review workflow. Available even in clients that do not expose MCP resources.',
      inputSchema: z.object({}),
      ...toolMetadata('read'),
    },
    async () => ({ content: [{ type: 'text' as const, text: mindPalaceEditingGuide }] }),
  );
  server.registerTool(
    'list_projects',
    {
      title: 'List Mind Palace LaTeX Workshop projects',
      description:
        'Discover connected Mind Palace LaTeX Workshop projects on Workshop mentions or requests to edit/query a LaTeX file, including file follow-ups. No explicit skill invocation is needed. Generic proof checking alone must not query Workshop. Honor explicit local paths. Resolve names; never guess ids. Returns projects, Library folders/tags, capabilities, and manageAccessUrl. Default edit: get_project_tree → read_text_file → edit_project → compile_project. Use BU Semester tools for course evidence.',
      inputSchema: z.object({}),
      outputSchema: listProjectsOutputSchema,
      ...toolMetadata('read'),
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
          capabilities: {
            liveEditing: scopes.has('proposals:write'),
            defaultEditTool: 'edit_project',
            compileTool: 'compile_project',
            undo: 'File Undo history and project Version history',
            reviewOptional: true,
            guideUri: mindPalaceEditingGuideUri,
          },
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
        'Immediate Mind Palace LaTeX Workshop Library metadata actions. move_project takes projectId and destination folderId (null=root). Other actions create/update/trash folders, create/update/delete tags, and set_project_tags. Refresh list_projects afterward. Ungranted projects remain protected.',
      inputSchema: agentLibraryToolInputSchema,
      ...toolMetadata('write', { destructive: true, idempotent: false }),
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
        'Create a new top-level Mind Palace LaTeX Workshop project/template, not a file. Use folderId/tagIds from list_projects. Omit sourceProjectId for blank source or copy a granted source. isTemplate=true makes a reusable template. Seeded source is live by default; customize the NEW project with edit_project. reviewOnly=true is optional owner review.',
      inputSchema: createAgentProjectSchema,
      outputSchema: createProjectOutputSchema,
      ...toolMetadata('write'),
    },
    async (raw, requestContext) => {
      requireWrite();
      const created = await createAgentProject(
        context,
        identity,
        createAgentProjectSchema.parse(raw),
      );
      const compile = await compileReview(created.proposal, requestContext.mcpReq.signal);
      const input = createAgentProjectSchema.parse(raw);
      const project = await requireGrantedProject(context, identity, created.project.id);
      const proposal =
        !input.reviewOnly && created.proposal.status === 'reviewing'
          ? await acceptRemainingProposalItems(
              context,
              identity.userId,
              created.proposal.id,
              created.proposal.revision,
              { expectedSourceRevision: project.sourceRevision },
            )
          : created.proposal;
      if (!input.reviewOnly)
        await reconcileProposalCompilation(context, identity.userId, proposal.id);

      return jsonResult(
        {
          applied: !input.reviewOnly && proposal.status === 'resolved',
          project: projectWithUrl(created.project),
          proposal: proposalSummary(proposal),
          compile: compileJobSummary(compile),
          reviewUrl: workspaceUrl(created.project.id),
          nextAction: input.reviewOnly
            ? 'Seeded source is ready for owner review. Customize this new-project proposal.'
            : 'Seeded source is live. Refresh the NEW project tree and customize it with edit_project; never edit sourceProjectId.',
        },
        `Created Mind Palace LaTeX Workshop project "${created.project.name}"; ${input.reviewOnly ? 'seeded source awaits optional owner review' : 'seeded source is live'}.`,
      );
    },
  );
  server.registerTool(
    'rename_project',
    {
      title: 'Rename a Mind Palace LaTeX Workshop project or template',
      description:
        'Immediately rename a top-level Mind Palace LaTeX Workshop project/template. For a file or folder rename use edit_project structure.',
      inputSchema: renameAgentProjectSchema,
      ...toolMetadata('write'),
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
        'Read the current Mind Palace LaTeX Workshop sourceRevision, paths, hashes, versions, editable flags, compiler and main file. Refresh before writing. A source project used to create another item is read-only reference material.',
      inputSchema: getTreeSchema,
      outputSchema: projectTreeOutputSchema,
      ...toolMetadata('read'),
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
        'Read current saved Mind Palace LaTeX Workshop UTF-8 source, including owner/agent edits. Follow nextOffset until null; restart if hash changes between pages. Reread before follow-ups. Use its current hash as edit_project baseHash.',
      inputSchema: readTextFileSchema,
      outputSchema: readTextOutputSchema,
      ...toolMetadata('read'),
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
    'edit_project',
    {
      title: 'Edit live Mind Palace LaTeX Workshop files',
      description:
        'Default Mind Palace LaTeX Workshop edit: atomically apply live complete files and structure, without owner approval. Use fresh tree expectedSourceRevision and read hashes; baseHash=null is create-only. Returns current tree and undoCheckpointId. Refresh before each follow-up; stale state conflicts. Identical retries reuse their UUID. Undo history restores files; Version history restores the pre-edit project checkpoint.',
      inputSchema: editAgentProjectSchema,
      outputSchema: projectTreeOutputSchema.extend({
        editId: z.string(),
        applied: z.boolean(),
        replayed: z.boolean(),
        undoCheckpointId: z.string().nullable(),
        nextAction: z.string(),
      }),
      ...toolMetadata('write', { destructive: true }),
    },
    async (raw) => {
      requireWrite();
      const result = await editAgentProject(context, identity, editAgentProjectSchema.parse(raw));
      return jsonResult(
        { ...result, workspaceUrl: workspaceUrl(result.projectId) },
        result.replayed
          ? `Edit ${result.editId} already completed; no changes were reapplied. The returned tree is current.`
          : `Applied edit ${result.editId}. Changes are live; undo is available in Mind Palace.`,
      );
    },
  );
  server.registerTool(
    'compile_project',
    {
      title: 'Compile the live Mind Palace LaTeX Workshop project',
      description:
        'Compile live Mind Palace LaTeX Workshop source from an immutable checkpoint; wait up to 50 seconds. Inspect diagnostics, then correct via edit_project. Recover pending jobs with get_project_compile. Failed builds preserve the successful PDF.',
      inputSchema: getTreeSchema.extend({ expectedSourceRevision: z.number().int().nonnegative() }),
      ...toolMetadata('write'),
    },
    async (raw, requestContext) => {
      requireWrite();
      const input = getTreeSchema
        .extend({ expectedSourceRevision: z.number().int().nonnegative() })
        .parse(raw);
      const job = await compileAgentProject(
        context,
        identity,
        input.projectId,
        input.expectedSourceRevision,
        requestContext.mcpReq.signal,
      );
      return jsonResult(
        { job: compileJobSummary(job) },
        `Project compile ${job?.status ?? 'unavailable'}; inspect the returned diagnostics.`,
      );
    },
  );
  server.registerTool(
    'get_project_compile',
    {
      title: 'Read a live project compile result',
      description:
        'Read a Mind Palace LaTeX Workshop live-source compile by exact compileJobId, or latest when omitted. Recover interrupted waits; sourceRevision identifies the compiled saved source.',
      inputSchema: getTreeSchema.extend({ compileJobId: z.uuid().optional() }),
      ...toolMetadata('read'),
    },
    async (raw) => {
      const input = getTreeSchema.extend({ compileJobId: z.uuid().optional() }).parse(raw);
      const job = await getAgentProjectCompile(
        context,
        identity,
        input.projectId,
        input.compileJobId,
      );
      return jsonResult(
        { job: compileJobSummary(job) },
        `Project compile ${job?.status ?? 'not yet requested'}.`,
      );
    },
  );
  server.registerTool(
    'start_proposal',
    {
      title: 'Start a Mind Palace LaTeX Workshop proposal',
      description:
        'Optional Mind Palace LaTeX Workshop review-first draft. Normal edits use edit_project. Cannot create a top-level project; use create_project. Only customize a new-project proposal when reviewOnly=true was requested.',
      inputSchema: startAgentProposalSchema,
      ...toolMetadata('write'),
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
        'Optional Mind Palace LaTeX Workshop proposal file write. Normal live edits use edit_project. Send full UTF-8 content and current baseHash; chain expectedProposalRevision. Accepted source stays unchanged.',
      inputSchema: putAgentProposalFileSchema.extend({ proposalId: z.uuid() }),
      ...toolMetadata('write'),
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
        'Optional Mind Palace LaTeX Workshop proposal moves/renames/deletions/folders. Normal live edits use edit_project structure. Chain expectedProposalRevision. Top-level Library items use create_project, rename_project or organize_library.',
      inputSchema: proposeAgentStructureSchema.extend({ proposalId: z.uuid() }),
      ...toolMetadata('write'),
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
        'Refresh an optional Mind Palace LaTeX Workshop review draft after retries/conflicts. Returns revision, status, changes, hunks, conflicts and compile id.',
      inputSchema: getProposalSchema,
      ...toolMetadata('read'),
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
        'Compile an optional Mind Palace LaTeX Workshop review draft and wait for diagnostics/log. Normal live edits use compile_project. Recover interrupted waits with get_proposal_compile.',
      inputSchema: finishAgentProposalSchema,
      ...toolMetadata('write'),
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
        'Recover an interrupted Mind Palace LaTeX Workshop proposal compile wait. Returns latest job, diagnostics/log, or null if not compiled.',
      inputSchema: getProposalSchema,
      ...toolMetadata('read'),
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
        'Inspect 1–3 one-based Mind Palace LaTeX Workshop PDF pages from an exact succeeded job. Use projectId for live builds, proposalId for optional review builds. Request additional pages in another call.',
      inputSchema: agentPdfPageRequestSchema,
      outputSchema: agentPdfPageResponseSchema,
      ...toolMetadata('read'),
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
        'Optional Mind Palace LaTeX Workshop review handoff; freezes and compiles the draft. reviewing means awaiting owner acceptance; return reviewUrl. For needs_rebase reread conflicts and rewrite. Live edit_project changes need no handoff.',
      inputSchema: finishAgentProposalSchema,
      ...toolMetadata('write'),
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
  const reachableResourceMetadataUrl = reachableProtectedResourceMetadataUrl(
    context.config.API_ORIGIN,
  );
  const mcpHandler = createMcpHandler(async (requestContext) => {
    const claims = requestContext.authInfo?.extra?.claims;
    return createServer(context, claims, requestContext.authInfo?.extra?.privateAccess === true);
  }, mcpHandlerOptions);
  const handleAuthenticatedRequest = async (
    request: Request,
    claims: Record<string, unknown>,
    privateAccess = false,
  ) => {
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
    if (
      !policy ||
      (privateAccess
        ? policy.tokensRevokedAt !== null
        : !isOAuthTokenAfterRevocation(issuedAt, policy.tokensRevokedAt))
    )
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
            'www-authenticate': `Bearer resource_metadata="${reachableResourceMetadataUrl}", error="invalid_token"`,
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
      'edit_project',
      'compile_project',
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
            'www-authenticate': `Bearer resource_metadata="${reachableResourceMetadataUrl}", error="insufficient_scope", scope="proposals:write"`,
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
        extra: { claims, privateAccess },
      },
    });
  };
  const protectedHandler = requireMcpAuth(
    context.auth,
    (request, claims) => handleAuthenticatedRequest(request, claims),
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
  const servePrivateRequest = async (request: FastifyRequest, reply: FastifyReply) => {
    const webRequest = toWebRequest(context, request);
    const clientId = trustedPrivateMcpClient(context.config, webRequest.headers);
    if (!clientId) return reply.code(401).send({ error: 'Private identity required' });
    const [user] = await context.db
      .select({ id: users.id })
      .from(users)
      .innerJoin(oauthClients, eq(oauthClients.userId, users.id))
      .where(
        and(
          eq(users.email, context.config.AGENT_MCP_PRIVATE_OWNER_EMAIL ?? ''),
          eq(users.emailVerified, true),
          eq(oauthClients.clientId, clientId),
          eq(oauthClients.disabled, false),
        ),
      )
      .limit(1);
    if (!user) return reply.code(401).send({ error: 'Private identity required' });
    const claims = {
      sub: user.id,
      client_id: clientId,
      scope: 'projects:read proposals:write',
      exp: Math.floor(Date.now() / 1000) + 900,
    };
    return sendWebResponse(await handleAuthenticatedRequest(webRequest, claims, true), reply);
  };
  app.post(
    '/api/mcp/private',
    { bodyLimit: agentProposalLimits.maxProposalBytes * 6 + 256 * 1024 },
    servePrivateRequest,
  );
  app.post(
    '/api/mcp',
    { bodyLimit: agentProposalLimits.maxProposalBytes * 6 + 256 * 1024 },
    async (request, reply) => {
      if (request.headers['x-workshop-tailnet-key'] || request.headers['x-workshop-tunnel-key'])
        return servePrivateRequest(request, reply);
      const body = request.body;
      const method =
        body !== null && typeof body === 'object' && 'method' in body ? body.method : undefined;
      if (
        method === 'initialize' ||
        method === 'notifications/initialized' ||
        method === 'tools/list'
      ) {
        // Tunnel startup needs only protocol metadata. Every data-bearing method still
        // passes through the OAuth guard below.
        const claims = {
          sub: 'mcp-discovery',
          client_id: 'mcp-discovery',
          scope: 'projects:read',
          exp: Math.floor(Date.now() / 1000) + 60,
        };
        const response = await mcpHandler.fetch(toWebRequest(context, request), {
          parsedBody: body,
          authInfo: {
            token: 'mcp-discovery',
            clientId: claims.client_id,
            scopes: ['projects:read'],
            expiresAt: claims.exp,
            resource: new URL(resource),
            extra: { claims },
          },
        });
        return sendWebResponse(response, reply);
      }
      const response = await protectedHandler(toWebRequest(context, request));
      const challenge = response.headers.get('www-authenticate');
      if (challenge?.includes('resource_metadata=')) {
        const headers = new Headers(response.headers);
        headers.set(
          'www-authenticate',
          rewriteMcpResourceMetadataChallenge(challenge, resource, context.config.API_ORIGIN),
        );
        return sendWebResponse(
          new Response(response.body, { status: response.status, headers }),
          reply,
        );
      }
      return sendWebResponse(response, reply);
    },
  );
  app.addHook('onClose', async () => mcpHandler.close());
}
