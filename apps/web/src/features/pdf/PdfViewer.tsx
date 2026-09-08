import { useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Download,
  Expand,
  ExternalLink,
  FileSearch,
  LayoutList,
  ListTree,
  PanelLeft,
  Printer,
  Scan,
  Search,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { PdfSyncResult } from '@latex-workshop/contracts';
import * as pdfjs from 'pdfjs-dist';
import {
  EventBus,
  PDFFindController,
  PDFLinkService,
  PDFViewer as PdfJsViewer,
  ScrollMode,
} from 'pdfjs-dist/web/pdf_viewer.mjs';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import { IconButton } from '../../components/Button';
import { viewportPointToSync } from './pdfCoordinates';
import { PdfHighlightManager } from './pdfHighlightManager';
import {
  capturePdfViewport,
  parsePdfViewportState,
  restorePdfViewport,
  type PdfViewportState,
} from './pdfViewportState';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

type OutlineItem =
  Awaited<ReturnType<pdfjs.PDFDocumentProxy['getOutline']>> extends Array<infer Item> | null
    ? Item
    : never;

export function PdfViewer({
  url,
  downloadUrl,
  openUrl,
  storageKey,
  forwardLocation,
  onInverse,
  onCollapse,
  onOpenExternal,
  onPageChange,
}: {
  url: string;
  downloadUrl?: string;
  openUrl?: string;
  storageKey?: string;
  forwardLocation?: PdfSyncResult | null;
  onInverse?: (page: number, x: number, y: number) => void;
  onCollapse?: () => void;
  onOpenExternal?: () => void;
  onPageChange?: (page: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<PdfJsViewer | null>(null);
  const linkServiceRef = useRef<PDFLinkService | null>(null);
  const highlightManagerRef = useRef<PdfHighlightManager | null>(null);
  const activeTaskRef = useRef<pdfjs.PDFDocumentLoadingTask | null>(null);
  const pendingViewportRef = useRef<PdfViewportState | null>(null);
  const restoreFrameRef = useRef<number | null>(null);
  const suppressPersistenceRef = useRef(true);
  const storageKeyRef = useRef(storageKey);
  const onPageChangeRef = useRef(onPageChange);
  const [documentProxy, setDocumentProxy] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [sidebar, setSidebar] = useState<'thumbnails' | 'outline' | null>(null);
  const [pages, setPages] = useState(0);
  const [page, setPage] = useState(1);
  const [scale, setScale] = useState(1);
  const [query, setQuery] = useState('');
  const [continuous, setContinuous] = useState(true);
  const [error, setError] = useState('');
  const [findState, setFindState] = useState<'idle' | 'pending' | 'found' | 'not-found'>('idle');
  const [findCount, setFindCount] = useState({ current: 0, total: 0 });
  const [renderVersion, setRenderVersion] = useState(0);

  storageKeyRef.current = storageKey;
  onPageChangeRef.current = onPageChange;

  useEffect(() => {
    const container = containerRef.current;
    const viewerElement = viewerRef.current;
    if (!container || !viewerElement) return;

    let cancelled = false;
    const eventBus = new EventBus();
    const linkService = new PDFLinkService({ eventBus });
    const findController = new PDFFindController({ eventBus, linkService });
    const viewer = new PdfJsViewer({
      container,
      viewer: viewerElement,
      eventBus,
      linkService,
      findController,
      textLayerMode: 1,
      annotationMode: 2,
      enableSelectionRendering: false,
      // Keep the page viewport, canvas, text layer, and annotation layer on one coordinate plane.
      // PDF.js's decorative page border otherwise participates in its fit calculations while the
      // app's global border-box reset changes which dimensions are available to child layers.
      removePageBorders: true,
    });
    instanceRef.current = viewer;
    highlightManagerRef.current = new PdfHighlightManager(container, viewer);
    linkServiceRef.current = linkService;
    linkService.setViewer(viewer);
    const resizeObserver = new ResizeObserver(() => setRenderVersion((value) => value + 1));
    resizeObserver.observe(container);
    viewerElement.style.visibility = 'hidden';
    let persistFrame: number | null = null;

    const persistViewport = () => {
      const key = storageKeyRef.current;
      if (suppressPersistenceRef.current || !key || viewer.pagesCount === 0) return;
      writePdfState(key, capturePdfViewport(container, viewer));
    };
    const schedulePersistViewport = () => {
      if (suppressPersistenceRef.current || persistFrame !== null) return;
      persistFrame = window.requestAnimationFrame(() => {
        persistFrame = null;
        persistViewport();
      });
    };

    eventBus.on('pagesinit', () => {
      if (cancelled) return;
      const saved = storageKeyRef.current ? readPdfState(storageKeyRef.current) : null;
      const viewport = pendingViewportRef.current ?? saved ?? defaultPdfViewport();
      restorePdfViewport(container, viewer, viewport);
      if (restoreFrameRef.current !== null) window.cancelAnimationFrame(restoreFrameRef.current);
      restoreFrameRef.current = window.requestAnimationFrame(() => {
        if (cancelled) return;
        restorePdfViewport(container, viewer, viewport);
        pendingViewportRef.current = null;
        suppressPersistenceRef.current = false;
        viewerElement.style.visibility = '';
        setScale(viewer.currentScale);
        setPage(viewer.currentPageNumber);
        onPageChangeRef.current?.(viewer.currentPageNumber);
        persistViewport();
        setRenderVersion((value) => value + 1);
      });
    });
    eventBus.on('pagechanging', ({ pageNumber }: { pageNumber: number }) => {
      if (cancelled) return;
      setPage(pageNumber);
      onPageChangeRef.current?.(pageNumber);
      schedulePersistViewport();
    });
    eventBus.on('scalechanging', ({ scale: next }: { scale: number }) => {
      if (cancelled) return;
      setScale(next);
      schedulePersistViewport();
      setRenderVersion((value) => value + 1);
    });
    container.addEventListener('scroll', schedulePersistViewport, { passive: true });
    eventBus.on('pagerendered', () => setRenderVersion((value) => value + 1));
    eventBus.on(
      'updatefindmatchescount',
      ({ matchesCount }: { matchesCount: { current: number; total: number } }) =>
        setFindCount(matchesCount),
    );
    eventBus.on('updatefindcontrolstate', ({ state }: { state: number }) => {
      setFindState(state === 1 ? 'not-found' : state === 3 ? 'pending' : 'found');
    });

    return () => {
      persistViewport();
      cancelled = true;
      container.removeEventListener('scroll', schedulePersistViewport);
      resizeObserver.disconnect();
      if (persistFrame !== null) window.cancelAnimationFrame(persistFrame);
      if (restoreFrameRef.current !== null) window.cancelAnimationFrame(restoreFrameRef.current);
      instanceRef.current = null;
      highlightManagerRef.current?.dispose();
      highlightManagerRef.current = null;
      linkServiceRef.current = null;
      // pdf.js accepts null at runtime to detach the current document.
      viewer.setDocument(null as unknown as pdfjs.PDFDocumentProxy);
      linkService.setDocument(null);
      void activeTaskRef.current?.destroy();
      activeTaskRef.current = null;
      viewer.cleanup();
    };
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    const viewerElement = viewerRef.current;
    const viewer = instanceRef.current;
    const linkService = linkServiceRef.current;
    if (!container || !viewerElement || !viewer || !linkService) return;

    let cancelled = false;
    const task = pdfjs.getDocument({ url, withCredentials: true });
    setError('');
    task.promise
      .then(async (document) => {
        if (cancelled) {
          void task.destroy();
          return;
        }

        if (viewer.pagesCount > 0) {
          pendingViewportRef.current = capturePdfViewport(container, viewer);
        }
        suppressPersistenceRef.current = true;
        viewerElement.style.visibility = 'hidden';
        const previousTask = activeTaskRef.current;
        activeTaskRef.current = task;
        viewer.setDocument(document);
        linkService.setDocument(document);
        setDocumentProxy(document);
        setPages(document.numPages);
        setError('');
        if (previousTask && previousTask !== task) void previousTask.destroy();

        const nextOutline = (await document.getOutline()) ?? [];
        if (!cancelled) setOutline(nextOutline);
      })
      .catch((cause) => {
        if (cancelled || isAbortError(cause)) return;
        viewerElement.style.visibility = '';
        setError(cause instanceof Error ? cause.message : 'Unable to load PDF');
      });

    return () => {
      cancelled = true;
      if (activeTaskRef.current !== task) void task.destroy();
    };
  }, [url]);

  useEffect(() => {
    const manager = highlightManagerRef.current;
    manager?.clearSource();
    if (forwardLocation) {
      window.getSelection()?.removeAllRanges();
      manager?.showSource(forwardLocation);
    }
    return () => manager?.clearSource();
  }, [forwardLocation]);
  useEffect(() => {
    highlightManagerRef.current?.refreshSource();
  }, [renderVersion]);

  const zoom = (factor: number) => {
    const viewer = instanceRef.current;
    if (viewer) viewer.currentScale = Math.min(4, Math.max(0.25, viewer.currentScale * factor));
  };
  const goToPage = (next: number) => {
    const viewer = instanceRef.current;
    if (viewer) viewer.currentPageNumber = Math.min(pages, Math.max(1, next));
  };
  const cycleFit = () => {
    const viewer = instanceRef.current;
    if (!viewer) return;
    const current = viewer.currentScaleValue;
    viewer.currentScaleValue =
      current === 'page-width' ? 'page-fit' : current === 'page-fit' ? 'auto' : 'page-width';
    setScale(viewer.currentScale);
  };
  const find = (previous = false, type = 'again') => {
    if (!query) {
      highlightManagerRef.current?.clearFind();
      setFindState('idle');
      setFindCount({ current: 0, total: 0 });
      return;
    }
    setFindState('pending');
    highlightManagerRef.current?.find(query, previous, type);
  };
  useEffect(() => {
    const timer = window.setTimeout(() => find(false, ''), 180);
    return () => window.clearTimeout(timer);
  }, [query, documentProxy]);
  const toggleMode = () => {
    const viewer = instanceRef.current;
    if (!viewer) return;
    const next = !continuous;
    setContinuous(next);
    viewer.scrollMode = next ? ScrollMode.VERTICAL : ScrollMode.PAGE;
  };
  const inverse = (event: React.MouseEvent) => {
    if (!(event.metaKey || event.ctrlKey) || !onInverse) return;
    const target = (event.target as HTMLElement).closest('.page') as HTMLElement | null;
    if (!target) return;
    const pageNumber = Number(target.dataset.pageNumber);
    const pageView = instanceRef.current?.getPageView(pageNumber - 1);
    if (!pageView?.viewport) return;
    const rect = pageView.div.getBoundingClientRect();
    const point = viewportPointToSync(
      pageNumber,
      event.clientX - rect.left,
      event.clientY - rect.top,
      pageView.viewport,
    );
    onInverse(point.page, point.x, point.y);
    window.requestAnimationFrame(() => window.getSelection()?.removeAllRanges());
  };

  return (
    <div className="pdf-viewer-shell">
      <div className="preview-toolbar">
        <IconButton
          label={sidebar ? 'Hide PDF sidebar' : 'Show PDF thumbnails'}
          onClick={() => setSidebar((current) => (current ? null : 'thumbnails'))}
        >
          <PanelLeft size={16} />
        </IconButton>
        <div className="pdf-page-controls">
          <IconButton label="Previous page" disabled={page <= 1} onClick={() => goToPage(page - 1)}>
            <ChevronLeft size={16} />
          </IconButton>
          <label className="pdf-page-input">
            <span className="sr-only">Page number</span>
            <input
              value={page}
              type="number"
              min={1}
              max={pages || 1}
              onChange={(event) => goToPage(Number(event.target.value))}
            />
          </label>
          <span className="badge pdf-page-total" aria-label={`of ${pages || 0} pages`}>
            {'/' + String.fromCharCode(0xa0) + (pages || '\u2014')}
          </span>
          <IconButton label="Next page" disabled={page >= pages} onClick={() => goToPage(page + 1)}>
            <ChevronRight size={16} />
          </IconButton>
        </div>
        <IconButton label="Zoom out" onClick={() => zoom(0.85)}>
          <ZoomOut size={16} />
        </IconButton>
        <span className="badge pdf-zoom-level">{Math.round(scale * 100)}%</span>
        <IconButton label="Zoom in" onClick={() => zoom(1.15)}>
          <ZoomIn size={16} />
        </IconButton>
        <IconButton label="Cycle page fit mode" onClick={cycleFit}>
          <Expand size={16} />
        </IconButton>
        <IconButton label={continuous ? 'Single page' : 'Continuous pages'} onClick={toggleMode}>
          {continuous ? <Scan size={16} /> : <LayoutList size={16} />}
        </IconButton>
        <span className="spacer" />
        <label className="searchbox">
          <Search size={14} />
          <input
            className="input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                find(event.shiftKey);
              }
              if (event.key === 'Escape') setQuery('');
            }}
            placeholder="Find"
          />
        </label>
        <IconButton label="Previous PDF match" disabled={!query} onClick={() => find(true)}>
          <ChevronUp size={16} />
        </IconButton>
        <IconButton label="Next PDF match" disabled={!query} onClick={() => find(false)}>
          <ChevronDown size={16} />
        </IconButton>
        {query && (
          <span className="badge pdf-find-count" role="status">
            {findState === 'pending'
              ? '…'
              : findState === 'not-found'
                ? 'No matches'
                : findCount.total
                  ? `${findCount.current}/${findCount.total}`
                  : '—'}
          </span>
        )}
        <IconButton label="Find in PDF" onClick={() => find(false, '')}>
          <FileSearch size={16} />
        </IconButton>
        <IconButton
          label="Print"
          onClick={() => {
            const frame = document.createElement('iframe');
            frame.style.display = 'none';
            frame.src = url;
            frame.onload = () => frame.contentWindow?.print();
            document.body.append(frame);
            setTimeout(() => frame.remove(), 60_000);
          }}
        >
          <Printer size={16} />
        </IconButton>
        <a
          className="icon-button"
          href={downloadUrl ?? url}
          download
          aria-label="Download PDF"
          title="Download PDF"
        >
          <Download size={16} />
        </a>
        {openUrl && (
          <a
            className="icon-button"
            href={openUrl}
            target="_blank"
            rel="noreferrer"
            aria-label="Open PDF in new tab"
            title="Open PDF in new tab"
            onClick={onOpenExternal}
            onAuxClick={onOpenExternal}
          >
            <ExternalLink size={16} />
          </a>
        )}
        <IconButton
          label="Fullscreen"
          onClick={() => void containerRef.current?.requestFullscreen()}
        >
          <Expand size={16} />
        </IconButton>
        {onCollapse && (
          <IconButton className="preview-collapse" label="Hide PDF preview" onClick={onCollapse}>
            <ChevronRight size={16} />
          </IconButton>
        )}
      </div>
      <div className={`pdf-stage ${sidebar ? 'sidebar-open' : ''}`}>
        {sidebar && (
          <aside className="pdf-sidebar" aria-label="PDF navigation">
            <div className="pdf-sidebar-tabs">
              <button
                className={sidebar === 'thumbnails' ? 'active' : ''}
                onClick={() => setSidebar('thumbnails')}
              >
                <PanelLeft size={14} /> Pages
              </button>
              <button
                className={sidebar === 'outline' ? 'active' : ''}
                onClick={() => setSidebar('outline')}
              >
                <ListTree size={14} /> Outline
              </button>
            </div>
            {sidebar === 'thumbnails' ? (
              <div className="pdf-thumbnails">
                {documentProxy &&
                  Array.from({ length: pages }, (_, index) => (
                    <PdfThumbnail
                      key={index}
                      document={documentProxy}
                      pageNumber={index + 1}
                      active={page === index + 1}
                      onSelect={goToPage}
                    />
                  ))}
              </div>
            ) : (
              <div className="pdf-outline">
                {outline.length ? (
                  <Outline
                    items={outline}
                    onSelect={(dest) => void linkServiceRef.current?.goToDestination(dest)}
                  />
                ) : (
                  <p className="hint">This document has no outline.</p>
                )}
              </div>
            )}
          </aside>
        )}
        <div
          className="pdf-container"
          ref={containerRef}
          tabIndex={0}
          onDoubleClick={inverse}
          onPointerDown={(event) => {
            if (!(event.metaKey || event.ctrlKey)) highlightManagerRef.current?.clearSource();
          }}
          aria-label="PDF document. Control or Command double-click for inverse search."
          hidden={Boolean(error)}
        >
          <div className="pdfViewer" ref={viewerRef} />
        </div>
        {error ? (
          <div className="pdf-empty">
            <h3>Unable to open PDF</h3>
            <p>{error}</p>
          </div>
        ) : null}
        {forwardLocation?.confidence === 'approximate' && (
          <div className="pdf-sync-status" role="status">
            Approximate match in an older PDF
          </div>
        )}
      </div>
    </div>
  );
}

