import { expect, test } from '@playwright/test';

test('PDF downloads use the current project name in the editor and PDF tab', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const email = `pdf-download-${Date.now()}@example.test`;
  const password = 'correct-horse-battery-staple';
  const origin = new URL(process.env.E2E_BASE_URL ?? 'http://localhost:5173/latex-workshop/')
    .origin;
  const headers = { Origin: origin };
  expect(
    (
      await page.request.post('api/auth/sign-up/email', {
        headers,
        data: { name: 'PDF Download User', email, password },
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

  const projectName = `Download regression ${Date.now()}`;
  const created = await page.request.post('api/v1/projects', { data: { name: projectName } });
  expect(created.ok()).toBeTruthy();
  const { project } = (await created.json()) as { project: { id: string; mainFileId: string } };
  const endpoint = `api/v1/projects/${project.id}`;
  expect(
    (
      await page.request.put(`${endpoint}/entries/${project.mainFileId}/content`, {
        data: {
          baseVersion: 1,
          content:
            '\\documentclass{article}\n\\begin{document}\nDownload filename regression.\n\\end{document}',
        },
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
  const downloadLink = page.getByLabel('Download PDF', { exact: true });
  await expect(downloadLink).toBeVisible();
  const originalDownloadUrl = await downloadLink.getAttribute('href');
  const firstDownload = page.waitForEvent('download');
  await downloadLink.click();
  expect((await firstDownload).suggestedFilename()).toBe(`${projectName}.pdf`);

  const renamedProjectName = `${projectName} Résumé`;
  await page.getByRole('button', { name: `Rename project ${projectName}`, exact: true }).dblclick();
  await page.getByRole('textbox', { name: 'Project title', exact: true }).fill(renamedProjectName);
  await page.getByRole('textbox', { name: 'Project title', exact: true }).press('Enter');
  await expect(downloadLink).toHaveAttribute('download', `${renamedProjectName}.pdf`);
  const renamedDownloadUrl = await downloadLink.getAttribute('href');
  expect(renamedDownloadUrl).not.toBe(originalDownloadUrl);
  if (!renamedDownloadUrl) throw new Error('Missing PDF download URL');
  const renamedDownload = page.waitForEvent('download');
  await downloadLink.click();
  expect((await renamedDownload).suggestedFilename()).toBe(`${renamedProjectName}.pdf`);
  const response = await page.request.get(renamedDownloadUrl);
  expect(response.ok()).toBeTruthy();
  expect(response.headers()['cache-control']).toBe('private, no-store');
  expect(response.headers()['content-type']).toContain('application/pdf');
  expect(response.headers()['content-disposition']).toContain(
    `filename*=UTF-8''${encodeURIComponent(renamedProjectName)}.pdf`,
  );

  await page.goto(`projects/${project.id}/pdf/${job.id}`);
  await expect(downloadLink).toHaveAttribute('download', `${renamedProjectName}.pdf`);
  const pdfTabDownload = page.waitForEvent('download');
  await downloadLink.click();
  expect((await pdfTabDownload).suggestedFilename()).toBe(`${renamedProjectName}.pdf`);
});
