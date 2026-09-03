import type { PdfSyncResult } from '@latex-workshop/contracts';
import { syncRectToViewport, type PdfJsViewport } from './pdfCoordinates';

type HighlightPageView = {
  div: HTMLDivElement;
  viewport: PdfJsViewport;
};

type HighlightViewer = {
  currentPageNumber: number;
  pagesCount: number;
  eventBus: { dispatch(name: string, detail: Record<string, unknown>): void };
  getPageView(index: number): HighlightPageView | undefined;
};

export class PdfHighlightManager {
  private marker: HTMLDivElement | null = null;
  private markerTimer: number | null = null;
  private sourceResult: PdfSyncResult | null = null;

  constructor(
    private container: HTMLElement,
    private viewer: HighlightViewer,
  ) {}

  showSource(result: PdfSyncResult) {
    this.removeSourceMarker();
    this.sourceResult = result;
    this.refreshSource();
  }

  refreshSource() {
    const result = this.sourceResult;
    if (!result) return;
    this.removeSourceMarker();
    const pageView = this.viewer.getPageView(result.rect.page - 1);
    if (!pageView?.div || !pageView.viewport) {
      // PDF.js can receive a SyncTeX result before it has initialized its page
      // views. Setting currentPageNumber during that window throws in Firefox.
      // Keep the result pending; pagesinit/pagerendered will call us again.
      if (
        this.viewer.pagesCount >= result.rect.page &&
        this.viewer.currentPageNumber !== result.rect.page
      )
        this.viewer.currentPageNumber = result.rect.page;
      return;
    }
    const position = syncRectToViewport(result.rect, pageView.viewport);
    const marker = document.createElement('div');
    marker.className = `synctex-highlight synctex-highlight-${result.confidence}`;
    marker.style.left = `${position.left}px`;
    marker.style.top = `${position.top}px`;
    marker.style.width = `${Math.max(4, position.width)}px`;
    marker.style.height = `${Math.max(4, position.height)}px`;
    pageView.div.append(marker);
    marker.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    this.marker = marker;
    this.markerTimer = window.setTimeout(() => this.clearSource(), 3_200);
  }

  find(query: string, previous = false, type = 'again') {
    if (!query) return this.clearFind();
    this.viewer.eventBus.dispatch('find', {
      source: window,
      type,
      query,
      phraseSearch: true,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious: previous,
      matchDiacritics: false,
    });
  }

  clearFind() {
    this.viewer.eventBus.dispatch('findbarclose', { source: window });
  }

  clearSource() {
    this.sourceResult = null;
    this.removeSourceMarker();
  }

  private removeSourceMarker() {
    if (this.markerTimer !== null) window.clearTimeout(this.markerTimer);
    this.markerTimer = null;
    this.marker?.remove();
    this.marker = null;
    this.container.querySelectorAll('.synctex-highlight').forEach((node) => node.remove());
  }

  dispose() {
    this.clearSource();
    this.clearFind();
  }
}
