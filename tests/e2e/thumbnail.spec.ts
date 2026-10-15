import { expect, test } from '@playwright/test';

test('Library creates missing thumbnails in the background with auto compile disabled', async ({
  page,
  request,
}) => {
  test.setTimeout(300_000);
  const email = `thumbnail-${Date.now()}@example.test`;
  const password = 'correct-horse-battery-staple';
  await page.goto('auth');
  await page.getByRole('tab', { name: 'Create account' }).click();
  await page.getByLabel('Name').fill('Thumbnail User');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Confirm password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  let verificationUrl: string | undefined;
  await expect
    .poll(async () => {
      const response = await request.get(
        `${process.env.E2E_MAILPIT_URL ?? 'http://127.0.0.1:8025'}/api/v1/search?query=to:${encodeURIComponent(email)}`,
      );
      const messages = (await response.json()) as { messages: Array<{ ID: string }> };
      const message = messages.messages[0];
      if (!message) return false;
      const detail = (await (
        await request.get(
          `${process.env.E2E_MAILPIT_URL ?? 'http://127.0.0.1:8025'}/api/v1/message/${message.ID}`,
        )
      ).json()) as { Text: string };
      verificationUrl = detail.Text.match(/https?:\/\/[^\s<>]+verify-email[^\s<>]*/)?.[0];
      return Boolean(verificationUrl);
    })
    .toBeTruthy();
  if (!verificationUrl) throw new Error('Verification URL missing');
  expect((await request.get(verificationUrl)).ok()).toBeTruthy();
  await page.getByRole('button', { name: 'Back to sign in' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Library' })).toBeVisible();
  const name = `Background preview ${Date.now()}`;
  const response = await page.request.post('api/v1/projects', { data: { name } });
  expect(response.ok()).toBeTruthy();
  const { project } = (await response.json()) as { project: { id: string; autoCompile: boolean } };
  expect(project.autoCompile).toBe(false);
  let browserCompileRequests = 0;
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      request.url().includes(`/projects/${project.id}/compilations`)
    )
      browserCompileRequests += 1;
  });
  await page.reload();
  const card = page.locator('.library-project-card').filter({ hasText: name });
  await expect(card).toBeVisible();
  await expect(card.locator('.project-thumbnail')).toHaveClass(/loaded/, { timeout: 240_000 });
  expect(browserCompileRequests).toBe(0);
  const detail = (await (await page.request.get(`api/v1/projects/${project.id}`)).json()) as {
    project: { autoCompile: boolean };
  };
  expect(detail.project.autoCompile).toBe(false);
});
