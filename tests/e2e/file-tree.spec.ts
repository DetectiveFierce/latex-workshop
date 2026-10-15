import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { ProjectEntry } from '@latex-workshop/contracts';

test('file tree context menus manage the clicked file or folder', async ({ page, request }) => {
  const email = `file-tree-${Date.now()}@example.test`;
  const password = 'correct-horse-battery-staple';
  await page.goto('auth');
  await page.getByRole('tab', { name: 'Create account' }).click();
  await page.getByLabel('Name').fill('File Tree User');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Confirm password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText('Check your inbox to verify your email')).toBeVisible();
  const mailpit = process.env.E2E_MAILPIT_URL ?? 'http://127.0.0.1:8025';
  let verificationUrl: string | undefined;
  await expect
    .poll(async () => {
      const response = await request.get(
        `${mailpit}/api/v1/search?query=to:${encodeURIComponent(email)}`,
      );
      const messages = (await response.json()) as { messages: Array<{ ID: string }> };
      const message = messages.messages[0];
      if (!message) return false;
      const detail = (await (
        await request.get(`${mailpit}/api/v1/message/${message.ID}`)
      ).json()) as {
        Text: string;
      };
      verificationUrl = detail.Text.match(/https?:\/\/[^\s<>]+verify-email[^\s<>]*/)?.[0];
      return Boolean(verificationUrl);
    })
    .toBeTruthy();
  if (!verificationUrl) throw new Error('Verification URL missing');
  expect((await request.get(verificationUrl)).ok()).toBeTruthy();
  await page.getByRole('button', { name: 'Back to sign in' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Library' })).toBeVisible();

  const created = await page.request.post('api/v1/projects', {
    data: { name: `Context menus ${Date.now()}` },
  });
  expect(created.ok()).toBeTruthy();
  const { project } = (await created.json()) as { project: { id: string } };
  const endpoint = `api/v1/projects/${project.id}`;
  const folderResponse = await page.request.post(`${endpoint}/entries`, {
    data: { name: 'chapters', kind: 'folder', parentId: null },
  });
  expect(folderResponse.ok()).toBeTruthy();
  const { entry: folder } = (await folderResponse.json()) as { entry: ProjectEntry };
  const fileResponse = await page.request.post(`${endpoint}/entries`, {
    data: { name: 'intro.tex', kind: 'file', parentId: folder.id, content: 'Introduction' },
  });
  expect(fileResponse.ok()).toBeTruthy();
  await page.goto(`projects/${project.id}`);
  const tree = page.getByRole('tree', { name: 'Project files' });
  const row = (name: string) => tree.getByRole('treeitem', { name, exact: true });
  const menu = page.getByRole('menu');
  const item = (name: string) => menu.getByRole('menuitem', { name, exact: true });
  const nameInput = page.getByRole('dialog').getByLabel('Name', { exact: true });
  await expect(row('main.tex')).toHaveAttribute('aria-selected', 'true');

  await row('intro.tex').click({ button: 'right' });
  await expect(menu).toHaveAccessibleName('Actions for intro.tex');
  await expect(row('intro.tex')).toHaveAttribute('aria-selected', 'true');
  await expect(item('New file')).toHaveCount(0);
  for (const action of ['Rename', 'Duplicate', 'Move', 'Delete'])
    await expect(item(action)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(row('intro.tex')).toBeFocused();

  await row('intro.tex').press('Shift+F10');
  await expect(menu).toBeVisible();
  await expect(item('Rename')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(item('Duplicate')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Rename entry' })).toBeVisible();
  await expect(nameInput).toHaveValue('intro.tex');
  await nameInput.fill('opening.tex');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(row('opening.tex')).toBeVisible();
  await expect(row('main.tex')).toBeVisible();

  await row('opening.tex').click({ button: 'right' });
  await item('Duplicate').click();
  await expect(row('opening copy.tex')).toBeVisible();
  await row('opening copy.tex').click({ button: 'right' });
  await item('Move').click();
  await page.getByLabel('Destination').selectOption('');
  await page.getByRole('dialog').getByRole('button', { name: 'Move', exact: true }).click();
  await expect(row('opening copy.tex')).toHaveAttribute('aria-level', '1');

  // A folder drop must not bubble into the tree's move-to-root handler.
  let dragMoves = 0;
  const countMove = (request: import('@playwright/test').Request) => {
    if (request.method() === 'PATCH' && request.url().includes(`${endpoint}/entries/`))
      dragMoves += 1;
  };
  page.on('request', countMove);
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  await row('opening copy.tex').dispatchEvent('dragstart', { dataTransfer: transfer });
  await row('chapters').dispatchEvent('drop', { dataTransfer: transfer });
  await transfer.dispose();
  await expect(row('opening copy.tex')).toHaveAttribute('aria-level', '2');
  expect(dragMoves).toBe(1);
  page.off('request', countMove);
  await row('opening copy.tex').click({ button: 'right' });
  await item('Move').click();
  await page.getByLabel('Destination').selectOption('');
  await page.getByRole('dialog').getByRole('button', { name: 'Move', exact: true }).click();
  await expect(row('opening copy.tex')).toHaveAttribute('aria-level', '1');

  await row('chapters').click({ button: 'right' });
  await expect(row('chapters')).toHaveAttribute('aria-expanded', 'true');
  await expect(row('opening.tex')).toBeVisible();
  const accessibility = await new AxeBuilder({ page }).include('[role="menu"]').analyze();
  expect(accessibility.violations).toEqual([]);
  const bounds = await menu.boundingBox();
  const viewport = page.viewportSize();
  if (!bounds || !viewport) throw new Error('Menu bounds missing');
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
  await page.locator('.panel-header > span').first().click();
  await expect(menu).toHaveCount(0);

  await row('chapters').click();
  await expect(row('chapters')).toHaveAttribute('aria-expanded', 'false');
  await row('chapters').click({ button: 'right' });
  await expect(row('chapters')).toHaveAttribute('aria-expanded', 'false');
  await item('New file').click();
  await nameInput.fill('notes.tex');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(row('notes.tex')).toHaveAttribute('aria-level', '2');
  await row('chapters').click({ button: 'right' });
  await item('New folder').click();
  await nameInput.fill('drafts');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(row('drafts')).toHaveAttribute('aria-level', '2');

  await row('chapters').click({ button: 'right' });
  await item('Duplicate').click();
  await expect(row('chapters copy')).toBeVisible();
  await row('chapters copy').click({ button: 'right' });
  await item('Rename').click();
  await nameInput.fill('archive');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(row('archive')).toBeVisible();
  await row('chapters').click({ button: 'right' });
  await item('Delete').click();
  await expect(page.getByRole('dialog', { name: 'Delete entry' })).toContainText('chapters');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(row('chapters')).toBeVisible();
  await row('chapters').click({ button: 'right' });
  await item('Delete').click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(row('chapters')).toHaveCount(0);

  await row('opening copy.tex').click({ button: 'right' });
  await item('Delete').click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(row('opening copy.tex')).toHaveCount(0);
  const saved = (await (await page.request.get(endpoint)).json()) as { entries: ProjectEntry[] };
  expect(saved.entries.some((entry) => entry.name === 'main.tex')).toBeTruthy();
  expect(saved.entries.some((entry) => entry.id === folder.id)).toBeFalsy();
  const archive = saved.entries.find((entry) => entry.name === 'archive');
  expect(archive).toBeDefined();
  expect(
    saved.entries.filter((entry) => entry.parentId === archive?.id).map((entry) => entry.name),
  ).toEqual(expect.arrayContaining(['opening.tex', 'notes.tex', 'drafts']));
});
