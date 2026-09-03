import { PassThrough } from 'node:stream';
import archiver from 'archiver';
import { describe, expect, it } from 'vitest';
import { readOverleafArchive, readProjectArchive } from './transfers.js';

const config = {
  MAX_FILE_BYTES: 1_000_000,
  MAX_PROJECT_BYTES: 5_000_000,
  MAX_USER_BYTES: 10_000_000,
};

describe('archive imports', () => {
  it('reads a regular project ZIP', async () => {
    const archive = await makeZip([
      ['main.tex', '\\documentclass{article}'],
      ['chapters/intro.tex', 'Hello'],
    ]);

    const files = await readProjectArchive(archive, config);

    expect(files.map((file) => file.path)).toEqual(['main.tex', 'chapters/intro.tex']);
    expect(files[1]?.data.toString()).toBe('Hello');
  });

  it('reads an Overleaf ZIP-of-ZIPs as separate named projects', async () => {
    const first = await makeZip([['main.tex', 'First']]);
    const second = await makeZip([
      ['paper.tex', 'Second'],
      ['refs/library.bib', '@book{example}'],
    ]);
    const exportArchive = await makeZip([
      ['First Paper.zip', first],
      ['Second Paper.zip', second],
    ]);

    const imported = await readOverleafArchive(exportArchive, config);

    expect(imported.map((project) => project.name)).toEqual(['First Paper', 'Second Paper']);
    expect(imported[1]?.files.map((file) => file.path)).toEqual(['paper.tex', 'refs/library.bib']);
  });

  it('rejects files that are not nested project ZIPs', async () => {
    const exportArchive = await makeZip([['README.txt', 'not an Overleaf export']]);

    await expect(readOverleafArchive(exportArchive, config)).rejects.toThrow(
      'must contain only project ZIP files',
    );
  });

  it('rejects a corrupted nested project ZIP before import', async () => {
    const exportArchive = await makeZip([['Broken.zip', 'not a zip']]);

    await expect(readOverleafArchive(exportArchive, config)).rejects.toThrow(
      'Project ZIP is invalid or corrupted',
    );
  });
});

async function makeZip(files: Array<[string, string | Buffer]>): Promise<Buffer> {
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  const complete = new Promise<Buffer>((resolve, reject) => {
    output.on('end', () => resolve(Buffer.concat(chunks)));
    output.on('error', reject);
  });
  const archive = archiver('zip', { zlib: { level: 1 } });
  archive.on('error', (error) => output.destroy(error));
  archive.pipe(output);
  for (const [name, content] of files) archive.append(content, { name });
  await archive.finalize();
  return complete;
}
