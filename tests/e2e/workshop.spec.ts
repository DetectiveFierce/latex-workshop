import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext } from '@playwright/test';

const mailpitOrigin = process.env.E2E_MAILPIT_URL ?? 'http://127.0.0.1:8025';

test('verified user creates, edits, persists, and compiles a project', async ({
  browser,
  page,
  request,
}, testInfo) => {
  test.skip(
    testInfo.project.name === 'ipad-webkit',
    'Covered by the iPad desktop workspace workflow',
  );
  const email = `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
  const password = 'correct-horse-battery-staple';
  const projectName = `Acceptance ${Date.now()}`;

  await page.goto('auth');
  await page.getByRole('tab', { name: 'Create account' }).click();
  await page.getByLabel('Name').fill('Acceptance User');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Confirm password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText('Check your inbox to verify your email')).toBeVisible();

  const verificationUrl = await waitForVerificationUrl(request, email);
  const verification = await request.get(verificationUrl);
  expect(verification.ok()).toBeTruthy();

  await page.getByRole('button', { name: 'Back to sign in' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Library' })).toBeVisible();

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations.filter((violation) =>
      ['critical', 'serious'].includes(violation.impact ?? ''),
    ),
  ).toEqual([]);

  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('menuitem', { name: 'New project' }).click();
  await page.getByLabel('Project name').fill(projectName);
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByText(projectName)).toBeVisible();
  await expect(page).toHaveTitle('main.tex — Editor | LaTeX Workshop');
  await expect(page.getByText('TexLab ready')).toBeVisible({ timeout: 30_000 });

  await page.getByLabel('Project settings').click();
  await expect(page.getByRole('dialog', { name: 'Project settings' })).toBeVisible();
  await page.getByRole('button', { name: 'Configure shortcuts' }).click();
  const accountSettings = page.getByRole('dialog', { name: 'Account settings' });
  await expect(accountSettings).toBeVisible();
  await expect(page).toHaveTitle('main.tex — Editor | LaTeX Workshop');
  const paletteShortcut = page.locator('.shortcut-row').filter({ hasText: 'Open command palette' });
  await paletteShortcut.locator('.shortcut-binding').click();
  const shortcutRecorder = paletteShortcut.locator('.shortcut-recorder');
  await shortcutRecorder.click();
  await page.keyboard.press('Control+Enter');
  const assignShortcut = paletteShortcut.getByRole('button', { name: 'Assign' });
  await expect(assignShortcut).toBeEnabled();
  await assignShortcut.click();
  await expect(page.getByText('Conflicts with Compile project.')).toBeVisible();
  await page.getByRole('button', { name: 'Replace' }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Keyboard shortcuts saved.')).toBeVisible();
  await accountSettings.getByRole('button', { name: 'Close' }).click();
  await expect(page).toHaveTitle('main.tex — Editor | LaTeX Workshop');
  await page.keyboard.press('Control+Enter');
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+K');
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0);
  await page.reload();
  await expect(page).toHaveTitle('main.tex — Editor | LaTeX Workshop');
  await expect(page.locator('.monaco-editor')).toBeVisible();
  await page.keyboard.press('Control+Enter');
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
  await page.getByPlaceholder('Type a command or file name…').fill('Open keyboard shortcuts');
  await page.keyboard.press('Enter');
  await expect(accountSettings).toBeVisible();
  await page.getByRole('button', { name: 'Reset all' }).click();
  const saveResetShortcuts = page.getByRole('button', { name: 'Save', exact: true });
  if (await saveResetShortcuts.isEnabled()) await saveResetShortcuts.click();
  await accountSettings.getByRole('button', { name: 'Close' }).click();
  await expect(page).toHaveTitle('main.tex — Editor | LaTeX Workshop');
  await expect(page.locator('.monaco-editor')).toBeVisible();
  await page.keyboard.press('Control+K');
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
  await page.keyboard.press('Escape');

  let delayedSave = true;
  const saveStatuses: number[] = [];
  page.on('response', (response) => {
    if (
      response.request().method() === 'POST' &&
      /\/entries\/[^/]+\/edit-history\/commit$/.test(response.url())
    )
      saveStatuses.push(response.status());
  });
  await page.route('**/entries/*/edit-history/commit', async (route) => {
    if (route.request().method() === 'POST' && delayedSave) {
      delayedSave = false;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    await route.continue();
  });
  const editor = page.locator('.monaco-editor').first();
  await editor.click({ position: { x: 180, y: 90 } });
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await expect(page.locator('.view-lines')).not.toContainText('documentclass');
  for (const line of [
    '\\documentclass{article}',
    '\\begin{document}',
    'Acceptance build from the browser.',
    '\\end{document}',
  ]) {
    await page.keyboard.type(line);
    await page.keyboard.press('Enter');
  }
  await expect(page.locator('.view-lines')).toContainText('Acceptance build from the browser');
  await page.waitForTimeout(800);
  await page.keyboard.insertText('% edit made while the previous save is in flight');
  await expect(page.locator('.view-lines')).toContainText('edit made while the previous save');
  await expect(page.getByRole('dialog', { name: 'Resolve editing conflict' })).toHaveCount(0);
  await expect.poll(() => saveStatuses.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
  expect(saveStatuses).not.toContain(409);
  await expect(page.locator('.editor-panel').getByRole('status')).toHaveText('Changes saved');
  await page.reload();
  await expect(page.locator('.view-lines')).toContainText('Acceptance build from the browser');
  await expect(page.locator('.view-lines')).toContainText('edit made while the previous save');

  await editor.click();
  await page.keyboard.press('Control+F');
  await expect(editor.locator('.find-widget')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+H');
  await expect(editor.locator('.find-widget .replace-part')).toBeVisible();
  await page.keyboard.press('Escape');

  await editor.click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  const deleteCommit = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /\/edit-history\/commit$/.test(response.url()) &&
      response.ok(),
  );
  await page.keyboard.press('Control+D');
  await deleteCommit;
  await expect(page.locator('.view-lines')).not.toContainText('Acceptance build from the browser');

  const undoCheckout = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /\/edit-history\/checkout$/.test(response.url()) &&
      response.ok(),
  );
  await page.keyboard.press('Control+Z');
  await undoCheckout;
  await expect(page.locator('.view-lines')).toContainText('Acceptance build from the browser');

  const redoCheckout = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /\/edit-history\/checkout$/.test(response.url()) &&
      response.ok(),
  );
  await page.keyboard.press('Control+Y');
  await redoCheckout;
  await expect(page.locator('.view-lines')).not.toContainText('Acceptance build from the browser');

  const secondUndoCheckout = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /\/edit-history\/checkout$/.test(response.url()) &&
      response.ok(),
  );
  await page.keyboard.press('Control+Z');
  await secondUndoCheckout;
  await expect(page.locator('.view-lines')).toContainText('Acceptance build from the browser');

  const alternateCommit = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /\/edit-history\/commit$/.test(response.url()) &&
      response.ok(),
  );
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('% alternate redo branch');
  await page.keyboard.press('Control+S');
  await alternateCommit;
  await page.getByLabel('Undo history').click();
  const historyTree = page.getByRole('tree', { name: 'Edit history branches' });
  await expect.poll(() => historyTree.getByRole('treeitem').count()).toBeGreaterThanOrEqual(5);
  const historyCount = await historyTree.getByRole('treeitem').count();
  const undoHistoryDialog = page.getByRole('dialog').filter({
    has: page.getByRole('heading', { name: /Undo history/ }),
  });
  await undoHistoryDialog
    .locator('.dialog-actions')
    .getByRole('button', { name: 'Close', exact: true })
    .click();

  await page.context().setOffline(true);
  await editor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('% queued while offline');
  await expect(page.locator('.save-status')).toHaveText('offline');
  const replayedCommit = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /\/edit-history\/commit$/.test(response.url()) &&
      response.ok(),
  );
  await page.context().setOffline(false);
  await replayedCommit;
  await expect(page.locator('.editor-panel').getByRole('status')).toHaveText('Changes saved');

  const workspaceUrl = page.url();
  const otherDevice = await browser.newContext({
    storageState: await page.context().storageState(),
  });
  const otherPage = await otherDevice.newPage();
  await otherPage.goto(workspaceUrl);
  await expect(otherPage).toHaveTitle('main.tex — Editor | LaTeX Workshop');
  await otherPage.getByLabel('Undo history').click();
  await expect
    .poll(() =>
      otherPage.getByRole('tree', { name: 'Edit history branches' }).getByRole('treeitem').count(),
    )
    .toBeGreaterThan(historyCount);
  await otherDevice.close();

  await editor.click();
  await page.keyboard.press('Control+Enter');
  await expect(page.getByLabel('Download PDF')).toBeVisible({ timeout: 120_000 });
  await expect(page.getByLabel('Open PDF in new tab')).toBeVisible();

  const pdfFind = page.locator('.preview-toolbar').getByPlaceholder('Find');
  await pdfFind.fill('Acceptance');
  await expect(page.locator('.pdf-find-count')).not.toHaveText('—');
  await page.getByLabel('Next PDF match').click();
  await page.getByLabel('Previous PDF match').click();
  await pdfFind.fill('');
  await expect(page.locator('.pdf-find-count')).toHaveText('—');

  const forwardResponse = page.waitForResponse(
    (response) => /\/synctex\/forward$/.test(response.url()) && response.ok(),
    { timeout: 30_000 },
  );
  await editor.locator('.view-line').filter({ hasText: 'Acceptance build' }).dblclick();
  await forwardResponse;
  await expect(page.locator('.synctex-highlight')).toBeVisible();

  const locateResponse = page.waitForResponse(
    (response) => /\/synctex\/forward$/.test(response.url()) && response.ok(),
    { timeout: 30_000 },
  );
  await page.getByLabel('Forward search').click();
  await locateResponse;
  await expect(page.locator('.synctex-highlight')).toBeVisible();

  await editor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('% PDF is intentionally stale');
  await page.keyboard.press('Control+S');
  await expect(page.locator('.editor-panel').getByRole('status')).toHaveText('Changes saved');
  const staleLocate = page.waitForResponse(
    (response) => /\/synctex\/forward$/.test(response.url()) && response.ok(),
    { timeout: 30_000 },
  );
  await page.getByLabel('Forward search').click();
  await staleLocate;
  await expect(page.getByText('Approximate match in an older PDF')).toBeVisible();

  const pdfPagePromise = page.context().waitForEvent('page');
  await page.getByLabel('Open PDF in new tab').click();
  const pdfPage = await pdfPagePromise;
  await expect(page.getByLabel('Show PDF preview')).toBeVisible();
  await page.getByLabel('Show PDF preview').click();
  await expect(page.getByLabel('Hide PDF preview')).toBeVisible();
  await expect(pdfPage).toHaveTitle(`${projectName} — PDF | LaTeX Workshop`);
  await pdfPage.close();

  const overleafExport = await makeZip([
    ['Imported Alpha.zip', await makeZip([['main.tex', 'Alpha']])],
    ['Imported Beta.zip', await makeZip([['paper.tex', 'Beta']])],
  ]);
  await page.goto('projects');
  await page.locator('input[type="file"]').nth(1).setInputFiles({
    name: 'Overleaf Projects.zip',
    mimeType: 'application/zip',
    buffer: overleafExport,
  });
  const importStatus = page.getByLabel('Overleaf export import');
  await expect(importStatus).toBeVisible();
  await expect(importStatus).toContainText('2 projects imported', { timeout: 30_000 });
  await expect(page.getByText('Imported Alpha')).toBeVisible();
  await expect(page.getByText('Imported Beta')).toBeVisible();
});

test('library organizes projects with folders, tags, views, bulk actions, and recovery', async ({
  page,
  request,
}) => {
  const email = `library-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
  const password = 'correct-horse-battery-staple';

  await page.goto('auth');
  await page.getByRole('tab', { name: 'Create account' }).click();
  await page.getByLabel('Name').fill('Library User');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Confirm password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  expect((await request.get(await waitForVerificationUrl(request, email))).ok()).toBeTruthy();
  await page.getByRole('button', { name: 'Back to sign in' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Library' })).toBeVisible();

  await page.getByRole('button', { name: 'Templates' }).click();
  await expect(page.getByRole('heading', { name: 'Templates' })).toBeVisible();
  await expect(page.getByText('Aidan Template', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Aidan Template actions' }).click();
  await page.getByRole('menuitem', { name: 'Use template' }).click();
  await expect(page.getByRole('radio', { name: /Aidan Template/ })).toBeChecked();
  await page.getByLabel('Project name').fill('From Aidan');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveTitle('template.tex — Editor | LaTeX Workshop');
  await expect(page.getByText('Template', { exact: true })).toHaveCount(0);
  await page.getByLabel('Back to projects').click();
  await expect(page.getByText('From Aidan', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'From Aidan actions' }).click();
  await page.getByRole('menuitem', { name: 'Make template' }).click();
  await expect(page.getByText('From Aidan', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Templates' }).click();
  await expect(page.getByText('From Aidan', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'From Aidan actions' }).click();
  await page.getByRole('menuitem', { name: 'Remove from templates' }).click();
  await expect(page.getByText('From Aidan', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await expect(page.getByText('From Aidan', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('menuitem', { name: 'New folder' }).click();
  await page.getByLabel('Folder name').fill('Research');
  await page.getByRole('button', { name: 'Create folder' }).click();
  await expect(
    page.locator('.folder-tile').getByRole('button', { name: 'Research', exact: true }),
  ).toBeVisible();
  await page.locator('.folder-tile').getByRole('button', { name: 'Research', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Research' })).toBeVisible();

  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('menuitem', { name: 'New folder' }).click();
  await page.getByLabel('Folder name').fill('2026');
  await page.getByRole('button', { name: 'Create folder' }).click();
  await expect(
    page.locator('.folder-tile').getByRole('button', { name: '2026', exact: true }),
  ).toBeVisible();

  const library = (await (await page.request.get('api/v1/library?trash=false')).json()) as {
    folders: Array<{ id: string; name: string }>;
  };
  const researchId = library.folders.find((folder) => folder.name === 'Research')!.id;
  const created = await page.request.post('api/v1/projects', {
    data: { name: 'Folder Paper', folderId: researchId },
  });
  expect(created.status()).toBe(201);
  await page.reload();
  await expect(page.getByText('Folder Paper')).toBeVisible();

  await page.getByRole('button', { name: 'New tag' }).click();
  await page.getByLabel('Tag name').fill('Draft');
  await page.getByRole('button', { name: 'amber' }).click();
  await page.getByRole('button', { name: 'Create tag' }).click();
  await page.getByRole('button', { name: 'Folder Paper actions' }).click();
  await page.getByRole('menuitem', { name: 'Manage tags' }).click();
  const draftTag = page.getByRole('checkbox', { name: /Draft/ });
  const draftInitiallyAssigned = await draftTag.isChecked();
  expect(draftInitiallyAssigned).toBe(false);
  if (!draftInitiallyAssigned) {
    await draftTag.click();
    await expect(draftTag).toBeChecked();
  }
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('.library-project-card').getByText('Draft')).toBeVisible();

  await page.getByRole('button', { name: 'List view' }).click();
  await expect(page.getByText('Location', { exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Select Folder Paper' }).check();
  await page
    .getByRole('toolbar', { name: 'Selected project actions' })
    .getByRole('button', { name: 'Move', exact: true })
    .click();
  await page.getByRole('treeitem', { name: '2026' }).click();
  await page.getByRole('button', { name: 'Move', exact: true }).click();
  await expect(page.getByText('Folder Paper')).toHaveCount(0);

  await page.locator('.folder-tile').getByRole('button', { name: '2026', exact: true }).click();
  await expect(page.getByText('Folder Paper')).toBeVisible();
  await page.getByRole('checkbox', { name: 'Select Folder Paper' }).check();
  await page
    .getByRole('toolbar', { name: 'Selected project actions' })
    .getByRole('button', { name: 'Favorite' })
    .click();
  await expect(page.getByText('Project updated', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Favorites', exact: true }).click();
  await expect(page.getByText('Folder Paper')).toBeVisible();

  await page.getByRole('checkbox', { name: 'Select Folder Paper' }).check();
  await page
    .getByRole('toolbar', { name: 'Selected project actions' })
    .getByRole('button', { name: 'Trash' })
    .click();
  await page.getByRole('button', { name: 'Move to trash' }).click();
  await page.getByRole('button', { name: 'Trash', exact: true }).click();
  await expect(page.getByText('Folder Paper')).toBeVisible();
  await page.getByRole('button', { name: 'Folder Paper actions' }).click();
  await page.getByRole('menuitem', { name: 'Restore' }).click();
  await expect(page.getByText('Folder Paper')).toHaveCount(0);

  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await page.getByRole('button', { name: 'Research folder actions' }).last().click();
  await page.getByRole('menuitem', { name: 'Move to trash' }).click();
  await page.getByRole('button', { name: 'Move to trash' }).click();
  await page.getByRole('button', { name: 'Trash', exact: true }).click();
  await expect(page.locator('.folder-tile').getByText('Research')).toBeVisible();
  await page.getByRole('button', { name: 'Research folder actions' }).click();
  await page.getByRole('menuitem', { name: 'Restore folder' }).click();
  await expect(page.locator('.folder-tile').getByText('Research')).toHaveCount(0);

  await page.setViewportSize({ width: 600, height: 820 });
  await page.getByRole('button', { name: 'Open library navigation' }).click();
  await expect(page.locator('.library-sidebar.open')).toBeVisible();
  await page.locator('.library-sidebar').getByRole('button', { name: 'Close navigation' }).click();
});

test('iPad desktop workspace edits, manages files, uploads, and compiles', async ({
  page,
  request,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'ipad-webkit', 'iPad WebKit acceptance only');
  await page.setViewportSize({ width: 834, height: 1194 });

  const email = `ipad-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
  const password = 'correct-horse-battery-staple';
  const projectName = `iPad Acceptance ${Date.now()}`;

  await page.goto('auth');
  await expect(page.locator('html')).toHaveAttribute('data-layout', 'desktop');
  await page.getByRole('tab', { name: 'Create account' }).tap();
  await page.getByLabel('Name').fill('iPad Acceptance User');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Confirm password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).tap();
  await expect(page.getByText('Check your inbox to verify your email')).toBeVisible();

  const verificationUrl = await waitForVerificationUrl(request, email);
  expect((await request.get(verificationUrl)).ok()).toBeTruthy();

  await page.getByRole('button', { name: 'Back to sign in' }).tap();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).tap();
  await expect(page.getByRole('heading', { name: 'Library' })).toBeVisible();

  await page.getByRole('button', { name: 'New', exact: true }).tap();
  await page.getByRole('menuitem', { name: 'New project' }).tap();
  await page.getByLabel('Project name').fill(projectName);
  await page.getByRole('button', { name: 'Create project' }).tap();
  await expect(page.getByText('TexLab ready')).toBeVisible({ timeout: 30_000 });
  // iPad uses the multi-pane desktop workspace (Magic Keyboard / trackpad), not the phone switcher.
  await expect(page.locator('html')).toHaveAttribute('data-layout', 'desktop');
  await expect(page.getByRole('navigation', { name: 'Workspace panes' })).toHaveCount(0);
  await expect(page.locator('.file-panel')).toBeVisible();
  await expect(page.locator('.editor-panel')).toBeVisible();
  await expect(page.locator('.preview-panel')).toBeVisible();

  await page.getByLabel('New file').tap();
  await page.getByRole('dialog', { name: 'Create file' }).getByLabel('Name').fill('chapter.tex');
  await page
    .getByRole('dialog', { name: 'Create file' })
    .getByRole('button', { name: 'Save' })
    .tap();
  await expect(
    page.locator('.file-tree .tree-row').filter({ hasText: 'chapter.tex' }),
  ).toBeVisible();
  await page.locator('.file-tree .tree-row').filter({ hasText: 'chapter.tex' }).tap();
  await page.getByRole('button', { name: 'Rename', exact: true }).tap();
  await page
    .getByRole('dialog', { name: 'Rename entry' })
    .getByLabel('Name')
    .fill('touch-chapter.tex');
  await page
    .getByRole('dialog', { name: 'Rename entry' })
    .getByRole('button', { name: 'Save' })
    .tap();
  await expect(
    page.locator('.file-tree .tree-row').filter({ hasText: 'touch-chapter.tex' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Delete', exact: true }).tap();
  await page
    .getByRole('dialog', { name: 'Delete entry' })
    .getByRole('button', { name: 'Delete', exact: true })
    .tap();
  await expect(
    page.locator('.file-tree .tree-row').filter({ hasText: 'touch-chapter.tex' }),
  ).toHaveCount(0);

  await page.locator('input[type="file"]').setInputFiles({
    name: 'touch-upload.png',
    mimeType: 'image/png',
    buffer: Buffer.from('touch-upload'),
  });
  await expect(
    page.locator('.file-tree .tree-row').filter({ hasText: 'touch-upload.png' }),
  ).toBeVisible();

  await page.locator('.file-tree .tree-row').filter({ hasText: 'main.tex' }).tap();
  const editor = page.locator('.monaco-editor').first();
  // Tap the body copy rather than relying on a keyboard navigation shortcut.
  await editor.tap({ position: { x: 170, y: 215 } });
  await page.keyboard.insertText('iPad touch edit ');
  await expect(page.locator('.view-lines')).toContainText('iPad touch edit');
  await page.waitForTimeout(1_200);
  await page.reload();
  await expect(page.locator('.view-lines')).toContainText('iPad touch edit');
  await expect(page.locator('html')).toHaveAttribute('data-layout', 'desktop');

  await page.locator('header').getByRole('button', { name: 'Compile', exact: true }).tap();
  await expect(page.getByLabel('Download PDF')).toBeVisible({ timeout: 120_000 });
  await expect(page.locator('.pdf-page-total')).toBeVisible();
  await expect(page.locator('.pdf-page-total')).toHaveCSS('white-space', 'nowrap');
  // Zoom in so the preview is larger than the scrollport and can pan on iPad.
  await page.getByLabel('Zoom in').tap();
  await page.getByLabel('Zoom in').tap();

  // PDF preview must remain a real nested scrollport (not a scaled 1280 desktop viewport).
  const pdfMetrics = await page.locator('.pdf-container').evaluate((node) => {
    const style = window.getComputedStyle(node);
    return {
      overflow: style.overflow,
      touchAction: style.touchAction,
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
      scrollWidth: node.scrollWidth,
      clientWidth: node.clientWidth,
      viewport: document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? '',
    };
  });
  expect(pdfMetrics.viewport).toContain('width=device-width');
  expect(pdfMetrics.touchAction).toContain('pan-x');
  expect(
    pdfMetrics.scrollHeight > pdfMetrics.clientHeight ||
      pdfMetrics.scrollWidth > pdfMetrics.clientWidth,
  ).toBeTruthy();

  const before = await page.locator('.pdf-container').evaluate((node) => ({
    top: node.scrollTop,
    left: node.scrollLeft,
  }));
  await page.locator('.pdf-container').evaluate((node) => {
    node.scrollTop = Math.min(node.scrollHeight, node.scrollTop + 240);
    node.scrollLeft = Math.min(node.scrollWidth, node.scrollLeft + 120);
  });
  const after = await page.locator('.pdf-container').evaluate((node) => ({
    top: node.scrollTop,
    left: node.scrollLeft,
  }));
  expect(after.top > before.top || after.left > before.left).toBeTruthy();

  await page.setViewportSize({ width: 1194, height: 834 });
  await expect(page.locator('.file-panel')).toBeVisible();
  await expect(page.locator('.file-tree .tree-row').filter({ hasText: 'main.tex' })).toBeVisible();
  await expect(page.locator('.preview-panel')).toBeVisible();
});

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

async function makeZip(files: Array<[string, string | Buffer]>): Promise<Buffer> {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of files) {
    const filename = Buffer.from(name);
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(filename.length, 26);
    localParts.push(local, filename, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, filename);
    offset += local.length + filename.length + data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function crc32(data: Buffer): number {
  let checksum = 0xffffffff;
  for (const byte of data) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      checksum = (checksum >>> 1) ^ (checksum & 1 ? 0xedb88320 : 0);
  }
  return (checksum ^ 0xffffffff) >>> 0;
}
