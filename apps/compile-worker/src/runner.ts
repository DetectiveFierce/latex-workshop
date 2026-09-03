import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AppConfig } from '@latex-workshop/config';
import type { CompilerEngine } from '@latex-workshop/contracts';

export type RunnerResult = {
  exitCode: number;
  log: string;
  pdf: Buffer | null;
  synctex: Buffer | null;
  durationMs: number;
  timedOut: boolean;
};

export interface CompilationRunner {
  run(input: {
    jobId: string;
    files: Array<{ path: string; data: Buffer }>;
    mainPath: string;
    engine: CompilerEngine;
    isCancelled: () => Promise<boolean>;
  }): Promise<RunnerResult>;
}

export class DockerCompilationRunner implements CompilationRunner {
  constructor(private readonly config: AppConfig) {}

  async run(input: {
    jobId: string;
    files: Array<{ path: string; data: Buffer }>;
    mainPath: string;
    engine: CompilerEngine;
    isCancelled: () => Promise<boolean>;
  }): Promise<RunnerResult> {
    const workspace = await mkdtemp(join(tmpdir(), 'latex-build-'));
    const started = Date.now();
    const containerName = `latex-workshop-${input.jobId}`;
    try {
      for (const file of input.files) {
        const target = join(workspace, file.path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, file.data);
      }
      await mkdir(join(workspace, '.build'), { recursive: true });
      await chmod(workspace, 0o755);
      await chmod(join(workspace, '.build'), 0o777);
      const engineFlag =
        input.engine === 'pdflatex'
          ? '-pdf'
          : input.engine === 'xelatex'
            ? '-xelatex'
            : '-lualatex';
      const uid = typeof process.getuid === 'function' ? process.getuid() : 10001;
      const gid = typeof process.getgid === 'function' ? process.getgid() : 10001;
      const args = [
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
        '256',
        '--cpus',
        '2',
        '--memory',
        '2g',
        '--tmpfs',
        '/tmp:rw,noexec,nosuid,size=128m',
        '--user',
        `${uid}:${gid}`,
        '--env',
        'HOME=/tmp',
        '--env',
        'XDG_CACHE_HOME=/tmp',
        '--env',
        'TEXMFVAR=/tmp',
        '--env',
        'TEXMFCACHE=/tmp',
        '--mount',
        `type=bind,source=${workspace},target=/workspace`,
        '--workdir',
        '/workspace',
        this.config.COMPILE_IMAGE,
        'latexmk',
        '-norc',
        engineFlag,
        '-interaction=nonstopmode',
        '-halt-on-error',
        '-file-line-error',
        '-synctex=1',
        '-jobname=document',
        '-outdir=/workspace/.build',
        '-e',
        '$pdflatex=q/pdflatex -no-shell-escape %O %S/',
        '-e',
        '$xelatex=q/xelatex -no-shell-escape %O %S/',
        '-e',
        '$lualatex=q/lualatex -no-shell-escape %O %S/',
        input.mainPath,
      ];
      const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let log = '';
      const append = (chunk: Buffer) => {
        if (log.length < 10_000_000) log += chunk.toString('utf8');
      };
      child.stdout.on('data', append);
      child.stderr.on('data', append);
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        void killContainer(containerName);
      }, this.config.COMPILE_TIMEOUT_MS);
      const cancelPoll = setInterval(() => {
        void input.isCancelled().then(async (cancelled) => {
          if (cancelled) await killContainer(containerName);
        });
      }, 500);
      const exitCode = await new Promise<number>((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code) => resolve(code ?? 1));
      });
      clearTimeout(timeout);
      clearInterval(cancelPoll);
      const pdf = await readFile(join(workspace, '.build', 'document.pdf')).catch(() => null);
      const synctex = await readFile(join(workspace, '.build', 'document.synctex.gz')).catch(
        () => null,
      );
      return {
        exitCode,
        log: timedOut ? `${log}\nCompilation exceeded the time limit.` : log,
        pdf,
        synctex,
        durationMs: Date.now() - started,
        timedOut,
      };
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
