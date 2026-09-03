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

  it('rejects case-insensitive duplicate paths', async () => {
    const archive = await makeZip([
      ['MAIN.tex', 'first'],
      ['main.tex', 'second'],
    ]);

    await expect(readProjectArchive(archive, config)).rejects.toThrow('duplicate path');
  });

  it('enforces the file limit against expanded bytes', async () => {
    const archive = await makeZip([['main.tex', 'too large']]);

    await expect(
      readProjectArchive(archive, { MAX_FILE_BYTES: 4, MAX_PROJECT_BYTES: 100 }),
    ).rejects.toThrow('too large');
  });

  it('rejects deterministically fuzzed corrupt archives without hanging', async () => {
    let state = 0x51a7e;
    const random = () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state;
    };

    for (let run = 0; run < 250; run += 1) {
      const bytes = Buffer.from(Array.from({ length: random() % 256 }, () => random() & 0xff));
      await expect(readProjectArchive(bytes, config)).rejects.toBeInstanceOf(Error);
    }
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
