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
  const token = (await tokenResponse.json()) as { access_token: string };
  const list = await callTool(agentRequest, token.access_token, 'list_projects', {});
  expect(list.scopeRule).toContain('MUST call create_project');
  expect(list.projectCreationTool).toBe('create_project');
  expect(list.projects).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: projectId, name: projectName })]),
  );

  const createdName = `Agent template ${Date.now()}`;
  const created = await callTool(agentRequest, token.access_token, 'create_project', {
    name: createdName,
    sourceProjectId: projectId,
    isTemplate: true,
    idempotencyKey: randomUUID(),
  });
  expect(created.project).toMatchObject({ name: createdName, isTemplate: true });
  expect(created.proposal).toMatchObject({ status: 'reviewing', projectId: created.project.id });
  expect(created.compile).toMatchObject({
    proposalId: created.proposal.id,
    target: 'proposal',
  });
  expect(created.proposal.changes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ operation: 'replace_file', targetPath: 'main.tex' }),
    ]),
  );
  const acceptedSkeleton = await callTool(agentRequest, token.access_token, 'read_text_file', {
    projectId: created.project.id,
    path: 'main.tex',
  });
  expect(acceptedSkeleton.content).toBe('');
  const renamed = await callTool(agentRequest, token.access_token, 'rename_project', {
    projectId: created.project.id,
    name: `${createdName} renamed`,
    idempotencyKey: randomUUID(),
  });
  expect(renamed.project.name).toBe(`${createdName} renamed`);

  const source = await callTool(agentRequest, token.access_token, 'read_text_file', {
    projectId,
    path: 'main.tex',
  });
  const started = await callTool(agentRequest, token.access_token, 'start_proposal', {
    projectId,
    title: 'Improve the introduction',
    idempotencyKey: randomUUID(),
  });
  const proposedMain = String(source.content)
    .replace('Start writing here.', 'A reviewable change from the agent harness.')
    .replace('\\end{document}', 'Added closing note.\n\\end{document}');
  const updatedMain = await callTool(agentRequest, token.access_token, 'put_proposal_file', {
    proposalId: started.id,
    expectedProposalRevision: started.revision,
    idempotencyKey: randomUUID(),
    path: 'main.tex',
    content: proposedMain,
    baseHash: source.hash,
  });
  await callTool(agentRequest, token.access_token, 'put_proposal_file', {
    proposalId: started.id,
    expectedProposalRevision: updatedMain.revision,
    idempotencyKey: randomUUID(),
    path: 'notes.tex',
    content: 'Notes from the agent.\n',
  });

  await page.goto(`/latex-workshop/projects/${projectId}`);
  const review = page.locator('.proposal-editor-dock');
  await expect(review).toBeVisible();
  await expect(page.locator('.monaco-diff-editor')).toHaveCount(0);
  const dirty = page.getByLabel('dirty');
  if (await dirty.isVisible()) {
    await expect(page.locator('.proposal-addition-line')).toHaveCount(0);
    await expect(page.getByLabel('saved')).toBeVisible({ timeout: 10_000 });
  }
  await expect(page.locator('.proposal-addition-line').first()).toBeVisible();
  await expect(page.locator('.proposal-deletion-zone').first()).toBeVisible();

  await page.getByText('A reviewable change from the agent harness.', { exact: false }).click();
  await page.keyboard.type(' typed');
  await expect(page.locator('.view-lines')).toContainText('typed');
  await expect(page.getByLabel('Discard unfinished proposal')).toBeEnabled();

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
  await review.getByRole('button', { name: 'Stop and review' }).click();
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
      authorization: `Bearer ${token.access_token}`,
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
