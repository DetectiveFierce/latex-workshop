import { z } from 'zod';
import {
  keyboardShortcutsResponseSchema,
  putKeyboardShortcutsSchema,
} from './keyboard-shortcuts.js';
import {
  forwardSyncRequestSchema,
  inverseSyncRequestSchema,
  inverseSyncResultSchema,
  pdfSyncResultSchema,
} from './pdf-sync.js';
import {
  editHistoryCheckoutSchema,
  editHistoryCommitSchema,
  editHistoryNodeSchema,
  editHistoryResponseSchema,
} from './edit-history.js';
export * from './paths.js';
export * from './text-merge.js';
export * from './keyboard-shortcuts.js';
export * from './pdf-sync.js';
export * from './edit-history.js';

export const idSchema = z.uuid();
export const compilerEngineSchema = z.enum(['pdflatex', 'xelatex', 'lualatex']);
export type CompilerEngine = z.infer<typeof compilerEngineSchema>;

export const projectSchema = z.object({
  id: idSchema,
  name: z.string(),
  compiler: compilerEngineSchema,
  mainFileId: idSchema.nullable(),
  autoCompile: z.boolean(),
  sourceRevision: z.number().int(),
  trashedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Project = z.infer<typeof projectSchema>;

export const tagColorSchema = z.enum([
  'slate',
  'green',
  'cyan',
  'blue',
  'amber',
  'orange',
  'magenta',
  'red',
]);
export type TagColor = z.infer<typeof tagColorSchema>;

export const libraryFolderSchema = z.object({
  id: idSchema,
  parentId: idSchema.nullable(),
  name: z.string(),
  trashedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type LibraryFolder = z.infer<typeof libraryFolderSchema>;

export const projectTagSchema = z.object({
  id: idSchema,
  name: z.string(),
  color: tagColorSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ProjectTag = z.infer<typeof projectTagSchema>;

export const libraryProjectSchema = projectSchema.extend({
  folderId: idSchema.nullable(),
  favorite: z.boolean(),
  lastOpenedAt: z.iso.datetime().nullable(),
  trashedByFolderId: idSchema.nullable(),
  previewJobId: idSchema.nullable(),
  tags: z.array(projectTagSchema),
});
export type LibraryProject = z.infer<typeof libraryProjectSchema>;

export const libraryResponseSchema = z.object({
  projects: z.array(libraryProjectSchema),
  folders: z.array(libraryFolderSchema),
  tags: z.array(projectTagSchema),
});
export type LibraryResponse = z.infer<typeof libraryResponseSchema>;

export const entrySchema = z.object({
  id: idSchema,
  projectId: idSchema,
  parentId: idSchema.nullable(),
  name: z.string(),
  kind: z.enum(['file', 'folder']),
  mimeType: z.string().nullable(),
  size: z.number().int(),
  version: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ProjectEntry = z.infer<typeof entrySchema>;

export const diagnosticSchema = z.object({
  severity: z.enum(['error', 'warning', 'info', 'hint']),
  file: z.string().nullable(),
  line: z.number().int().nullable(),
  column: z.number().int().nullable(),
  message: z.string(),
  source: z.enum(['latex', 'texlab']),
});
export type Diagnostic = z.infer<typeof diagnosticSchema>;

export const compileStatusSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
]);
export const compileJobSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  checkpointId: idSchema,
  sourceRevision: z.number().int(),
  engine: compilerEngineSchema,
  status: compileStatusSchema,
  trigger: z.enum(['manual', 'auto']),
  log: z.string(),
  diagnostics: z.array(diagnosticSchema),
  durationMs: z.number().int().nullable(),
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
});
export type CompileJob = z.infer<typeof compileJobSchema>;

export const checkpointSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  sourceRevision: z.number().int(),
  reason: z.enum(['periodic', 'compile', 'import', 'restore']),
  createdAt: z.iso.datetime(),
});
export type Checkpoint = z.infer<typeof checkpointSchema>;

export const apiErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(120),
  folderId: idSchema.nullable().optional(),
});
export const updateProjectSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  compiler: compilerEngineSchema.optional(),
  mainFileId: idSchema.optional(),
  autoCompile: z.boolean().optional(),
});
export const createEntrySchema = z.object({
  parentId: idSchema.nullable().default(null),
  name: z.string().trim().min(1).max(255),
  kind: z.enum(['file', 'folder']),
  content: z.string().max(2_000_000).optional(),
});
export const moveEntrySchema = z.object({
  parentId: idSchema.nullable().optional(),
  name: z.string().trim().min(1).max(255).optional(),
});
export const saveTextSchema = z.object({
  baseVersion: z.number().int().nonnegative(),
  content: z.string(),
});
export const compileRequestSchema = z.object({
  trigger: z.enum(['manual', 'auto']).default('manual'),
});
export const createLibraryFolderSchema = z.object({
  name: z.string().trim().min(1).max(120),
  parentId: idSchema.nullable().default(null),
});
export const updateLibraryFolderSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    parentId: idSchema.nullable().optional(),
  })
  .refine((value) => value.name !== undefined || value.parentId !== undefined, {
    message: 'Provide a name or destination',
  });
