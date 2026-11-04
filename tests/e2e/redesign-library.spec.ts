import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test('redesigned authentication and library preserve navigation, previews, and keyboard menus', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto('auth');
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('sign-in-1440.png'), fullPage: true });
  const email = `redesign-library-${Date.now()}@example.test`;
  const password = 'correct-horse-battery-staple';
  await page.goto('auth?signup=true');
  await page.getByLabel('Name', { exact: true }).fill('Library Review');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Confirm password').fill(password);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  const mailpit = process.env.E2E_MAILPIT_URL ?? 'http://127.0.0.1:8025';
  let verificationUrl: string | undefined;
  await expect
    .poll(async () => {
      const messages = (await (
        await request.get(`${mailpit}/api/v1/search?query=to:${encodeURIComponent(email)}`)
      ).json()) as { messages: Array<{ ID: string }> };
      const first = messages.messages[0];
      if (!first) return false;
      const message = (await (
        await request.get(`${mailpit}/api/v1/message/${first.ID}`)
      ).json()) as { Text: string };
      verificationUrl = message.Text.match(/https?:\/\/[^\s<>]+verify-email[^\s<>]*/)?.[0];
      return Boolean(verificationUrl);
    })
    .toBeTruthy();
  if (!verificationUrl) throw new Error('Verification URL missing');
  expect((await request.get(verificationUrl, { maxRedirects: 0 })).status()).toBe(302);
  await page.getByRole('button', { name: 'Back to sign in' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'All projects' })).toBeVisible({
    timeout: 60_000,
  });
  const folderResponse = await page.request.post('api/v1/library/folders', {
    data: { name: 'Research' },
  });
  expect(folderResponse.ok()).toBeTruthy();
  const { folder } = (await folderResponse.json()) as { folder: { id: string } };
  const tagResponse = await page.request.post('api/v1/library/tags', {
    data: { name: 'paper', color: 'magenta' },
  });
  expect(tagResponse.ok()).toBeTruthy();
  const { tag } = (await tagResponse.json()) as { tag: { id: string } };
  const ids: string[] = [];
  for (let index = 0; index < 8; index += 1) {
    const response = await page.request.post('api/v1/projects', {
      data: { name: `Research document ${index + 1}`, folderId: folder.id },
    });
    expect(response.ok()).toBeTruthy();
    const { project } = (await response.json()) as { project: { id: string } };
    ids.push(project.id);
  }
  expect(
    (
      await page.request.post('api/v1/library/projects/actions', {
        data: { action: 'add-tags', projectIds: ids, tagIds: [tag.id] },
      })
    ).ok(),
  ).toBeTruthy();
  expect(
    (
      await page.request.post('api/v1/library/projects/actions', {
        data: { action: 'favorite', projectIds: ids.slice(0, 2), value: true },
      })
    ).ok(),
  ).toBeTruthy();
  await page.reload();
  await page.getByRole('button', { name: 'Grid view' }).click();
  await expect(page.locator('.library-project-card')).toHaveCount(8);
  const cards = await page.locator('.library-project-card').evaluateAll((elements) =>
    elements.map((element) => {
      const bounds = element.getBoundingClientRect();
      return { x: bounds.x, y: bounds.y };
    }),
  );
  expect(new Set(cards.slice(0, 4).map((card) => card.y)).size).toBe(1);
  expect(new Set(cards.slice(0, 4).map((card) => card.x)).size).toBe(4);
  await expect(page.locator('.project-thumbnail').first()).toHaveClass(/loaded/, {
    timeout: 120_000,
  });
  await page.screenshot({ path: testInfo.outputPath('library-grid-1440.png'), fullPage: true });
  await page.getByRole('button', { name: 'List view' }).click();
  await expect(page.getByRole('table', { name: 'Projects' })).toBeVisible();
  await expect(page.locator('.project-main-file').first()).toHaveText('main.tex');
  await page.screenshot({ path: testInfo.outputPath('library-list-1440.png'), fullPage: true });
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
  await page.getByRole('button', { name: 'Library settings' }).click();
  await expect(page.getByRole('menuitem', { name: 'Trash', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Library settings' })).toBeFocused();
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Blank project', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.setViewportSize({ width: 600, height: 820 });
  await page.getByRole('button', { name: 'Open library navigation' }).click();
  await expect(page.locator('.library-sidebar.open')).toBeVisible();
  await page.getByRole('button', { name: 'Favorites', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Favorites', exact: true })).toBeVisible();
  await expect(page.locator('.project-list-row')).toHaveCount(2);
});
