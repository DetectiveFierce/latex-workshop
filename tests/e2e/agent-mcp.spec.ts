import AxeBuilder from '@axe-core/playwright';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
  type APIResponse,
} from '@playwright/test';

const apiOrigin = process.env.E2E_API_URL ?? 'http://localhost:3001';
const mailpitOrigin = process.env.E2E_MAILPIT_URL ?? 'http://127.0.0.1:8025';

test('OAuth MCP agent creates a durable proposal that the owner reviews and accepts', async ({
  page,
  request,
}) => {
  test.skip(process.env.E2E_AGENT_MCP !== 'true', 'Requires an MCP-enabled stack with DCR enabled');
  const email = `agent-e2e-${Date.now()}@example.test`;
  const projectName = `Agent review ${Date.now()}`;

  await page.goto('auth');
  await page.getByRole('tab', { name: 'Create account' }).click();
  await page.getByLabel('Name').fill('Agent Review User');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill('correct-horse-battery-staple');
  await page.getByLabel('Confirm password').fill('correct-horse-battery-staple');
  await page.getByRole('button', { name: 'Create account' }).click();
  const verification = await request.get(await waitForVerificationUrl(request, email));
  expect(verification.ok()).toBeTruthy();
  await page.getByRole('button', { name: 'Back to sign in' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('correct-horse-battery-staple');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('menuitem', { name: 'New Blank Project' }).click();
  await page.getByLabel('Project name').fill(projectName);
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveTitle(`${projectName} - Latex Workshop`);
  const projectId = new URL(page.url()).pathname.match(/\/projects\/([^/]+)/)?.[1];
  if (!projectId) throw new Error('Workspace URL did not contain a project ID');
  await page.locator('.view-lines').click();
  await page.keyboard.type('local-unsaved-draft ');

  // A harness performs DCR outside the owner's browser session. Keeping this request
  // context cookieless also exercises the explicitly enabled unauthenticated DCR path.
  const agentRequest = await playwrightRequest.newContext();
  const protectedResource = await agentRequest.get(
    `${apiOrigin}/.well-known/oauth-protected-resource/api/mcp`,
  );
  expect(protectedResource.ok()).toBeTruthy();
  expect(await protectedResource.json()).toMatchObject({
    resource: `${apiOrigin}/api/mcp`,
    scopes_supported: expect.arrayContaining(['projects:read', 'proposals:write']),
  });
  const authorizationMetadata = await agentRequest.get(
    `${apiOrigin}/api/auth/.well-known/oauth-authorization-server`,
  );
  expect(authorizationMetadata.ok()).toBeTruthy();
  expect(await authorizationMetadata.json()).toMatchObject({
    client_id_metadata_document_supported: true,
    code_challenge_methods_supported: expect.arrayContaining(['S256']),
    scopes_supported: expect.arrayContaining(['projects:read', 'proposals:write']),
  });
  const unauthenticatedMcp = await agentRequest.post(`${apiOrigin}/api/mcp`, {
    headers: {
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/list',
    },
    data: { jsonrpc: '2.0', id: randomUUID(), method: 'tools/list', params: {} },
  });
  expect(unauthenticatedMcp.status()).toBe(401);
  expect(unauthenticatedMcp.headers()['www-authenticate']).toContain(
    `resource_metadata="${apiOrigin}/.well-known/oauth-protected-resource/api/mcp"`,
  );
  const redirectUri = 'https://agent-client.example.test/callback';
  const registration = await agentRequest.post(`${apiOrigin}/api/auth/oauth2/register`, {
    data: {
      client_name: 'Playwright Agent Harness',
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: 'openid profile offline_access projects:read proposals:write',
    },
  });
  expect(registration.status()).toBe(201);
  const client = (await registration.json()) as { client_id: string };
  const verifier = base64Url(randomBytes(48));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  const state = randomUUID();
  const authorization = new URL(`${apiOrigin}/api/auth/oauth2/authorize`);
  authorization.search = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid profile offline_access projects:read proposals:write',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: `${apiOrigin}/api/mcp`,
    state,
  }).toString();

  let callbackUrl = '';
  await page.route(`${redirectUri}*`, async (route) => {
    callbackUrl = route.request().url();
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Connected</h1>' });
  });
  await page.goto(authorization.href);
  await expect(page.getByRole('heading', { name: 'Agent access' })).toBeVisible();
  const pendingConsent = page
    .locator('.agent-connection-card')
    .filter({ hasText: 'Playwright Agent Harness' })
    .first();
  await pendingConsent.getByRole('button', { name: 'All current and future projects' }).click();
  await expect(
    pendingConsent.getByRole('button', { name: projectName, exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await pendingConsent.getByRole('button', { name: 'Allow selected projects' }).click();
  await expect.poll(() => callbackUrl).toContain('code=');
  const callback = new URL(callbackUrl);
  expect(callback.searchParams.get('state')).toBe(state);
  const code = callback.searchParams.get('code');
  if (!code) throw new Error('Authorization response did not contain a code');

  const tokenResponse = await agentRequest.post(`${apiOrigin}/api/auth/oauth2/token`, {
    form: {
      grant_type: 'authorization_code',
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code,
      code_verifier: verifier,
      resource: `${apiOrigin}/api/mcp`,
    },
  });
  expect(tokenResponse.ok()).toBeTruthy();
  const token = (await tokenResponse.json()) as { access_token: string; refresh_token: string };
  const refreshResponse = await agentRequest.post(`${apiOrigin}/api/auth/oauth2/token`, {
    form: {
      grant_type: 'refresh_token',
      client_id: client.client_id,
      refresh_token: token.refresh_token,
      resource: `${apiOrigin}/api/mcp`,
    },
  });
  expect(refreshResponse.ok()).toBeTruthy();
  const refreshedToken = (await refreshResponse.json()) as {
    access_token: string;
    refresh_token: string;
  };
  expect(refreshedToken.refresh_token).not.toBe(token.refresh_token);
  const accessToken = refreshedToken.access_token;

  const capabilities = await initializeMcp(agentRequest, accessToken);
  expect(capabilities).toHaveProperty('tools');
  // The editing workflow belongs in server instructions and tool metadata. Advertising an MCP
  // prompt can cause clients to insert its user-role content back into the message composer.
  expect(capabilities).not.toHaveProperty('prompts');

  const tools = await listTools(agentRequest, accessToken);
  // ChatGPT scans this entire document before it can call a tool. Keep discovery bounded so
  // richer proposal and compile result types cannot silently make the plugin undiscoverable.
  expect(Buffer.byteLength(JSON.stringify({ tools }), 'utf8')).toBeLessThan(32 * 1024);
  expect(tools.map((tool) => tool.name)).toEqual(
    expect.arrayContaining([
      'list_projects',
      'create_project',
      'rename_project',
      'organize_library',
      'get_project_tree',
      'read_text_file',
      'start_proposal',
      'put_proposal_file',
      'propose_structure',
      'compile_proposal',
      'finish_proposal',
    ]),
  );
  const listProjectsTool = tools.find((tool) => tool.name === 'list_projects');
  expect(listProjectsTool?.description).toContain('conversational follow-ups');
  expect(listProjectsTool?.description).toContain('the same paper');
  const writeTools = new Set([
    'create_project',
    'rename_project',
    'organize_library',
    'start_proposal',
    'put_proposal_file',
    'propose_structure',
    'compile_proposal',
    'finish_proposal',
  ]);
  for (const tool of tools) {
    expect(tool.description).toContain('Mind Palace LaTeX Workshop');
    expect(tool.annotations).toMatchObject({
      readOnlyHint: !writeTools.has(tool.name),
      destructiveHint: tool.name === 'organize_library',
      idempotentHint: tool.name !== 'organize_library',
      openWorldHint: false,
    });
    expect(tool._meta?.securitySchemes).toEqual([
      {
        type: 'oauth2',
        scopes: writeTools.has(tool.name)
          ? ['projects:read', 'proposals:write']
          : ['projects:read'],
      },
    ]);
  }

  const list = await callTool(agentRequest, accessToken, 'list_projects', {});
  expect(list.scopeRule).toContain('MUST call create_project');
  expect(list.projectCreationTool).toBe('create_project');
  expect(list.manageAccessUrl).toMatch(/\/account#agent-access$/);
  expect(list.organizationComplete).toBe(true);
  expect(list.folders).toEqual([]);
  expect(list.tags).toEqual([]);
  expect(list.projects).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: projectId,
        name: projectName,
        workspaceUrl: expect.stringMatching(new RegExp(`/projects/${projectId}$`)),
      }),
    ]),
  );

  const folderName = `Agent folder ${Date.now()}`;
  const folderResult = await callTool(agentRequest, accessToken, 'organize_library', {
    action: 'create_folder',
    name: folderName,
    parentId: null,
    idempotencyKey: randomUUID(),
  });
  const folder = folderResult.folder as { id: string; name: string };
  expect(folder.name).toBe(folderName);
  const tagName = `Agent tag ${Date.now()}`;
  const tagResult = await callTool(agentRequest, accessToken, 'organize_library', {
    action: 'create_tag',
    name: tagName,
    color: 'cyan',
    idempotencyKey: randomUUID(),
  });
  const tag = tagResult.tag as { id: string; name: string; color: string };
  expect(tag).toMatchObject({ name: tagName, color: 'cyan' });

  const createdName = `Agent template ${Date.now()}`;
  const created = await callTool(agentRequest, accessToken, 'create_project', {
    name: createdName,
    folderId: folder.id,
    tagIds: [tag.id],
    sourceProjectId: projectId,
    isTemplate: true,
    idempotencyKey: randomUUID(),
  });
  expect(created.project).toMatchObject({ name: createdName, isTemplate: true });
  expect(created.project).toMatchObject({ folderId: folder.id, tagIds: [tag.id] });
  expect(created.proposal).toMatchObject({ status: 'reviewing', projectId: created.project.id });
  expect(created.reviewUrl).toMatch(new RegExp(`/projects/${String(created.project.id)}$`));
  expect(created.project.workspaceUrl).toBe(created.reviewUrl);
  const organizedList = await callTool(agentRequest, accessToken, 'list_projects', {});
  expect(organizedList.folders).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: folder.id, name: folderName })]),
  );
  expect(organizedList.tags).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: tag.id, name: tagName })]),
  );
  expect(organizedList.projects).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: created.project.id,
        folderId: folder.id,
        tagIds: [tag.id],
      }),
    ]),
  );
  const nestedFolder = await callTool(agentRequest, accessToken, 'organize_library', {
    action: 'create_folder',
    name: 'Nested',
    parentId: folder.id,
    idempotencyKey: randomUUID(),
  });
  const nestedFolderId = String((nestedFolder.folder as { id: string }).id);
  const movedFolder = await callTool(agentRequest, accessToken, 'organize_library', {
    action: 'update_folder',
    folderId: nestedFolderId,
    name: 'Renamed nested',
    parentId: null,
    idempotencyKey: randomUUID(),
  });
  expect(movedFolder.folder).toMatchObject({ name: 'Renamed nested', parentId: null });
  const trashedFolder = await callTool(agentRequest, accessToken, 'organize_library', {
    action: 'trash_folder',
    folderId: nestedFolderId,
    idempotencyKey: randomUUID(),
  });
  expect(trashedFolder).toMatchObject({
    action: 'trash_folder',
    folderId: nestedFolderId,
    trashedProjectIds: [],
  });

  await callTool(agentRequest, accessToken, 'organize_library', {
    action: 'move_project',
    projectId: created.project.id,
    folderId: null,
    idempotencyKey: randomUUID(),
  });
  await callTool(agentRequest, accessToken, 'organize_library', {
    action: 'move_project',
    projectId: created.project.id,
    folderId: folder.id,
    idempotencyKey: randomUUID(),
  });
  await callTool(agentRequest, accessToken, 'organize_library', {
    action: 'set_project_tags',
    projectId: created.project.id,
    tagIds: [],
    idempotencyKey: randomUUID(),
  });
  await callTool(agentRequest, accessToken, 'organize_library', {
    action: 'set_project_tags',
    projectId: created.project.id,
    tagIds: [tag.id],
    idempotencyKey: randomUUID(),
  });
  const disposableTag = await callTool(agentRequest, accessToken, 'organize_library', {
    action: 'create_tag',
    name: `Disposable ${Date.now()}`,
    color: 'slate',
    idempotencyKey: randomUUID(),
  });
  const disposableTagId = String((disposableTag.tag as { id: string }).id);
  const updatedTag = await callTool(agentRequest, accessToken, 'organize_library', {
    action: 'update_tag',
    tagId: disposableTagId,
    name: `Renamed disposable ${Date.now()}`,
    color: 'amber',
    idempotencyKey: randomUUID(),
  });
  expect(updatedTag.tag).toMatchObject({ color: 'amber' });
  const deletedTag = await callTool(agentRequest, accessToken, 'organize_library', {
    action: 'delete_tag',
    tagId: disposableTagId,
    idempotencyKey: randomUUID(),
  });
  expect(deletedTag).toMatchObject({
    action: 'delete_tag',
    tagId: disposableTagId,
    removedAssignmentCount: 0,
  });
  expect(created.compile).toMatchObject({
    proposalId: created.proposal.id,
    target: 'proposal',
  });
  expect(created.proposal.changes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ operation: 'replace_file', targetPath: 'main.tex' }),
    ]),
  );
  const acceptedSkeleton = await callTool(agentRequest, accessToken, 'read_text_file', {
    projectId: created.project.id,
    path: 'main.tex',
  });
  expect(acceptedSkeleton.content).toBe('');
  const renamed = await callTool(agentRequest, accessToken, 'rename_project', {
    projectId: created.project.id,
    name: `${createdName} renamed`,
    idempotencyKey: randomUUID(),
  });
  expect(renamed.project.name).toBe(`${createdName} renamed`);
  expect(renamed.project.workspaceUrl).toBe(created.reviewUrl);

  const source = await callTool(agentRequest, accessToken, 'read_text_file', {
    projectId,
    path: 'main.tex',
  });
  const started = await callTool(agentRequest, accessToken, 'start_proposal', {
    projectId,
    title: 'Improve the introduction',
    idempotencyKey: randomUUID(),
  });
  const proposedMain = String(source.content)
    .replace('Start writing here.', 'A reviewable change from the agent harness.')
    .replace('\\end{document}', 'Added closing note.\n\\end{document}');
  const updatedMain = await callTool(agentRequest, accessToken, 'put_proposal_file', {
    proposalId: started.id,
    expectedProposalRevision: started.revision,
    idempotencyKey: randomUUID(),
    path: 'main.tex',
    content: proposedMain,
    baseHash: source.hash,
  });
  const completedDraft = await callTool(agentRequest, accessToken, 'put_proposal_file', {
    proposalId: started.id,
    expectedProposalRevision: updatedMain.revision,
    idempotencyKey: randomUUID(),
    path: 'notes.tex',
    content: 'Notes from the agent.\n',
  });

  const finished = await callTool(agentRequest, accessToken, 'finish_proposal', {
    proposalId: started.id,
    expectedProposalRevision: completedDraft.revision,
    idempotencyKey: randomUUID(),
  });
  expect(finished).toMatchObject({
    status: 'reviewing',
    compile: { status: 'succeeded', target: 'proposal' },
  });
  const finishedCompileId = String((finished.compile as { id: unknown }).id);
  await page.goto(`/latex-workshop/projects/${projectId}`);
  const review = page.locator('.proposal-editor-dock');
  await expect(review).toBeVisible();
  await expect(page.locator('.pdf-container')).toBeVisible();
  const displayedPdfUrl = await page
    .locator('.preview-toolbar')
    .getByRole('link', { name: 'Download PDF' })
    .getAttribute('href');
  expect(displayedPdfUrl).toContain(`/compilations/${finishedCompileId}/download`);
  await expect(page.locator('.monaco-diff-editor')).toHaveCount(0);
  const dirty = page.getByLabel('dirty');
  if (await dirty.isVisible()) {
    await expect(page.locator('.proposal-addition-line')).toHaveCount(0);
    await expect(page.getByLabel('saved')).toBeVisible({ timeout: 10_000 });
  }
  await expect(page.locator('.proposal-addition-line').first()).toBeVisible();
  await expect(page.locator('.proposal-deletion-zone').first()).toBeVisible();

  await page
    .locator('.view-lines')
    .getByText('A reviewable change from the agent harness.', { exact: false })
    .click();
  await page.keyboard.type(' typed');
  await expect(page.locator('.view-lines')).toContainText('typed');
  await expect(page.getByLabel('Reject all proposed changes')).toBeEnabled();

  const deletion = page.locator('.proposal-deletion-zone').first();
  await deletion.click();
  const beforeDeletion = await page.locator('.view-lines').innerText();
  await page.keyboard.type('should-not-edit');
  await expect.poll(async () => page.locator('.view-lines').innerText()).toBe(beforeDeletion);

  // Monaco's syntax theme is audited separately; exclude its aria-hidden rendering
  // internals while checking the surrounding proposal controls and dock.
  const accessibility = await new AxeBuilder({ page }).exclude('.monaco-editor').analyze();
  expect(
    accessibility.violations.filter((violation) =>
      ['critical', 'serious'].includes(violation.impact ?? ''),
    ),
  ).toEqual([]);

  await page.getByLabel('Expand proposal details').click();
  await expect(page.getByLabel('Accept all proposed changes')).toBeEnabled();

  const activeProposalRevision = async () =>
    page.evaluate(async (activeProjectId) => {
      const response = await fetch(
        `/latex-workshop/api/v1/projects/${activeProjectId}/proposals/active`,
        { credentials: 'include' },
      );
      const body = (await response.json()) as { proposal: { revision: number } | null };
      return body.proposal?.revision ?? null;
    }, projectId);
  const proposalCompileResult = async (revision: number) =>
    page.evaluate(
      async ({ activeProjectId, activeRevision }) => {
        const response = await fetch(
          `/latex-workshop/api/v1/projects/${activeProjectId}/compilations`,
          { credentials: 'include' },
        );
        const body = (await response.json()) as {
          jobs: Array<{
            target: string;
            proposalRevision: number | null;
            status: string;
          }>;
        };
        const job = body.jobs.find(
          (candidate) =>
            candidate.target === 'proposal' && candidate.proposalRevision === activeRevision,
        );
        return job?.status ?? null;
      },
      { activeProjectId: projectId, activeRevision: revision },
    );

  const beforeOwnerEdit = await activeProposalRevision();
  const ordinarySourceLine = page
    .locator('.view-lines .view-line')
    .filter({ hasText: 'documentclass' });
  await ordinarySourceLine.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' % owner review edit');
  await expect(page.locator('.view-lines')).toContainText('owner review edit');
  await expect.poll(activeProposalRevision).not.toBe(beforeOwnerEdit);
  await expect(page.locator('.pdf-empty')).toBeVisible();
  const manuallyEditedRevision = await activeProposalRevision();
  if (manuallyEditedRevision === null) throw new Error('Expected an active proposal revision');
  await page.keyboard.press('Control+S');
  await expect
    .poll(() => proposalCompileResult(manuallyEditedRevision), { timeout: 120_000 })
    .toBe('succeeded');

  await page.getByLabel('Auto').check();
  await ordinarySourceLine.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' auto');
  await expect.poll(activeProposalRevision).not.toBe(manuallyEditedRevision);
  const automaticallyEditedRevision = await activeProposalRevision();
  if (automaticallyEditedRevision === null)
    throw new Error('Expected an automatically compiled proposal revision');
  await expect
    .poll(() => proposalCompileResult(automaticallyEditedRevision), { timeout: 120_000 })
    .toBe('succeeded');
  await page.getByLabel('Auto').click();
  await expect(page.getByLabel('Auto')).not.toBeChecked();

  await page.locator('.view-lines .view-line').filter({ hasText: 'agent harness' }).click();
  await expect(page.getByRole('button', { name: 'Accept hunk' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Reject hunk' })).toBeEnabled();

  await page
    .locator('.proposal-editor-dock')
    .getByRole('button', { name: /notes\.tex/ })
    .click();
  await expect(page.locator('.view-lines')).toContainText('Notes from the agent.');
  await page.getByLabel('Accept all proposed changes').click();
  await expect(review).toHaveCount(0);
  await expect(page.locator('.view-lines')).toContainText('Notes from the agent.');

  const revokeStatus = await page.evaluate(async (clientId) => {
    const response = await fetch(
      `/latex-workshop/api/v1/agent-connections?clientId=${encodeURIComponent(clientId)}`,
      { method: 'DELETE', credentials: 'include' },
    );
    return response.status;
  }, client.client_id);
  expect(revokeStatus).toBe(204);
  const revokedRequest = await agentRequest.post(`${apiOrigin}/api/mcp`, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/call',
      'mcp-name': 'list_projects',
    },
    data: {
      jsonrpc: '2.0',
      id: randomUUID(),
      method: 'tools/call',
      params: {
        name: 'list_projects',
        arguments: {},
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    },
  });
  expect(revokedRequest.status()).toBe(401);
  expect(revokedRequest.headers()['www-authenticate']).toContain('error="invalid_token"');
  expect(revokedRequest.headers()['www-authenticate']).toContain(
    `resource_metadata="${apiOrigin}/.well-known/oauth-protected-resource/api/mcp"`,
  );
  await agentRequest.dispose();
});

