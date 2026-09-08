import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '@latex-workshop/config';
import { agentPdfPageLimits } from '@latex-workshop/contracts';

export type RenderedPdfPage = { page: number; data: Buffer };

export function pdfPageRenderDockerArgs(
  config: Pick<AppConfig, 'COMPILE_IMAGE'>,
  workspace: string,
  containerName: string,
  pages: readonly number[],
  uid: number,
  gid: number,
) {
  return [
    'run',
    '--rm',
    '--name',
    containerName,
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '64',
    '--cpus',
    '1',
    '--memory',
    '512m',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=64m',
    '--user',
    `${uid}:${gid}`,
    '--mount',
    `type=bind,source=${workspace},target=/workspace`,
    '--workdir',
    '/workspace',
    config.COMPILE_IMAGE,
    'gs',
    '-q',
    '-dSAFER',
    '-dBATCH',
    '-dNOPAUSE',
    '-dTextAlphaBits=4',
    '-dGraphicsAlphaBits=4',
    '-sDEVICE=png16m',
    '-r144',
    `-sPageList=${pages.join(',')}`,
    '-sOutputFile=/workspace/page-%d.png',
    '/workspace/document.pdf',
  ];
}

export class DockerPdfPageRenderer {
  constructor(private readonly config: AppConfig) {}

  async render(input: {
    renderRequestId: string;
    pdf: Buffer;
    pages: readonly number[];
  }): Promise<RenderedPdfPage[]> {
    if (input.pdf.byteLength > agentPdfPageLimits.maxPdfBytes)
      throw new Error('Compiled PDF exceeds the render size limit');
    const workspace = await mkdtemp(join(tmpdir(), 'latex-pdf-render-'));
    const containerName = `latex-workshop-pdf-${input.renderRequestId}`;
    try {
      await writeFile(join(workspace, 'document.pdf'), input.pdf);
      const uid = typeof process.getuid === 'function' ? process.getuid() : 10001;
      const gid = typeof process.getgid === 'function' ? process.getgid() : 10001;
      const child = spawn(
        'docker',
        pdfPageRenderDockerArgs(this.config, workspace, containerName, input.pages, uid, gid),
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let log = '';
      const append = (chunk: Buffer) => {
        if (log.length < 64 * 1024) log += chunk.toString('utf8');
      };
      child.stdout.on('data', append);
      child.stderr.on('data', append);
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        void killContainer(containerName);
      }, 30_000);
      const exitCode = await new Promise<number>((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code) => resolve(code ?? 1));
      }).finally(() => clearTimeout(timeout));
      if (timedOut) throw new Error('PDF page rendering exceeded the time limit');
      if (exitCode !== 0)
        throw new Error(`PDF page rendering failed${log.trim() ? `: ${log.trim()}` : ''}`);

      return Promise.all(
        input.pages.map(async (page, index) => {
          const path = join(workspace, `page-${index + 1}.png`);
          const metadata = await stat(path).catch(() => null);
          if (!metadata) throw new Error(`PDF page ${page} does not exist`);
          if (metadata.size > agentPdfPageLimits.maxImageBytes)
            throw new Error(`Rendered page ${page} exceeds the image size limit`);
          const data = await readFile(path);
          if (!data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
            throw new Error(`Rendered page ${page} is not a valid PNG`);
          return { page, data };
        }),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }
}

async function killContainer(name: string) {
  await new Promise<void>((resolve) => {
    const child = spawn('docker', ['kill', name], { stdio: 'ignore' });
    child.on('close', () => resolve());
    child.on('error', () => resolve());
  });
}
