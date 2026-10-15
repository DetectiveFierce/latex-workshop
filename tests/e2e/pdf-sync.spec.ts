import { expect, test } from '@playwright/test';
import { inverseSyncRequestSchema, inverseSyncResultSchema } from '@latex-workshop/contracts';

test('PDF text selection locates a late chapter with a duplicate filename', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const email = `pdf-sync-${Date.now()}@example.test`;
  const password = 'correct-horse-battery-staple';
  const origin = new URL(process.env.E2E_BASE_URL ?? 'http://localhost:5173/latex-workshop/')
    .origin;
  const headers = { Origin: origin };
  expect(
    (
      await page.request.post('api/auth/sign-up/email', {
        headers,
        data: { name: 'PDF Sync User', email, password },
      })
    ).ok(),
  ).toBeTruthy();
  const mailpit = process.env.E2E_MAILPIT_URL ?? 'http://127.0.0.1:8025';
  let verificationUrl: string | undefined;
  await expect
    .poll(async () => {
      const messages = (await (
        await request.get(`${mailpit}/api/v1/search?query=to:${encodeURIComponent(email)}`)
      ).json()) as { messages: Array<{ ID: string }> };
      const message = messages.messages[0];
      if (!message) return false;
      const detail = (await (
        await request.get(`${mailpit}/api/v1/message/${message.ID}`)
      ).json()) as { Text: string };
      verificationUrl = detail.Text.match(/https?:\/\/[^\s<>]+verify-email[^\s<>]*/)?.[0];
      return Boolean(verificationUrl);
    })
    .toBeTruthy();
  if (!verificationUrl) throw new Error('Verification URL missing');
  expect((await request.get(verificationUrl, { maxRedirects: 0 })).status()).toBe(302);
  expect(
    (
      await page.request.post('api/auth/sign-in/email', { headers, data: { email, password } })
    ).ok(),
  ).toBeTruthy();
  const created = await page.request.post('api/v1/projects', {
    data: { name: `Large PDF sync ${Date.now()}` },
  });
  expect(created.ok()).toBeTruthy();
  const { project } = (await created.json()) as { project: { id: string; mainFileId: string } };
  const endpoint = `api/v1/projects/${project.id}`;
  const createEntry = async (
    name: string,
    kind: 'file' | 'folder',
    parentId: string | null,
    content?: string,
  ) => {
    const response = await page.request.post(`${endpoint}/entries`, {
      data: { name, kind, parentId, ...(content !== undefined ? { content } : {}) },
    });
    expect(response.ok()).toBeTruthy();
    return ((await response.json()) as { entry: { id: string } }).entry;
  };
  const chapters = await createEntry('chapters', 'folder', null);
  const earlier = await createEntry('earlier', 'folder', chapters.id);
  const later = await createEntry('later', 'folder', chapters.id);
  await createEntry(
    'section.tex',
    'file',
    earlier.id,
    Array.from(
      { length: 32 },
      (_, index) =>
        `\\section*{Earlier page ${index}}\nBackground material for the earlier chapter.\n\\clearpage`,
    ).join('\n'),
  );
  const targetText = 'Robust synchronization locates this final chapter.';
  const lateSource =
    '% padding\n'.repeat(3_500) + targetText + '\nAnother unique source sentence follows.\n';
  const targetFile = await createEntry('section.tex', 'file', later.id, lateSource);
  const mainContent =
    '\\documentclass{article}\n\\begin{document}\n\\input{chapters/earlier/section}\n\\input{chapters/later/section}\n\\end{document}';
  expect(
    (
      await page.request.put(`${endpoint}/entries/${project.mainFileId}/content`, {
        data: { baseVersion: 1, content: mainContent },
      })
    ).ok(),
  ).toBeTruthy();
  const queued = await page.request.post(`${endpoint}/compilations`, {
    data: { trigger: 'manual' },
  });
  expect(queued.ok()).toBeTruthy();
  const { job } = (await queued.json()) as { job: { id: string } };
  await expect
    .poll(
      async () =>
        (
          (await (await page.request.get(`${endpoint}/compilations/${job.id}`)).json()) as {
            job: { status: string };
          }
        ).job.status,
      { timeout: 120_000 },
    )
    .toBe('succeeded');
  await page.goto(`projects/${project.id}`);
  const pageNumber = page.getByRole('spinbutton', { name: 'Page number' });
  await expect(pageNumber).toHaveAttribute('max', '33', { timeout: 30_000 });
  await pageNumber.fill('33');
  const text = page
    .locator('.pdfViewer .page[data-page-number="33"] .textLayer span')
    .filter({ hasText: targetText })
    .first();
  await expect(text).toBeVisible();
  const inverse = page.waitForResponse(
    (response) => response.url().endsWith('/synctex/inverse') && response.ok(),
  );
  const bounds = await text.boundingBox();
  if (!bounds) throw new Error('PDF text bounds missing');
  await page.mouse.move(bounds.x + 1, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width - 1, bounds.y + bounds.height / 2, { steps: 12 });
  await page.mouse.up();
  const selectedResponse = await inverse;
  const location = inverseSyncRequestSchema.parse(selectedResponse.request().postDataJSON());
  const result = inverseSyncResultSchema.parse(await selectedResponse.json());
  expect(result.entryId).toBe(targetFile.id);
  expect(result.path).toBe('chapters/later/section.tex');
  expect(result.line).toBe(3_501);
  await expect(page.locator('.editor-tab.active')).toContainText('section.tex');
  await expect(page.locator('.view-lines')).toContainText(targetText);
  await expect(page.locator('.monaco-editor .selected-text').first()).toBeVisible();

  // PDF lookup must flush edits still awaiting autosave, then align against the
  // saved source rather than navigating to the compilation's old line number.
  await page.locator('.monaco-editor').first().click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.insertText('% inserted after compilation\n'.repeat(20));
  const afterEdit = page.waitForResponse(
    (response) => response.url().endsWith('/synctex/inverse') && response.ok(),
  );
  // A reversed native range also verifies that lookup uses document order.
  // Create it directly to avoid Chromium's tiny transformed-glyph drag behavior.
  await text.evaluate((element) => {
    const node = element.firstChild;
    if (!node) throw new Error('PDF text node missing');
    window.getSelection()?.setBaseAndExtent(node, node.textContent?.length ?? 0, node, 0);
  });
  const relocated = inverseSyncResultSchema.parse(await (await afterEdit).json());
  const saved = (await (
    await page.request.get(`${endpoint}/entries/${targetFile.id}/content`)
  ).json()) as { content: string };
  const sourceLine = saved.content.split('\n').findIndex((line) => line === targetText) + 1;
  expect(sourceLine).toBeGreaterThan(3_501);
  expect(relocated.line).toBe(sourceLine);
  await expect(page.locator('.view-lines')).toContainText(targetText);
  await expect(page.locator('.monaco-editor .selected-text').first()).toBeVisible();
  await expect(page.locator('.editor-panel').getByRole('status')).toHaveText('Changes saved');
  const shifted = await page.request.post(`${endpoint}/compilations/${job.id}/synctex/inverse`, {
    data: { ...location, text: targetText },
  });
  expect(shifted.ok()).toBeTruthy();
  const aligned = inverseSyncResultSchema.parse(await shifted.json());
  expect(aligned.path).toBe('chapters/later/section.tex');
  expect(aligned.line).toBe(sourceLine);
  expect(aligned.confidence).toBe('approximate');
});
