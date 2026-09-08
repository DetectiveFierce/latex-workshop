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

export const jwks = pgTable('jwks', {
  id: text('id').primaryKey(),
  publicKey: text('public_key').notNull(),
  privateKey: text('private_key').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  alg: text('alg'),
  crv: text('crv'),
});

export const oauthClients = pgTable(
  'oauth_clients',
  {
    id: text('id').primaryKey(),
    clientId: text('client_id').notNull().unique(),
    clientSecret: text('client_secret'),
    clientDiscoveryId: text('client_discovery_id'),
    disabled: boolean('disabled').notNull().default(false),
    skipConsent: boolean('skip_consent'),
    enableEndSession: boolean('enable_end_session'),
    subjectType: text('subject_type'),
    scopes: text('scopes').array(),
    clientCredentialsScopes: text('client_credentials_scopes').array().notNull().default([]),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    name: text('name'),
    uri: text('uri'),
    icon: text('icon'),
    contacts: text('contacts').array(),
    tos: text('tos'),
    policy: text('policy'),
    softwareId: text('software_id'),
    softwareVersion: text('software_version'),
    softwareStatement: text('software_statement'),
    redirectUris: text('redirect_uris').array().notNull(),
    postLogoutRedirectUris: text('post_logout_redirect_uris').array(),
    backchannelLogoutUri: text('backchannel_logout_uri'),
    backchannelLogoutSessionRequired: boolean('backchannel_logout_session_required'),
    tokenEndpointAuthMethod: text('token_endpoint_auth_method'),
    applicationType: text('application_type'),
    clientJwks: text('jwks'),
    jwksUri: text('jwks_uri'),
    grantTypes: text('grant_types').array(),
    responseTypes: text('response_types').array(),
    requirePKCE: boolean('require_pkce'),
    dpopBoundAccessTokens: boolean('dpop_bound_access_tokens').notNull().default(false),
    referenceId: text('reference_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    ...timestamps,
  },
  (table) => [index('oauth_clients_user_idx').on(table.userId)],
);

export const oauthResources = pgTable('oauth_resources', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull().unique(),
  name: text('name').notNull(),
  accessTokenTtl: integer('access_token_ttl'),
  refreshTokenTtl: integer('refresh_token_ttl'),
  signingAlgorithm: text('signing_algorithm'),
  signingKeyId: text('signing_key_id'),
  allowedScopes: text('allowed_scopes').array(),
  customClaims: jsonb('custom_claims').$type<Record<string, unknown>>(),
  dpopBoundAccessTokensRequired: boolean('dpop_bound_access_tokens_required').default(false),
  disabled: boolean('disabled').default(false),
  policyVersion: integer('policy_version').default(1),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  ...timestamps,
});

export const oauthClientResources = pgTable(
  'oauth_client_resources',
  {
    id: text('id').primaryKey(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: 'cascade' }),
    resourceId: text('resource_id')
      .notNull()
      .references(() => oauthResources.identifier, { onDelete: 'cascade' }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('oauth_client_resources_pair_idx').on(table.clientId, table.resourceId),
    index('oauth_client_resources_client_idx').on(table.clientId),
    index('oauth_client_resources_resource_idx').on(table.resourceId),
  ],
);

