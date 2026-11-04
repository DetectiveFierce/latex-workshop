import { expect, test } from '@playwright/test';

test('workspace palette, sidebar search and unified settings keep their keyboard and save behavior', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const email = `redesign-panels-${Date.now()}@example.test`;
  const password = 'correct-horse-battery-staple';
  const origin = new URL(process.env.E2E_BASE_URL ?? 'http://localhost:5173/latex-workshop/')
    .origin;
  const headers = { Origin: origin };
  const signUp = () =>
    page.request.post('api/auth/sign-up/email', {
      headers,
      data: { name: 'Panel reviewer', email, password },
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
    data: { name: 'Panel behavior review' },
  });
  expect(created.ok()).toBeTruthy();
  const { project } = (await created.json()) as { project: { id: string; mainFileId: string } };
  const source =
    '\\documentclass{article}\n\\begin{document}\nA common mean.\nAnother common mean.\n\\end{document}\n';
  expect(
    (
      await page.request.put(
        `api/v1/projects/${project.id}/entries/${project.mainFileId}/content`,
        { data: { baseVersion: 1, content: source } },
      )
    ).ok(),
  ).toBeTruthy();
  await page.goto(`projects/${project.id}`);
  await expect(page.locator('.monaco-editor')).toBeVisible();
  await page.keyboard.press('Control+K');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  const paletteInput = palette.getByRole('combobox');
  await page.screenshot({ path: testInfo.outputPath('palette-1440.png') });
  await paletteInput.fill('/main');
  await expect(palette.getByRole('tab', { name: 'Files /' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(palette.getByRole('option')).toHaveCount(1);
  await expect(paletteInput).toHaveAttribute(
    'aria-activedescendant',
    (await palette.getByRole('option').getAttribute('id')) ?? '',
  );
  await page.keyboard.press('Enter');
  await expect(palette).toHaveCount(0);
  await page.keyboard.press('Control+K');
  await paletteInput.fill('>Auto-compile');
  const autoCompile = palette.getByRole('switch', { name: 'Auto-compile on save' });
  const initialAutoCompile = await autoCompile.getAttribute('aria-checked');
  await autoCompile.click();
  await expect(autoCompile).toHaveAttribute(
    'aria-checked',
    initialAutoCompile === 'true' ? 'false' : 'true',
  );
  await expect(palette).toBeVisible();
  await paletteInput.fill('>Compiler');
  await expect(palette.getByRole('tab', { name: 'Commands >' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.keyboard.press('Enter');
  const settings = page.getByRole('dialog', { name: 'Project', exact: true });
  await expect(settings).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('settings-1440.png') });
  await settings.getByLabel('Name', { exact: true }).fill('Discarded name');
  await settings.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByLabel('Settings', { exact: true }).click();
  await expect(settings.getByLabel('Name', { exact: true })).toHaveValue('Panel behavior review');
  await settings.getByLabel('Name', { exact: true }).fill('Saved panel review');
  await settings.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(settings).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Rename project Saved panel review', exact: true }),
  ).toBeVisible();
  await page.getByRole('tab', { name: 'search', exact: true }).click();
  await page.getByLabel('Search the current project', { exact: true }).fill('common');
  await expect(page.locator('.project-results-heading')).toContainText('2 results in 1 files');
  await expect(page.locator('.project-result-row .mark')).toHaveCount(2);
  await page.screenshot({ path: testInfo.outputPath('search-1440.png') });
  await page.getByLabel('Filter files', { exact: true }).click();
  await page.getByLabel('Files to exclude').fill('*.tex');
  await expect(page.locator('.project-results-heading')).toContainText('0 results');
  await page.getByLabel('Files to exclude').fill('');
  const firstResult = page.locator('.project-result').first();
  await firstResult.hover();
  await expect(firstResult.getByLabel('Dismiss this match')).toBeVisible();
  await page.mouse.move(0, 0);
  await firstResult.locator('.project-result-row').focus();
  await expect(firstResult.getByLabel('Dismiss this match')).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(firstResult.getByLabel('Replace this match')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(firstResult.getByLabel('Dismiss this match')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('.project-results-heading')).toContainText('1 results');
  await page.getByLabel('Refresh search', { exact: true }).click();
  await expect(page.locator('.project-results-heading')).toContainText('2 results');
  await expect(page.locator('.file-panel')).toHaveCSS('width', '272px');
  await page.getByLabel('Settings', { exact: true }).click();
  await page.getByRole('button', { name: 'Agent access', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Agent access', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByLabel('Settings', { exact: true })).toBeFocused();
});
