import type { PdfPoint } from '@latex-workshop/contracts';
import { viewportPointToSync, type PdfJsViewport } from './pdfCoordinates.js';

type PageView = {
  div: Pick<HTMLElement, 'getBoundingClientRect'>;
  viewport: PdfJsViewport & { width: number; height: number };
};
export type PdfInverseLocation = PdfPoint & {
  text?: string;
  before?: string;
  after?: string;
  points?: PdfPoint[];
};

export function clientPointToSync(
  page: number,
  x: number,
  y: number,
  view: PageView,
): PdfPoint | null {
  const bounds = view.div.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0 || !Number.isSafeInteger(page) || page < 1)
    return null;
  return viewportPointToSync(
    page,
    ((x - bounds.left) * view.viewport.width) / bounds.width,
    ((y - bounds.top) * view.viewport.height) / bounds.height,
    view.viewport,
  );
}

function textLayer(node: Node | null): HTMLElement | null {
  const element = node instanceof Element ? node : node?.parentElement;
  const layer = element?.closest('.textLayer');
  return layer instanceof HTMLElement ? layer : null;
}

export function pdfSelectionLocation(
  selection: Selection | null,
  container: HTMLElement,
  getPage: (index: number) => PageView | undefined,
): PdfInverseLocation | null {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const startLayer = textLayer(selection.anchorNode);
  const endLayer = textLayer(selection.focusNode);
  if (!startLayer || !endLayer || !container.contains(startLayer) || !container.contains(endLayer))
    return null;
  const range = selection.getRangeAt(0);
  const firstLayer = textLayer(range.startContainer);
  const pageElement = firstLayer?.closest('.page');
  if (!(pageElement instanceof HTMLElement) || !firstLayer) return null;
  const page = Number(pageElement.dataset.pageNumber);
  const view = getPage(page - 1);
  if (!view) return null;
  const bounds = view.div.getBoundingClientRect();
  const points: PdfPoint[] = [];
  // Range order is document order even when the user drags backwards. Avoid the
  // bounding-box midpoint, which can land in a margin or on a different column.
  for (const rect of range.getClientRects()) {
    if (points.length >= 6) break;
    if (
      rect.width < 1 ||
      rect.height < 1 ||
      rect.top < bounds.top ||
      rect.bottom > bounds.bottom + 1
    )
      continue;
    const x = Math.max(bounds.left, rect.left) + Math.min(rect.width / 2, 4);
    const y = rect.top + rect.height / 2;
    const point = clientPointToSync(page, x, y, view);
    if (
      point &&
      !points.some((old) => Math.abs(old.y - point.y) < 2 && Math.abs(old.x - point.x) < 2)
    )
      points.push(point);
  }
  const point = points[0];
  const text = range.toString().trim().slice(0, 2_000);
  if (!point || !text) return null;
  const before = document.createRange();
  before.selectNodeContents(firstLayer);
  before.setEnd(range.startContainer, range.startOffset);
  const lastLayer = textLayer(range.endContainer);
  if (!lastLayer) return null;
  const after = document.createRange();
  after.selectNodeContents(lastLayer);
  after.setStart(range.endContainer, range.endOffset);
  return {
    ...point,
    points: points.slice(1),
    text,
    before: before.toString().slice(-200),
    after: after.toString().slice(0, 200),
  };
}
