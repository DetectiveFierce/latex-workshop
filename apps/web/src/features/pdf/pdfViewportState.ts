export type PdfViewportState = {
  page: number;
  scale: string;
  anchor: { kind: 'page'; x: number; y: number } | { kind: 'document'; left: number; top: number };
};

type ScrollContainer = Pick<HTMLElement, 'scrollLeft' | 'scrollTop'>;

type PositionedPage = {
  div: Pick<HTMLElement, 'offsetLeft' | 'offsetTop'>;
};

type PositionedViewer = {
  currentPageNumber: number;
  currentScaleValue: string;
  pagesCount: number;
  getPageView(index: number): PositionedPage | undefined;
};

export function capturePdfViewport(
  container: ScrollContainer,
  viewer: PositionedViewer,
): PdfViewportState {
  const page = Math.min(Math.max(1, viewer.currentPageNumber), Math.max(1, viewer.pagesCount));
  const pageView = viewer.getPageView(page - 1);
  return {
    page,
    scale: viewer.currentScaleValue,
    anchor: pageView
      ? {
          kind: 'page',
          x: container.scrollLeft - pageView.div.offsetLeft,
          y: container.scrollTop - pageView.div.offsetTop,
        }
      : { kind: 'document', left: container.scrollLeft, top: container.scrollTop },
  };
}

export function restorePdfViewport(
  container: ScrollContainer,
  viewer: PositionedViewer,
  state: PdfViewportState,
) {
  viewer.currentScaleValue = state.scale;
  viewer.currentPageNumber = Math.min(state.page, Math.max(1, viewer.pagesCount));

  if (state.anchor.kind === 'document') {
    container.scrollLeft = state.anchor.left;
    container.scrollTop = state.anchor.top;
    return;
  }

  const pageView = viewer.getPageView(viewer.currentPageNumber - 1);
  container.scrollLeft = (pageView?.div.offsetLeft ?? 0) + state.anchor.x;
  container.scrollTop = (pageView?.div.offsetTop ?? 0) + state.anchor.y;
}

export function parsePdfViewportState(value: unknown): PdfViewportState | null {
  if (!isRecord(value)) return null;
  if (
    !Number.isInteger(value.page) ||
    typeof value.page !== 'number' ||
    value.page <= 0 ||
    typeof value.scale !== 'string' ||
    value.scale.length > 40
  ) {
    return null;
  }

  const anchor = parseAnchor(value.anchor);
  if (value.anchor !== undefined && !anchor) return null;
  return {
    page: value.page,
    scale: value.scale,
    anchor: anchor ?? { kind: 'page', x: 0, y: 0 },
  };
}

function parseAnchor(value: unknown): PdfViewportState['anchor'] | null {
  if (!isRecord(value) || typeof value.kind !== 'string') return null;
  if (value.kind === 'page' && isFiniteNumber(value.x) && isFiniteNumber(value.y)) {
    return { kind: 'page', x: value.x, y: value.y };
  }
  if (value.kind === 'document' && isFiniteNumber(value.left) && isFiniteNumber(value.top)) {
    return { kind: 'document', left: value.left, top: value.top };
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
