import { useEffect, useRef, useState } from 'react';
import { FileCode2 } from 'lucide-react';
import { appPath } from '../lib/api';

export function ProjectThumbnail({
  projectId,
  jobId,
  generate = 0,
}: {
  projectId: string;
  jobId: string | null;
  generate?: number;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => setLoaded(false), [jobId]);

  useEffect(() => {
    if (jobId && generate > 0) setVisible(true);
  }, [generate, jobId]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !jobId) return;
    const observer = new IntersectionObserver(
      ([entry]) => entry?.isIntersecting && setVisible(true),
      { rootMargin: '180px' },
    );
    observer.observe(host);
    return () => observer.disconnect();
  }, [jobId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!visible || !jobId || !canvas) return;
    let cancelled = false;
    let destroy: (() => Promise<void>) | undefined;
    void (async () => {
      const [pdfjs, worker] = await Promise.all([
        import('pdfjs-dist'),
        import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
      ]);
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      const loadingTask = pdfjs.getDocument({
        url: appPath(`/api/v1/projects/${projectId}/compilations/${jobId}/pdf`),
        withCredentials: true,
      });
      destroy = () => loadingTask.destroy();
      const document = await loadingTask.promise;
      const page = await document.getPage(1);
      if (cancelled) return;
      const base = page.getViewport({ scale: 1 });
      const cssWidth = Math.max(240, hostRef.current?.clientWidth ?? 320);
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = page.getViewport({ scale: (cssWidth / base.width) * pixelRatio });
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) return;
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({ canvas, canvasContext: context, viewport }).promise;
      if (!cancelled) setLoaded(true);
      await document.cleanup();
    })().catch(() => {
      if (!cancelled) setLoaded(false);
    });
    return () => {
      cancelled = true;
      void destroy?.();
    };
  }, [jobId, projectId, visible]);

  return (
    <div ref={hostRef} className={`project-thumbnail${loaded ? ' loaded' : ''}`}>
      <div className="project-thumbnail-placeholder">
        <FileCode2 size={32} />
        <span>{jobId ? 'Loading preview…' : 'Compile to create a preview'}</span>
      </div>
      {jobId && <canvas ref={canvasRef} aria-hidden="true" />}
    </div>
  );
}