export const createProjectTagSchema = z.object({
  name: z.string().trim().min(1).max(40),
  color: tagColorSchema.default('green'),
});
export const updateProjectTagSchema = z
  .object({
    name: z.string().trim().min(1).max(40).optional(),
    color: tagColorSchema.optional(),
  })
  .refine((value) => value.name !== undefined || value.color !== undefined, {
    message: 'Provide a name or color',
  });
const bulkProjectIdsSchema = z.array(idSchema).min(1).max(250);
export const bulkLibraryActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('move'),
    projectIds: bulkProjectIdsSchema,
    folderId: idSchema.nullable(),
  }),
  z.object({
    action: z.literal('add-tags'),
    projectIds: bulkProjectIdsSchema,
    tagIds: z.array(idSchema).min(1),
  }),
  z.object({
    action: z.literal('remove-tags'),
    projectIds: bulkProjectIdsSchema,
    tagIds: z.array(idSchema).min(1),
  }),
  z.object({ action: z.literal('favorite'), projectIds: bulkProjectIdsSchema, value: z.boolean() }),
  z.object({ action: z.literal('trash'), projectIds: bulkProjectIdsSchema }),
  z.object({ action: z.literal('restore'), projectIds: bulkProjectIdsSchema }),
  z.object({ action: z.literal('delete'), projectIds: bulkProjectIdsSchema }),
]);

export type CompileEvent =
  | { type: 'status'; job: CompileJob }
  | { type: 'log'; jobId: string; chunk: string }
  | { type: 'heartbeat'; at: string };

export const limits = {
  maxZipEntries: 5_000,
  maxTextBytes: 2_000_000,
} as const;

const schemaObject = (schema: z.ZodType) => {
  const value = z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>;
  delete value.$schema;
  return value;
};

