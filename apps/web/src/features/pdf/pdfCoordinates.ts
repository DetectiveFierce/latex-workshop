import type { PdfRect } from '@latex-workshop/contracts';

export type PdfJsViewport = {
  viewBox: ArrayLike<number>;
  convertToViewportPoint(x: number, y: number): number[];
  convertToPdfPoint(x: number, y: number): number[];
};

export function syncRectToViewport(rect: PdfRect, viewport: PdfJsViewport) {
  const xMin = viewport.viewBox[0] ?? 0;
  const yMax = viewport.viewBox[3] ?? 0;
  const topLeft = viewport.convertToViewportPoint(xMin + rect.x, yMax - rect.y);
  const bottomRight = viewport.convertToViewportPoint(
    xMin + rect.x + rect.width,
    yMax - rect.y - rect.height,
  );
  return {
    left: Math.min(topLeft[0]!, bottomRight[0]!),
    top: Math.min(topLeft[1]!, bottomRight[1]!),
    width: Math.max(1, Math.abs(bottomRight[0]! - topLeft[0]!)),
    height: Math.max(1, Math.abs(bottomRight[1]! - topLeft[1]!)),
  };
}

export function viewportPointToSync(page: number, x: number, y: number, viewport: PdfJsViewport) {
  const xMin = viewport.viewBox[0] ?? 0;
  const yMax = viewport.viewBox[3] ?? 0;
  const point = viewport.convertToPdfPoint(x, y);
  return { page, x: Math.max(0, point[0]! - xMin), y: Math.max(0, yMax - point[1]!) };
}
