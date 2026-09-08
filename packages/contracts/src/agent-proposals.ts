import { z } from 'zod';

const idSchema = z.uuid();

export const agentProposalLimits = {
  maxFileBytes: 2_000_000,
  maxProposalBytes: 10_000_000,
  maxChangedEntries: 100,
  maxFrozenHunks: 2_000,
  maxReadBytes: 256 * 1024,
} as const;

export const agentPdfPageLimits = {
  maxPagesPerRequest: 3,
  maxPageNumber: 10_000,
  maxPdfBytes: 50 * 1024 * 1024,
  maxImageBytes: 6 * 1024 * 1024,
  renderRequestTtlSeconds: 300,
} as const;

const pdfPageNumbersSchema = z
  .array(z.number().int().min(1).max(agentPdfPageLimits.maxPageNumber))
  .min(1)
  .max(agentPdfPageLimits.maxPagesPerRequest)
  .refine((pages) => new Set(pages).size === pages.length, {
    message: 'Page numbers must be unique',
  });

export const agentPdfPageRequestSchema = z.object({
  proposalId: idSchema.describe('Proposal id whose compiled PDF should be inspected'),
  compileJobId: idSchema.describe('Exact succeeded compile job id returned by a compile tool'),
  pages: pdfPageNumbersSchema.describe(
    `One to ${agentPdfPageLimits.maxPagesPerRequest} one-based PDF page numbers`,
  ),
});
export type AgentPdfPageRequest = z.infer<typeof agentPdfPageRequestSchema>;

export const agentPdfPageResponseSchema = z.object({
  compileJobId: idSchema,
  pages: z.array(
    z.object({
      page: z.number().int().positive(),
      mimeType: z.literal('image/png'),
    }),
  ),
});

export const pdfPageRenderQueuePayloadSchema = z.object({ compileJobId: idSchema });
export const pdfPageRenderRequestSchema = z.object({
  projectId: idSchema,
  compileJobId: idSchema,
  pages: pdfPageNumbersSchema,
});
export const pdfPageRenderResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('queued') }),
  z.object({ status: z.literal('running') }),
  z.object({ status: z.literal('failed'), message: z.string().min(1).max(1_000) }),
  z.object({
    status: z.literal('succeeded'),
    pages: z.array(
      z.object({
        page: z.number().int().positive(),
        objectKey: z.string().min(1),
      }),
    ),
  }),
]);
export type PdfPageRenderRequest = z.infer<typeof pdfPageRenderRequestSchema>;

export function pdfPageRenderRequestKey(renderRequestId: string) {
  return `pdf-page-render:${renderRequestId}`;
}

export function pdfPageImageObjectKey(projectId: string, compileJobId: string, page: number) {
  return `artifacts/${projectId}/${compileJobId}/pages/${page}.png`;
}

export const agentProposalStatusSchema = z.enum([
  'draft',
  'needs_rebase',
  'reviewing',
  'resolved',
  'rejected',
]);
export type AgentProposalStatus = z.infer<typeof agentProposalStatusSchema>;

export const agentDecisionSchema = z.enum(['pending', 'accepted', 'rejected', 'conflicted']);
export type AgentDecision = z.infer<typeof agentDecisionSchema>;

export const agentChangeOperationSchema = z.enum([
  'create_file',
  'replace_file',
  'create_folder',
  'move',
  'delete',
]);
export type AgentChangeOperation = z.infer<typeof agentChangeOperationSchema>;

export const agentProposalHunkSchema = z.object({
  id: idSchema,
  changeId: idSchema,
  baseStart: z.number().int().nonnegative(),
  baseEnd: z.number().int().nonnegative(),
  baseText: z.string(),
  replacementText: z.string(),
  contentHash: z.string().length(64),
  decision: agentDecisionSchema,
  order: z.number().int().nonnegative(),
});
export type AgentProposalHunk = z.infer<typeof agentProposalHunkSchema>;