async function callTool(
  request: APIRequestContext,
  accessToken: string,
  name: string,
  args: Record<string, unknown>,
) {
  const response = await request.post(`${apiOrigin}/api/mcp`, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/call',
      'mcp-name': name,
    },
    data: {
      jsonrpc: '2.0',
      id: randomUUID(),
      method: 'tools/call',
      params: {
        name,
        arguments: args,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const message = await parseMcpResponse(response);
  const result = message.result as { isError?: boolean; structuredContent?: unknown } | undefined;
  expect(result?.isError).not.toBe(true);
  const structured = result?.structuredContent;
  if (typeof structured !== 'object' || structured === null || Array.isArray(structured))
    throw new Error('MCP tool did not return a structured object');
  return structured as Record<string, unknown>;
}

type ListedTool = {
  name: string;
  description?: string;
  annotations?: Record<string, unknown>;
  _meta?: { securitySchemes?: unknown };
};

async function initializeMcp(
  request: APIRequestContext,
  accessToken: string,
): Promise<Record<string, unknown>> {
  const response = await request.post(`${apiOrigin}/api/mcp`, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
      'mcp-method': 'initialize',
    },
    data: {
      jsonrpc: '2.0',
      id: randomUUID(),
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'Playwright Agent Harness', version: '1.0.0' },
      },
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const message = await parseMcpResponse(response);
  const parsed = message.result as { capabilities?: unknown } | undefined;
  if (
    typeof parsed?.capabilities !== 'object' ||
    parsed.capabilities === null ||
    Array.isArray(parsed.capabilities)
  ) {
    throw new Error('MCP initialize returned no capabilities');
  }
  return parsed.capabilities as Record<string, unknown>;
}

async function listTools(request: APIRequestContext, accessToken: string): Promise<ListedTool[]> {
  const response = await request.post(`${apiOrigin}/api/mcp`, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/list',
    },
    data: {
      jsonrpc: '2.0',
      id: randomUUID(),
      method: 'tools/list',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const message = await parseMcpResponse(response);
  const parsed = message.result as { tools?: unknown } | undefined;
  if (!Array.isArray(parsed?.tools)) throw new Error('MCP tools/list returned no tools');
  return parsed.tools as ListedTool[];
}

async function parseMcpResponse(response: APIResponse): Promise<Record<string, unknown>> {
  const body = await response.text();
  if (response.headers()['content-type']?.includes('text/event-stream')) {
    const data = body
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .find((line) => line && line !== '[DONE]');
    if (!data) throw new Error('MCP response contained no message');
    return JSON.parse(data) as Record<string, unknown>;
  }
  return JSON.parse(body) as Record<string, unknown>;
}

function base64Url(value: Buffer) {
  return value.toString('base64url');
}

async function waitForVerificationUrl(request: APIRequestContext, email: string): Promise<string> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const response = await request.get(`${mailpitOrigin}/api/v1/messages`);
    if (response.ok()) {
      const mailbox = (await response.json()) as {
        messages: Array<{ ID: string; To: Array<{ Address: string }>; Subject: string }>;
      };
      const message = mailbox.messages.find(
        (candidate) =>
          candidate.To.some((recipient) => recipient.Address === email) &&
          candidate.Subject.includes('Verify'),
      );
      if (message) {
        const detail = await request.get(`${mailpitOrigin}/api/v1/message/${message.ID}`);
        const body = (await detail.json()) as { Text: string };
        const match = body.Text.match(/https?:\/\/\S+\/api\/auth\/verify-email\?\S+/);
        if (match) return match[0].trim();
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Verification email for ${email} did not arrive`);
}
