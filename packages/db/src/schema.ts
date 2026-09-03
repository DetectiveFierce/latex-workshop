import { relations, sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  ...timestamps,
});

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    token: text('token').notNull().unique(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    ...timestamps,
  },
  (table) => [index('sessions_user_idx').on(table.userId)],
);

export const accounts = pgTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    issuer: text('issuer').notNull(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    password: text('password'),
    ...timestamps,
  },
  (table) => [
    index('accounts_user_idx').on(table.userId),
    uniqueIndex('accounts_issuer_account_idx').on(table.issuer, table.accountId),
  ],
);

export const verifications = pgTable('verifications', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  ...timestamps,
});

export const userPreferences = pgTable('user_preferences', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  keyboardShortcutOverrides: jsonb('keyboard_shortcut_overrides')
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  keyboardKeymap: text('keyboard_keymap').notNull().default('linux'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const compilerEnum = pgEnum('compiler_engine', ['pdflatex', 'xelatex', 'lualatex']);
export const entryKindEnum = pgEnum('entry_kind', ['file', 'folder']);
export const checkpointReasonEnum = pgEnum('checkpoint_reason', [
  'periodic',
  'compile',
  'import',
  'restore',
]);
export const compileStatusEnum = pgEnum('compile_status', [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
]);
export const compileTriggerEnum = pgEnum('compile_trigger', ['manual', 'auto']);

export const libraryFolders = pgTable(
  'library_folders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    parentId: uuid('parent_id'),
    name: text('name').notNull(),
    trashedAt: timestamp('trashed_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index('library_folders_user_idx').on(table.userId),
    index('library_folders_parent_idx').on(table.parentId),
    uniqueIndex('library_folders_active_sibling_name_idx')
      .on(
        table.userId,
        sql`coalesce(${table.parentId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
        sql`lower(${table.name})`,
      )
      .where(sql`${table.trashedAt} is null`),
  ],
);

export const projectTags = pgTable(
  'project_tags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color').notNull().default('green'),
    ...timestamps,
  },
  (table) => [
    index('project_tags_user_idx').on(table.userId),
    uniqueIndex('project_tags_user_name_idx').on(table.userId, sql`lower(${table.name})`),
  ],
);

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    compiler: compilerEnum('compiler').notNull().default('pdflatex'),
    mainFileId: uuid('main_file_id'),
    autoCompile: boolean('auto_compile').notNull().default(false),
    sourceRevision: integer('source_revision').notNull().default(0),
    isTemplate: boolean('is_template').notNull().default(false),
    trashedAt: timestamp('trashed_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index('projects_trash_idx').on(table.trashedAt),
    index('projects_template_trash_idx').on(table.isTemplate, table.trashedAt),
  ],
);

export const projectMemberships = pgTable(
  'project_memberships',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('owner'),
    folderId: uuid('folder_id').references(() => libraryFolders.id, { onDelete: 'set null' }),
    favorite: boolean('favorite').notNull().default(false),
    lastOpenedAt: timestamp('last_opened_at', { withTimezone: true }),
    trashedByFolderId: uuid('trashed_by_folder_id').references(() => libraryFolders.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.userId] }),
    index('memberships_user_idx').on(table.userId),
    index('memberships_folder_idx').on(table.folderId),
  ],
);

export const userTemplateSeeds = pgTable(
  'user_template_seeds',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    seedKey: text('seed_key').notNull(),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.seedKey] }),
    uniqueIndex('user_template_seeds_project_idx').on(table.projectId),
  ],
);

export const projectTagAssignments = pgTable(
  'project_tag_assignments',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => projectTags.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.tagId] }),
    index('project_tag_assignments_user_idx').on(table.userId),
    index('project_tag_assignments_tag_idx').on(table.tagId),
  ],
);

export const entries = pgTable(
  'entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    parentId: uuid('parent_id'),
    name: text('name').notNull(),
    kind: entryKindEnum('kind').notNull(),
    mimeType: text('mime_type'),
    size: bigint('size', { mode: 'number' }).notNull().default(0),
    currentVersionId: uuid('current_version_id'),
    version: integer('version').notNull().default(0),
    ...timestamps,
  },
  (table) => [
    index('entries_project_idx').on(table.projectId),
    index('entries_parent_idx').on(table.parentId),
    uniqueIndex('entries_sibling_name_idx').on(
      table.projectId,
      sql`coalesce(${table.parentId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      sql`lower(${table.name})`,
    ),
  ],
);

export type EditorPatch = Array<{ start: number; deleteCount: number; text: string }>;
export type EditorSelectionSnapshot = {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}[];

export const editorHistoryNodes = pgTable(
  'editor_history_nodes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => entries.id, { onDelete: 'cascade' }),
    parentId: uuid('parent_id').references((): AnyPgColumn => editorHistoryNodes.id, {
      onDelete: 'cascade',
    }),
    preferredChildId: uuid('preferred_child_id'),
    depth: integer('depth').notNull().default(0),
    beforeHash: text('before_hash').notNull(),
    afterHash: text('after_hash').notNull(),
    patch: jsonb('patch').$type<EditorPatch>().notNull().default([]),
    snapshotObjectKey: text('snapshot_object_key'),
    summary: text('summary').notNull(),
    selectionBefore: jsonb('selection_before').$type<EditorSelectionSnapshot | null>(),
    selectionAfter: jsonb('selection_after').$type<EditorSelectionSnapshot | null>(),
    clientMutationId: uuid('client_mutation_id').notNull(),
    deviceId: text('device_id'),
    sessionId: text('session_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('editor_history_entry_created_idx').on(table.entryId, table.createdAt),
    uniqueIndex('editor_history_entry_mutation_idx').on(table.entryId, table.clientMutationId),
  ],
);

export const editorHistoryState = pgTable('editor_history_state', {
  entryId: uuid('entry_id')
    .primaryKey()
    .references(() => entries.id, { onDelete: 'cascade' }),
  currentNodeId: uuid('current_node_id')
    .notNull()
    .references(() => editorHistoryNodes.id, { onDelete: 'cascade' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const fileBlobs = pgTable('file_blobs', {
  hash: text('hash').primaryKey(),
  objectKey: text('object_key').notNull().unique(),
  size: bigint('size', { mode: 'number' }).notNull(),
  refCount: integer('ref_count').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const fileVersions = pgTable(
  'file_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => entries.id, { onDelete: 'cascade' }),
    blobHash: text('blob_hash')
      .notNull()
      .references(() => fileBlobs.hash),
    version: integer('version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('file_versions_entry_version_idx').on(table.entryId, table.version)],
);

export type CheckpointManifestEntry = {
  entryId: string;
  path: string;
  versionId: string;
  blobHash: string;
  objectKey: string;
  size: number;
  mimeType: string | null;
};

export const checkpoints = pgTable(
  'checkpoints',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    sourceRevision: integer('source_revision').notNull(),
    reason: checkpointReasonEnum('reason').notNull(),
    manifest: jsonb('manifest').$type<CheckpointManifestEntry[]>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('checkpoints_project_created_idx').on(table.projectId, table.createdAt)],
);

export type StoredDiagnostic = {
  severity: 'error' | 'warning' | 'info' | 'hint';
  file: string | null;
  line: number | null;
  column: number | null;
  message: string;
  source: 'latex' | 'texlab';
};

export const compileJobs = pgTable(
  'compile_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    checkpointId: uuid('checkpoint_id')
      .notNull()
      .references(() => checkpoints.id, { onDelete: 'restrict' }),
    sourceRevision: integer('source_revision').notNull(),
    engine: compilerEnum('engine').notNull(),
    trigger: compileTriggerEnum('trigger').notNull(),
    status: compileStatusEnum('status').notNull().default('queued'),
    log: text('log').notNull().default(''),
    diagnostics: jsonb('diagnostics').$type<StoredDiagnostic[]>().notNull().default([]),
    pdfObjectKey: text('pdf_object_key'),
    synctexObjectKey: text('synctex_object_key'),
    durationMs: integer('duration_ms'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('compile_jobs_project_created_idx').on(table.projectId, table.createdAt)],
);

export const auditEvents = pgTable('audit_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
  action: text('action').notNull(),
  details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const projectRelations = relations(projects, ({ many }) => ({
  memberships: many(projectMemberships),
  tagAssignments: many(projectTagAssignments),
  entries: many(entries),
  checkpoints: many(checkpoints),
  compilations: many(compileJobs),
}));
