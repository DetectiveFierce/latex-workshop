import { useEffect, useRef, useState } from 'react';
import { FileCode2 } from 'lucide-react';
import {
  loadThumbnail,
  peekThumbnail,
  saveThumbnail,
  type VisibleThumbnail,
} from '../lib/thumbnailCache';
import { renderThumbnail } from '../lib/thumbnailRenderer';

/** A cached preview slightly under the card's resolution still looks sharp and saves a render. */
const ACCEPTABLE_SCALE = 0.75;

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
  const [thumbnail, setThumbnail] = useState<VisibleThumbnail | null>(() =>
    peekThumbnail(projectId),
  );
  const [visible, setVisible] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
    let cancelled = false;
    setThumbnail(peekThumbnail(projectId));
    void loadThumbnail(projectId).then((cached) => {
      if (!cancelled && cached) setThumbnail(cached);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

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

  const shown = thumbnail?.jobId ?? null;
  const shownWidth = thumbnail?.width ?? 0;
  useEffect(() => {
    const host = hostRef.current;
    if (!visible || !jobId || !host) return;
    const cssWidth = Math.max(240, host.clientWidth);
    const pixelWidth = Math.round(cssWidth * Math.min(window.devicePixelRatio || 1, 2));
    if (shown === jobId && shownWidth >= pixelWidth * ACCEPTABLE_SCALE) return;
    // The stored preview stays on screen until its replacement is ready.
    let cancelled = false;
    const background = getComputedStyle(host).getPropertyValue('--hon-paper').trim();
    void (async () => {
      const cached = await loadThumbnail(projectId);
      if (cancelled) return;
      if (cached?.jobId === jobId && cached.width >= pixelWidth * ACCEPTABLE_SCALE) {
        setThumbnail(cached);
        return;
      }
      const rendered = await renderThumbnail(
        projectId,
        jobId,
        pixelWidth,
        background,
        () => !cancelled,
      );
      if (cancelled || !rendered) return;
      setThumbnail(await saveThumbnail(projectId, jobId, rendered.blob, rendered.width));
    })().catch((error: unknown) => {
      if (!cancelled) {
        console.warn('Could not render project preview', error);
        setFailed(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [jobId, projectId, shown, shownWidth, visible]);

  const loaded = Boolean(thumbnail);
  return (
    <div ref={hostRef} className={`project-thumbnail${loaded ? ' loaded' : ''}`}>
      <div className="project-thumbnail-placeholder">
        <FileCode2 size={32} />
        <span>
          {failed
            ? 'Preview unavailable · refresh to retry'
            : jobId
              ? 'Loading preview…'
              : 'Preview pending'}
        </span>
      </div>
      {thumbnail && <img src={thumbnail.url} alt="" draggable={false} />}
    </div>
  );
}