export const oauthRefreshTokens = pgTable(
  'oauth_refresh_tokens',
  {
    id: text('id').primaryKey(),
    token: text('token').notNull().unique(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClients.clientId),
    sessionId: text('session_id').references(() => sessions.id, { onDelete: 'set null' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    referenceId: text('reference_id'),
    authorizationCodeId: text('authorization_code_id'),
    resources: text('resources').array(),
    requestedUserInfoClaims: text('requested_user_info_claims').array(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    revoked: timestamp('revoked', { withTimezone: true }),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    rotationReplayResponse: text('rotation_replay_response'),
    rotationReplayExpiresAt: timestamp('rotation_replay_expires_at', { withTimezone: true }),
    authTime: timestamp('auth_time', { withTimezone: true }),
    confirmation: jsonb('confirmation').$type<Record<string, unknown>>(),
    scopes: text('scopes').array().notNull(),
  },
  (table) => [
    index('oauth_refresh_client_idx').on(table.clientId),
    index('oauth_refresh_session_idx').on(table.sessionId),
    index('oauth_refresh_user_idx').on(table.userId),
    index('oauth_refresh_code_idx').on(table.authorizationCodeId),
  ],
);

export const oauthAccessTokens = pgTable(
  'oauth_access_tokens',
  {
    id: text('id').primaryKey(),
    token: text('token').notNull().unique(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClients.clientId),
    sessionId: text('session_id').references(() => sessions.id, { onDelete: 'set null' }),
    userId: text('user_id').references(() => users.id),
    referenceId: text('reference_id'),
    authorizationCodeId: text('authorization_code_id'),
    resources: text('resources').array(),
    requestedUserInfoClaims: text('requested_user_info_claims').array(),
    refreshId: text('refresh_id').references(() => oauthRefreshTokens.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    revoked: timestamp('revoked', { withTimezone: true }),
    confirmation: jsonb('confirmation').$type<Record<string, unknown>>(),
    scopes: text('scopes').array().notNull(),
  },
  (table) => [
    index('oauth_access_client_idx').on(table.clientId),
    index('oauth_access_session_idx').on(table.sessionId),
    index('oauth_access_user_idx').on(table.userId),
    index('oauth_access_code_idx').on(table.authorizationCodeId),
    index('oauth_access_refresh_idx').on(table.refreshId),
  ],
);

export const oauthConsents = pgTable(
  'oauth_consents',
  {
    id: text('id').primaryKey(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClients.clientId),
    userId: text('user_id').references(() => users.id),
    referenceId: text('reference_id'),
    resources: text('resources').array(),
    requestedUserInfoClaims: text('requested_user_info_claims').array(),
    scopes: text('scopes').array().notNull(),
    ...timestamps,
  },
  (table) => [
    index('oauth_consents_client_idx').on(table.clientId),
    index('oauth_consents_user_idx').on(table.userId),
  ],
);

export const oauthClientAssertions = pgTable('oauth_client_assertions', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
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
  'proposal',
]);
export const compileStatusEnum = pgEnum('compile_status', [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
]);
export const compileTriggerEnum = pgEnum('compile_trigger', ['manual', 'auto', 'agent']);
export const compileTargetEnum = pgEnum('compile_target', ['accepted', 'proposal']);
export const agentProposalStatusEnum = pgEnum('agent_proposal_status', [
  'draft',
  'needs_rebase',
  'reviewing',
  'resolved',
  'rejected',
]);
export const agentChangeOperationEnum = pgEnum('agent_change_operation', [
  'create_file',
  'replace_file',
  'create_folder',
  'move',
  'delete',
]);
export const agentDecisionEnum = pgEnum('agent_decision', [
  'pending',
  'accepted',
  'rejected',
  'conflicted',
]);

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

export const agentClientPolicies = pgTable(
  'agent_client_policies',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    clientId: text('client_id').notNull(),
    allProjects: boolean('all_projects').notNull().default(false),
    tokensRevokedAt: timestamp('tokens_revoked_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [primaryKey({ columns: [table.userId, table.clientId] })],
);

export const agentProjectGrants = pgTable(
  'agent_project_grants',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    clientId: text('client_id').notNull(),
    clientName: text('client_name').notNull(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.clientId, table.projectId] }),
    index('agent_grants_user_client_idx').on(table.userId, table.clientId),
    index('agent_grants_project_idx').on(table.projectId),
  ],
);

export const agentProposals = pgTable(
  'agent_proposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    clientId: text('client_id').notNull(),
    clientName: text('client_name').notNull(),
    title: text('title').notNull(),
    status: agentProposalStatusEnum('status').notNull().default('draft'),
    revision: integer('revision').notNull().default(0),
    totalBytes: bigint('total_bytes', { mode: 'number' }).notNull().default(0),
    conflictPaths: text('conflict_paths').array().notNull().default([]),
    latestCompileJobId: uuid('latest_compile_job_id'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index('agent_proposals_project_idx').on(table.projectId, table.updatedAt),
    index('agent_proposals_owner_idx').on(table.userId, table.clientId),
    uniqueIndex('agent_proposals_one_unresolved_idx')
      .on(table.projectId)
      .where(sql`${table.status} in ('draft', 'needs_rebase', 'reviewing')`),
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

export const agentProposalChanges = pgTable(
  'agent_proposal_changes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    proposalId: uuid('proposal_id')
      .notNull()
      .references(() => agentProposals.id, { onDelete: 'cascade' }),
    entryId: uuid('entry_id').references(() => entries.id, { onDelete: 'set null' }),
    entryKind: entryKindEnum('entry_kind').notNull(),
    operation: agentChangeOperationEnum('operation').notNull(),
    basePath: text('base_path'),
    targetPath: text('target_path'),
    baseVersion: integer('base_version'),
    baseVersionId: uuid('base_version_id').references(() => fileVersions.id, {
      onDelete: 'set null',
    }),
    baseHash: text('base_hash'),
    contentHash: text('content_hash'),
    contentObjectKey: text('content_object_key'),
    size: bigint('size', { mode: 'number' }).notNull().default(0),
    decision: agentDecisionEnum('decision').notNull().default('pending'),
    sortOrder: integer('sort_order').notNull().default(0),
    ...timestamps,
  },
  (table) => [
    index('agent_changes_proposal_idx').on(table.proposalId, table.sortOrder),
    uniqueIndex('agent_changes_proposal_target_idx').on(table.proposalId, table.targetPath),
  ],
);

export const agentProposalHunks = pgTable(
  'agent_proposal_hunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    proposalId: uuid('proposal_id')
      .notNull()
      .references(() => agentProposals.id, { onDelete: 'cascade' }),
    changeId: uuid('change_id')
      .notNull()
      .references(() => agentProposalChanges.id, { onDelete: 'cascade' }),
    baseStart: integer('base_start').notNull(),
    baseEnd: integer('base_end').notNull(),
    baseText: text('base_text').notNull(),
    replacementText: text('replacement_text').notNull(),
    contentHash: text('content_hash').notNull(),
    decision: agentDecisionEnum('decision').notNull().default('pending'),
    sortOrder: integer('sort_order').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('agent_hunks_proposal_idx').on(table.proposalId, table.sortOrder),
    uniqueIndex('agent_hunks_change_order_idx').on(table.changeId, table.sortOrder),
  ],
);

export const agentProposalMutations = pgTable(
  'agent_proposal_mutations',
  {
    proposalId: uuid('proposal_id')
      .notNull()
      .references(() => agentProposals.id, { onDelete: 'cascade' }),
    idempotencyKey: uuid('idempotency_key').notNull(),
    resultingRevision: integer('resulting_revision').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.proposalId, table.idempotencyKey] })],
);

export type CheckpointManifestEntry = {
  entryId: string;
  path: string;
  versionId: string | null;
  blobHash: string;
  objectKey: string;
  size: number;
  mimeType: string | null;
  source?:
    | { kind: 'accepted'; versionId: string }
    | { kind: 'proposal'; proposalId: string; revision: number; contentHash: string };
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
    target: compileTargetEnum('target').notNull().default('accepted'),
    proposalId: uuid('proposal_id').references(() => agentProposals.id, { onDelete: 'set null' }),
    proposalRevision: integer('proposal_revision'),
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
    target: compileTargetEnum('target').notNull().default('accepted'),
    proposalId: uuid('proposal_id').references(() => agentProposals.id, { onDelete: 'set null' }),
    proposalRevision: integer('proposal_revision'),
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