export function buildOpenApiDocument(serverUrl: string) {
  const json = (schema: string) => ({
    'application/json': { schema: { $ref: `#/components/schemas/${schema}` } },
  });
  const response = (schema?: string, description = 'Successful response') => ({
    description,
    ...(schema ? { content: json(schema) } : {}),
  });
  const body = (schema: string) => ({ required: true, content: json(schema) });
  const projectPath = {
    name: 'projectId',
    in: 'path' as const,
    required: true,
    schema: { type: 'string' as const, format: 'uuid' },
  };
  const entryPath = {
    name: 'entryId',
    in: 'path' as const,
    required: true,
    schema: { type: 'string' as const, format: 'uuid' },
  };
  const checkpointPath = {
    name: 'checkpointId',
    in: 'path' as const,
    required: true,
    schema: { type: 'string' as const, format: 'uuid' },
  };
  const jobPath = {
    name: 'jobId',
    in: 'path' as const,
    required: true,
    schema: { type: 'string' as const, format: 'uuid' },
  };
  const historyNodePath = {
    name: 'nodeId',
    in: 'path' as const,
    required: true,
    schema: { type: 'string' as const, format: 'uuid' },
  };
  const folderPath = {
    name: 'folderId',
    in: 'path' as const,
    required: true,
    schema: { type: 'string' as const, format: 'uuid' },
  };
  const tagPath = {
    name: 'tagId',
    in: 'path' as const,
    required: true,
    schema: { type: 'string' as const, format: 'uuid' },
  };
  return {
    openapi: '3.1.0' as const,
    info: {
      title: 'LaTeX Workshop API',
      version: '1.0.0',
      description: 'Owner-scoped project, history, compilation, artifact, and transfer API.',
    },
    servers: [{ url: serverUrl }],
    security: [{ cookieSession: [] }],
    tags: [
      'Library',
      'Projects',
      'Entries',
      'Compilations',
      'History',
      'Transfers',
      'Preferences',
    ].map((name) => ({ name })),
    paths: {
      '/api/v1/preferences/keyboard-shortcuts': {
        get: {
          tags: ['Preferences'],
          summary: 'Load account keyboard shortcut overrides',
          responses: { 200: response('KeyboardShortcutsResponse') },
        },
        put: {
          tags: ['Preferences'],
          summary: 'Replace account keyboard shortcut overrides',
          requestBody: body('PutKeyboardShortcuts'),
          responses: { 200: response('KeyboardShortcutsResponse') },
        },
      },
      '/api/v1/library': {
        get: {
          tags: ['Library'],
          summary: 'Load personal project organization',
          responses: { 200: response('LibraryResponse') },
        },
      },
      '/api/v1/library/folders': {
        post: {
          tags: ['Library'],
          summary: 'Create a personal library folder',
          requestBody: body('CreateLibraryFolder'),
          responses: { 201: response('LibraryFolderResponse') },
        },
      },
      '/api/v1/library/folders/{folderId}': {
        patch: {
          tags: ['Library'],
          summary: 'Rename or move a library folder',
          parameters: [folderPath],
          requestBody: body('UpdateLibraryFolder'),
          responses: { 200: response('LibraryFolderResponse') },
        },
        delete: {
          tags: ['Library'],
          summary: 'Trash or permanently delete a folder subtree',
          parameters: [folderPath],
          responses: { 204: response(undefined, 'Deleted') },
        },
      },
      '/api/v1/library/folders/{folderId}/restore': {
        post: {
          tags: ['Library'],
          summary: 'Restore a folder subtree and projects trashed with it',
          parameters: [folderPath],
          responses: { 200: response('LibraryFolderResponse') },
        },
      },
      '/api/v1/library/tags': {
        post: {
          tags: ['Library'],
          summary: 'Create a personal project tag',
          requestBody: body('CreateProjectTag'),
          responses: { 201: response('ProjectTagResponse') },
        },
      },
      '/api/v1/library/tags/{tagId}': {
        patch: {
          tags: ['Library'],
          summary: 'Rename or recolor a project tag',
          parameters: [tagPath],
          requestBody: body('UpdateProjectTag'),
          responses: { 200: response('ProjectTagResponse') },
        },
        delete: {
          tags: ['Library'],
          summary: 'Delete a project tag and its assignments',
          parameters: [tagPath],
          responses: { 204: response(undefined, 'Deleted') },
        },
      },
      '/api/v1/library/projects/actions': {
        post: {
          tags: ['Library'],
          summary: 'Apply an atomic action to multiple projects',
          requestBody: body('BulkLibraryAction'),
          responses: { 200: response('BulkLibraryActionResponse') },
        },
      },
      '/api/v1/library/projects/{projectId}/opened': {
        post: {
          tags: ['Library'],
          summary: 'Record a project open for the Recent view',
          parameters: [projectPath],
          responses: { 204: response(undefined, 'Recorded') },
        },
      },
      '/api/v1/projects': {
        get: {
          tags: ['Projects'],
          summary: 'List active or trashed projects',
          responses: { 200: response('ProjectList') },
        },
        post: {
          tags: ['Projects'],
          summary: 'Create a blank project',
          requestBody: body('CreateProject'),
          responses: { 201: response('ProjectResponse') },
        },
      },
      '/api/v1/projects/{projectId}': {
        get: {
          tags: ['Projects'],
          summary: 'Get project workspace metadata',
          parameters: [projectPath],
          responses: { 200: response('ProjectWorkspace') },
        },
        patch: {
          tags: ['Projects'],
          summary: 'Update project settings',
          parameters: [projectPath],
          requestBody: body('UpdateProject'),
          responses: { 200: response('ProjectResponse') },
        },
        delete: {
          tags: ['Projects'],
          summary: 'Trash or permanently delete a project',
          parameters: [projectPath],
          responses: { 204: response(undefined, 'Deleted') },
        },
      },
      '/api/v1/projects/{projectId}/duplicate': {
        post: {
          tags: ['Projects'],
          summary: 'Duplicate a project',
          parameters: [projectPath],
          responses: { 201: response('ProjectResponse') },
        },
      },
      '/api/v1/projects/{projectId}/restore': {
        post: {
          tags: ['Projects'],
          summary: 'Restore a trashed project',
          parameters: [projectPath],
          responses: { 200: response('ProjectResponse') },
        },
      },
      '/api/v1/projects/{projectId}/entries': {
        post: {
          tags: ['Entries'],
          summary: 'Create a file or folder',
          parameters: [projectPath],
          requestBody: body('CreateEntry'),
          responses: { 201: response('EntryResponse') },
        },
      },
      '/api/v1/projects/{projectId}/entries/{entryId}': {
        patch: {
          tags: ['Entries'],
          summary: 'Rename or move an entry',
          parameters: [projectPath, entryPath],
          requestBody: body('MoveEntry'),
          responses: { 200: response('EntryResponse') },
        },
        delete: {
          tags: ['Entries'],
          summary: 'Delete an entry subtree',
          parameters: [projectPath, entryPath],
          responses: { 204: response(undefined, 'Deleted') },
        },
      },
      '/api/v1/projects/{projectId}/entries/{entryId}/content': {
        get: {
          tags: ['Entries'],
          summary: 'Read text or binary content',
          parameters: [projectPath, entryPath],
          responses: { 200: response(undefined, 'File content') },
        },
        put: {
          tags: ['Entries'],
          summary: 'Compare-and-swap a text file',
          parameters: [projectPath, entryPath],
          requestBody: body('SaveText'),
          responses: { 200: response('EntryResponse'), 409: response('ApiError') },
        },
      },
      '/api/v1/projects/{projectId}/entries/{entryId}/duplicate': {
        post: {
          tags: ['Entries'],
          summary: 'Duplicate a file or folder subtree',
          parameters: [projectPath, entryPath],
          responses: { 201: response('EntryResponse') },
        },
      },
      '/api/v1/projects/{projectId}/uploads/presign': {
        post: {
          tags: ['Entries'],
          summary: 'Create a short-lived binary upload URL',
          parameters: [projectPath],
          responses: { 200: response(undefined, 'Presigned upload') },
        },
      },
      '/api/v1/projects/{projectId}/uploads/finalize': {
        post: {
          tags: ['Entries'],
          summary: 'Finalize an uploaded object',
          parameters: [projectPath],
          responses: { 201: response('EntryResponse') },
        },
      },
      '/api/v1/projects/{projectId}/compilations': {
        get: {
          tags: ['Compilations'],
          summary: 'List compilation jobs',
          parameters: [projectPath],
          responses: { 200: response('CompileList') },
        },
        post: {
          tags: ['Compilations'],
          summary: 'Checkpoint and queue a compilation',
          parameters: [projectPath],
          requestBody: body('CompileRequest'),
          responses: { 202: response('CompileResponse') },
        },
      },
      '/api/v1/projects/{projectId}/compilations/{jobId}': {
        get: {
          tags: ['Compilations'],
          summary: 'Get a compilation job',
          parameters: [projectPath, jobPath],
          responses: { 200: response('CompileResponse') },
        },
        delete: {
          tags: ['Compilations'],
          summary: 'Cancel a compilation',
          parameters: [projectPath, jobPath],
          responses: { 204: response(undefined, 'Cancelled') },
        },
      },
      '/api/v1/projects/{projectId}/compile-events': {
        get: {
          tags: ['Compilations'],
          summary: 'Stream compilation events with SSE',
          parameters: [projectPath],
          responses: { 200: { description: 'text/event-stream' } },
        },
      },
      '/api/v1/projects/{projectId}/compilations/{jobId}/pdf': {
        get: {
          tags: ['Compilations'],
          summary: 'Read an authorized range-capable PDF',
          parameters: [projectPath, jobPath],
          responses: {
            200: { description: 'PDF artifact' },
            206: { description: 'PDF byte range' },
          },
        },
      },
      '/api/v1/projects/{projectId}/compilations/{jobId}/synctex/forward': {
        post: {
          tags: ['Compilations'],
          summary: 'Map source position to PDF coordinates',
          parameters: [projectPath, jobPath],
          requestBody: body('ForwardSyncRequest'),
          responses: { 200: response('PdfSyncResult') },
        },
      },
      '/api/v1/projects/{projectId}/compilations/{jobId}/synctex/inverse': {
        post: {
          tags: ['Compilations'],
          summary: 'Map PDF coordinates to source position',
          parameters: [projectPath, jobPath],
          requestBody: body('InverseSyncRequest'),
          responses: { 200: response('InverseSyncResult') },
        },
      },
      '/api/v1/projects/{projectId}/entries/{entryId}/edit-history': {
        get: {
          tags: ['History'],
          summary: 'List the durable edit-history tree and current head',
          parameters: [projectPath, entryPath],
          responses: { 200: response('EditHistoryResponse') },
        },
      },
      '/api/v1/projects/{projectId}/entries/{entryId}/edit-history/{nodeId}/content': {
        get: {
          tags: ['History'],
          summary: 'Materialize an edit-history node',
          parameters: [projectPath, entryPath, historyNodePath],
          responses: { 200: response(undefined, 'Edit-history node content') },
        },
      },
      '/api/v1/projects/{projectId}/entries/{entryId}/edit-history/commit': {
        post: {
          tags: ['History'],
          summary: 'Atomically persist text and an idempotent history node',
          parameters: [projectPath, entryPath],
          requestBody: body('EditHistoryCommit'),
          responses: { 200: response(undefined, 'Committed edit-history node') },
        },
      },
      '/api/v1/projects/{projectId}/entries/{entryId}/edit-history/checkout': {
        post: {
          tags: ['History'],
          summary: 'Check out an undo, redo, or alternate branch node',
          parameters: [projectPath, entryPath],
          requestBody: body('EditHistoryCheckout'),
          responses: { 200: response(undefined, 'Checked-out edit-history node') },
        },
      },
      '/api/v1/projects/{projectId}/checkpoints': {
        get: {
          tags: ['History'],
          summary: 'List retained checkpoints',
          parameters: [projectPath],
          responses: { 200: response('CheckpointList') },
        },
        post: {
          tags: ['History'],
          summary: 'Create a checkpoint',
          parameters: [projectPath],
          responses: { 201: response('CheckpointResponse') },
        },
      },
      '/api/v1/projects/{projectId}/checkpoints/{checkpointId}/files': {
        get: {
          tags: ['History'],
          summary: 'List checkpoint files',
          parameters: [projectPath, checkpointPath],
          responses: { 200: response(undefined, 'Checkpoint files') },
        },
      },
      '/api/v1/projects/{projectId}/checkpoints/{checkpointId}/restore': {
        post: {
          tags: ['History'],
          summary: 'Restore without rewriting history',
          parameters: [projectPath, checkpointPath],
          responses: { 200: response(undefined, 'Restored checkpoint') },
        },
      },
      '/api/v1/projects/import': {
        post: {
          tags: ['Transfers'],
          summary: 'Atomically import a validated ZIP',
          requestBody: {
            required: true,
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object' as const,
                  required: ['file'],
                  properties: { file: { type: 'string' as const, format: 'binary' } },
                },
              },
            },
          },
          responses: { 201: response('ProjectResponse') },
        },
      },
      '/api/v1/projects/import/overleaf': {
        post: {
          tags: ['Transfers'],
          summary: 'Import an Overleaf ZIP containing one ZIP per project',
          requestBody: {
            required: true,
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object' as const,
                  required: ['file'],
                  properties: { file: { type: 'string' as const, format: 'binary' } },
                },
              },
            },
          },
          responses: { 201: response('ProjectList') },
        },
      },
      '/api/v1/projects/{projectId}/export': {
        get: {
          tags: ['Transfers'],
          summary: 'Stream a consistent ZIP snapshot',
          parameters: [projectPath],
          responses: { 200: { description: 'ZIP archive' } },
        },
      },
    },
    components: {
      securitySchemes: {
        cookieSession: {
          type: 'apiKey' as const,
          in: 'cookie' as const,
          name: 'better-auth.session_token',
        },
      },
      schemas: {
        Project: schemaObject(projectSchema),
        LibraryFolder: schemaObject(libraryFolderSchema),
        ProjectTag: schemaObject(projectTagSchema),
        LibraryProject: schemaObject(libraryProjectSchema),
        LibraryResponse: schemaObject(libraryResponseSchema),
        Entry: schemaObject(entrySchema),
        CompileJob: schemaObject(compileJobSchema),
        Checkpoint: schemaObject(checkpointSchema),
        ApiError: schemaObject(apiErrorSchema),
        CreateProject: schemaObject(createProjectSchema),
        CreateLibraryFolder: schemaObject(createLibraryFolderSchema),
        UpdateLibraryFolder: schemaObject(updateLibraryFolderSchema),
        CreateProjectTag: schemaObject(createProjectTagSchema),
        UpdateProjectTag: schemaObject(updateProjectTagSchema),
        BulkLibraryAction: schemaObject(bulkLibraryActionSchema),
        BulkLibraryActionResponse: schemaObject(z.object({ updated: z.number().int() })),
        UpdateProject: schemaObject(updateProjectSchema),
        CreateEntry: schemaObject(createEntrySchema),
        MoveEntry: schemaObject(moveEntrySchema),
        SaveText: schemaObject(saveTextSchema),
        CompileRequest: schemaObject(compileRequestSchema),
        PutKeyboardShortcuts: schemaObject(putKeyboardShortcutsSchema),
        KeyboardShortcutsResponse: schemaObject(keyboardShortcutsResponseSchema),
        ForwardSyncRequest: schemaObject(forwardSyncRequestSchema),
        PdfSyncResult: schemaObject(pdfSyncResultSchema),
        InverseSyncRequest: schemaObject(inverseSyncRequestSchema),
        InverseSyncResult: schemaObject(inverseSyncResultSchema),
        EditHistoryNode: schemaObject(editHistoryNodeSchema),
        EditHistoryResponse: schemaObject(editHistoryResponseSchema),
        EditHistoryCommit: schemaObject(editHistoryCommitSchema),
        EditHistoryCheckout: schemaObject(editHistoryCheckoutSchema),
        ProjectResponse: schemaObject(z.object({ project: projectSchema })),
        LibraryFolderResponse: schemaObject(z.object({ folder: libraryFolderSchema })),
        ProjectTagResponse: schemaObject(z.object({ tag: projectTagSchema })),
        ProjectList: schemaObject(z.object({ projects: z.array(projectSchema) })),
        EntryResponse: schemaObject(z.object({ entry: entrySchema })),
        ProjectWorkspace: schemaObject(
          z.object({
            project: projectSchema,
            entries: z.array(entrySchema),
            latestCompile: compileJobSchema.nullable(),
          }),
        ),
        CompileResponse: schemaObject(z.object({ job: compileJobSchema })),
        CompileList: schemaObject(z.object({ jobs: z.array(compileJobSchema) })),
        CheckpointResponse: schemaObject(z.object({ checkpoint: checkpointSchema })),
        CheckpointList: schemaObject(z.object({ checkpoints: z.array(checkpointSchema) })),
      },
    },
  };
}