export const agentProposalChangeSchema = z.object({
  id: idSchema,
  operation: agentChangeOperationSchema,
  entryId: idSchema.nullable(),
  entryKind: z.enum(['file', 'folder']),
  basePath: z.string().nullable(),
  targetPath: z.string().nullable(),
  baseVersion: z.number().int().nonnegative().nullable(),
  baseHash: z.string().length(64).nullable(),
  contentHash: z.string().length(64).nullable(),
  size: z.number().int().nonnegative(),
  decision: agentDecisionSchema,
  hunks: z.array(agentProposalHunkSchema),
});
export type AgentProposalChange = z.infer<typeof agentProposalChangeSchema>;

export const agentProposalSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  clientId: z.string().min(1),
  clientName: z.string().min(1),
  title: z.string().min(1).max(200),
  status: agentProposalStatusSchema,
  revision: z.number().int().nonnegative(),
  changedEntryCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  conflicts: z.array(z.string()),
  changes: z.array(agentProposalChangeSchema),
  compileJobId: idSchema.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type AgentProposal = z.infer<typeof agentProposalSchema>;

export function allProposalItemsAccepted(
  changes: readonly {
    operation: AgentChangeOperation;
    decision: AgentDecision;
    hunks: readonly { decision: AgentDecision }[];
  }[],
): boolean {
  return changes.every((change) => {
    if (
      change.operation === 'create_folder' ||
      change.operation === 'move' ||
      change.operation === 'delete'
    )
      return change.decision === 'accepted';
    return change.hunks.every((hunk) => hunk.decision === 'accepted');
  });
}

export const agentProposalResponseSchema = z.object({ proposal: agentProposalSchema });
export const activeAgentProposalResponseSchema = z.object({
  proposal: agentProposalSchema.nullable(),
});

export const proposalMutationSchema = z.object({
  expectedProposalRevision: z
    .number()
    .int()
    .nonnegative()
    .describe('Revision from the immediately preceding proposal response'),
  idempotencyKey: z
    .uuid()
    .describe('Fresh UUID for this distinct mutation; reuse only to retry the same operation'),
});

export const startAgentProposalSchema = z.object({
  projectId: idSchema.describe('Project id selected from list_projects'),
  title: z.string().trim().min(1).max(200).describe('Short owner-facing summary of the change'),
  idempotencyKey: z.uuid().describe('Fresh UUID for starting this proposal'),
});

export const createAgentProjectSchema = z.object({
  name: z.string().trim().min(1).max(120).describe('Name for the new project'),
  sourceProjectId: idSchema
    .optional()
    .describe(
      'Granted project or template whose accepted source should seed the new project/template; omit for the standard blank document',
    ),
  isTemplate: z
    .boolean()
    .default(false)
    .describe(
      'false creates a normal project (including one seeded from a template); true creates a reusable item in the personal Templates library',
    ),
  idempotencyKey: z.uuid().describe('Fresh UUID for creating this project'),
});

export const renameAgentProjectSchema = z.object({
  projectId: idSchema.describe('Project id selected from list_projects'),
  name: z.string().trim().min(1).max(120).describe('New displayed project name'),
  idempotencyKey: z.uuid().describe('Fresh UUID for renaming this project'),
});

export const putAgentProposalFileSchema = proposalMutationSchema.extend({
  path: z.string().trim().min(1).max(4_096).describe('Exact normalized project-relative path'),
  content: z
    .string()
    .max(agentProposalLimits.maxFileBytes)
    .describe('Complete resulting UTF-8 file content, not a diff or patch'),
  baseHash: z
    .string()
    .length(64)
    .nullable()
    .optional()
    .describe('read_text_file hash for an existing file; null/omitted for a new file'),
});

const structureItemSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('create_folder'),
    targetPath: z
      .string()
      .min(1)
      .max(4_096)
      .describe('New normalized project-relative folder path'),
  }),
  z.object({
    operation: z.literal('move'),
    basePath: z.string().min(1).max(4_096).describe('Exact current path from get_project_tree'),
    targetPath: z.string().min(1).max(4_096).describe('New normalized project-relative path'),
  }),
  z.object({
    operation: z.literal('delete'),
    basePath: z.string().min(1).max(4_096).describe('Exact current path from get_project_tree'),
  }),
]);
export const proposeAgentStructureSchema = proposalMutationSchema.extend({
  changes: z.array(structureItemSchema).min(1).max(agentProposalLimits.maxChangedEntries),
});

export const proposalDecisionSchema = z.object({
  expectedProposalRevision: z.number().int().nonnegative(),
  itemId: idSchema,
  decision: z.enum(['accepted', 'rejected']),
});

export const proposalBulkDecisionSchema = z.object({
  expectedProposalRevision: z.number().int().nonnegative(),
  decision: z.enum(['accepted', 'rejected']),
});

export const agentProposalFileQuerySchema = z.object({
  path: z.string().trim().min(1).max(4_096),
});

export const agentProposalFileResponseSchema = z.object({
  path: z.string(),
  baseText: z.string().max(agentProposalLimits.maxFileBytes),
  proposedText: z.string().max(agentProposalLimits.maxFileBytes),
  version: z.number().int().nonnegative(),
  hash: z.string().length(64),
});

export const putOwnerProposalFileSchema = z.object({
  expectedProposalRevision: z.number().int().nonnegative(),
  path: z.string().trim().min(1).max(4_096),
  content: z.string().max(agentProposalLimits.maxFileBytes),
});

export const reviseAgentProposalHunkSchema = z.object({
  expectedProposalRevision: z.number().int().nonnegative(),
  replacementText: z.string().max(agentProposalLimits.maxFileBytes),
});

export const agentGrantSchema = z.object({
  clientId: z.string().min(1),
  clientName: z.string().min(1),
  projectIds: z.array(idSchema),
  allProjects: z.boolean().default(false),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type AgentGrant = z.infer<typeof agentGrantSchema>;

export const agentGrantsResponseSchema = z.object({ connections: z.array(agentGrantSchema) });
export const agentClientMetadataSchema = z.object({
  clientId: z.string().min(1),
  clientName: z.string().min(1),
});
export const putAgentGrantSchema = z.object({
  projectIds: z.array(idSchema).max(250).default([]),
  allProjects: z.boolean().default(false),
});
export const putAgentConnectionGrantSchema = putAgentGrantSchema.extend({
  clientId: z.string().min(1).max(4_096),
});
export const agentConnectionQuerySchema = z.object({ clientId: z.string().min(1).max(4_096) });

export const agentProposalEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('proposal'), proposalId: idSchema, revision: z.number().int() }),
  z.object({ type: z.literal('heartbeat'), at: z.iso.datetime() }),
]);
export type AgentProposalEvent = z.infer<typeof agentProposalEventSchema>;

export const readTextFileSchema = z.object({
  projectId: idSchema.describe('Project id selected from list_projects'),
  path: z.string().min(1).max(4_096).describe('Exact editable path from get_project_tree'),
  offset: z.number().int().nonnegative().default(0).describe('Byte offset; use prior nextOffset'),
  limit: z
    .number()
    .int()
    .min(4)
    .max(agentProposalLimits.maxReadBytes)
    .default(64 * 1024)
    .describe('Maximum UTF-8 bytes to return in this page'),
});

export const projectTreeItemSchema = z.object({
  path: z.string(),
  kind: z.enum(['file', 'folder']),
  editable: z.boolean(),
  mimeType: z.string().nullable(),
  size: z.number().int().nonnegative(),
  version: z.number().int().nonnegative(),
  hash: z.string().length(64).nullable(),
});

export const agentProjectTreeSchema = z.object({
  projectId: idSchema,
  sourceRevision: z.number().int().nonnegative(),
  entries: z.array(projectTreeItemSchema),
});
