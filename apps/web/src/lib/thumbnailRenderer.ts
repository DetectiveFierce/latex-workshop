import type { PDFWorker } from 'pdfjs-dist';
import { appPath } from './api';

const MAX_CONCURRENT = 3;
let active = 0;
const waiting: (() => void)[] = [];
let sharedWorker: Promise<PDFWorker> | null = null;

async function loadPdfJs() {
  const [pdfjs, worker] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  return pdfjs;
}

/** One worker for all previews: starting a worker per PDF was most of the wait. */
function pdfWorker(pdfjs: typeof import('pdfjs-dist')) {
  sharedWorker ??= Promise.resolve(new pdfjs.PDFWorker());
  return sharedWorker;
}

async function withSlot<T>(task: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiting.push(resolve));
  active++;
  try {
    return await task();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Could not encode the preview'))),
      'image/webp',
      0.86,
    ),
  );
}

/** Render a compile's first page off-screen; `isCurrent` lets queued work for old jobs drop out. */
export function renderThumbnail(
  projectId: string,
  jobId: string,
  pixelWidth: number,
  background: string,
  isCurrent: () => boolean,
): Promise<{ blob: Blob; width: number } | null> {
  return withSlot(async () => {
    if (!isCurrent()) return null;
    const pdfjs = await loadPdfJs();
    const loadingTask = pdfjs.getDocument({
      url: appPath(`/api/v1/projects/${projectId}/compilations/${jobId}/pdf`),
      withCredentials: true,
      worker: await pdfWorker(pdfjs),
    });
    try {
      const document = await loadingTask.promise;
      const page = await document.getPage(1);
      const viewport = page.getViewport({
        scale: pixelWidth / page.getViewport({ scale: 1 }).width,
      });
      const canvas = window.document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) return null;
      await page.render({ canvas, canvasContext: context, viewport, background }).promise;
      return { blob: await canvasToBlob(canvas), width: canvas.width };
    } finally {
      await loadingTask.destroy();
    }
  });
}
