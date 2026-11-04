import { expect, test } from '@playwright/test';

test('editor outline follows included source and workspace fits desktop widths', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const email = `redesign-editor-${Date.now()}@example.test`;
  const password = 'correct-horse-battery-staple';
  const origin = new URL(process.env.E2E_BASE_URL ?? 'http://localhost:5173/latex-workshop/')
    .origin;
  const headers = { Origin: origin };
  const signUp = () =>
    page.request.post('api/auth/sign-up/email', {
      headers,
      data: { name: 'Editor reviewer', email, password },
    });
  // Better Auth allows a few sign-ups per window, and the suite signs up often.
  let signup = await signUp();
  await expect
    .poll(
      async () => {
        if (signup.status() === 429) signup = await signUp();
        return signup.status();
      },
      { timeout: 60_000, intervals: [5_000] },
    )
    .not.toBe(429);
  expect(signup.ok()).toBeTruthy();
  let verificationUrl: string | undefined;
  const mailpit = process.env.E2E_MAILPIT_URL ?? 'http://127.0.0.1:8025';
  await expect
    .poll(async () => {
      const messages = (await (
        await request.get(`${mailpit}/api/v1/search?query=to:${encodeURIComponent(email)}`)
      ).json()) as { messages: { ID: string }[] };
      if (!messages.messages[0]) return false;
      const message = (await (
        await request.get(`${mailpit}/api/v1/message/${messages.messages[0].ID}`)
      ).json()) as { Text: string };
      verificationUrl = message.Text.match(/https?:\/\/[^\s<>]+verify-email[^\s<>]*/)?.[0];
      return Boolean(verificationUrl);
    })
    .toBeTruthy();
  if (!verificationUrl) throw new Error('Verification mail unavailable');
  expect((await request.get(verificationUrl, { maxRedirects: 0 })).status()).toBe(302);
  expect(
    (
      await page.request.post('api/auth/sign-in/email', { headers, data: { email, password } })
    ).ok(),
  ).toBeTruthy();
  const created = await page.request.post('api/v1/projects', {
    data: { name: 'Editor behavior review' },
  });
  expect(created.ok()).toBeTruthy();
  const { project } = (await created.json()) as { project: { id: string; mainFileId: string } };
  const source =
    '\\documentclass{article}\n\\begin{document}\n\\section{First}\n\\input{extra}\n\\section{Last}\n\\end{document}\n';
  expect(
    (
      await page.request.put(
        `api/v1/projects/${project.id}/entries/${project.mainFileId}/content`,
        { data: { baseVersion: 1, content: source } },
      )
    ).ok(),
  ).toBeTruthy();
  expect(
    (
      await page.request.post(`api/v1/projects/${project.id}/entries`, {
        data: {
          name: 'extra.tex',
          kind: 'file',
          parentId: null,
          content: '\\subsection{Included}\nText.\n',
        },
      })
    ).ok(),
  ).toBeTruthy();
  await page.goto(`projects/${project.id}`);
  await expect(page.locator('.monaco-editor')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('tab', { name: 'outline', exact: true }).click();
  const outline = page.getByRole('region', { name: 'Source outline' });
  await expect(outline.getByRole('button', { name: /Included/ })).toBeVisible({ timeout: 30_000 });
  await expect(outline).toContainText('First');
  await expect(outline).toContainText('Last');
  await page.screenshot({ path: testInfo.outputPath('editor-outline-1440.png') });
  await outline.getByRole('button', { name: /Included/ }).click();
  await expect(page.locator('.tab-bar')).toContainText('extra.tex');
  await page.getByRole('tab', { name: 'files', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('editor-1440.png') });
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect
    .poll(() =>
      page.locator('.workspace-toolbar').evaluate((el) => el.scrollWidth <= el.clientWidth),
    )
    .toBe(true);
  await page.screenshot({ path: testInfo.outputPath('editor-1280.png') });
  await page.getByLabel('Compile options').click();
  await expect(page.getByRole('menuitem', { name: 'Clear build cache' })).toBeVisible();
  const cleared = page.waitForResponse(
    (response) =>
      response.url().endsWith('/build-cache/clear') && response.request().method() === 'POST',
  );
  await page.getByRole('menuitem', { name: 'Clear build cache' }).click();
  expect((await cleared).ok()).toBeTruthy();
});