function PdfThumbnail({
  document,
  pageNumber,
  active,
  onSelect,
}: {
  document: pdfjs.PDFDocumentProxy;
  pageNumber: number;
  active: boolean;
  onSelect: (page: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let cancelled = false;
    void document.getPage(pageNumber).then((pdfPage) => {
      if (cancelled || !canvasRef.current) return;
      const base = pdfPage.getViewport({ scale: 1 });
      const viewport = pdfPage.getViewport({ scale: 130 / base.width });
      const canvas = canvasRef.current;
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      void pdfPage.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise;
    });
    return () => {
      cancelled = true;
    };
  }, [document, pageNumber]);
  return (
    <button
      className={`pdf-thumbnail ${active ? 'active' : ''}`}
      onClick={() => onSelect(pageNumber)}
      aria-label={`Go to page ${pageNumber}`}
    >
      <canvas ref={canvasRef} />
      <span>{pageNumber}</span>
    </button>
  );
}

function Outline({
  items,
  onSelect,
}: {
  items: OutlineItem[];
  onSelect: (destination: string | unknown[]) => void;
}) {
  return (
    <ul>
      {items.map((item, index) => (
        <li key={`${item.title}-${index}`}>
          <button disabled={!item.dest} onClick={() => item.dest && onSelect(item.dest)}>
            {item.title}
          </button>
          {item.items?.length ? <Outline items={item.items} onSelect={onSelect} /> : null}
        </li>
      ))}
    </ul>
  );
}

function isAbortError(cause: unknown) {
  if (!cause || typeof cause !== 'object') return false;
  const error = cause as { name?: string; message?: string };
  return (
    error.name === 'AbortException' ||
    error.name === 'AbortError' ||
    /loading aborted|cancelled|canceled/i.test(error.message ?? '')
  );
}

function defaultPdfViewport(): PdfViewportState {
  return { page: 1, scale: 'page-width', anchor: { kind: 'page', x: 0, y: 0 } };
}

function readPdfState(key: string): PdfViewportState | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(`pdf-state:${key}`) ?? 'null');
    return parsePdfViewportState(value);
  } catch {
    return null;
  }
}

function writePdfState(key: string, value: PdfViewportState) {
  try {
    localStorage.setItem(`pdf-state:${key}`, JSON.stringify(value));
  } catch {
    // Storage can be unavailable or full; viewport preservation still works in memory.
  }
}
