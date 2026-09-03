import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { syncRectToViewport, viewportPointToSync } from './pdfCoordinates';

describe('PDF coordinate conversion', () => {
  it('converts 72dpi top-left points through the viewport scale', () => {
    const viewport = {
      viewBox: [0, 0, 612, 792],
      convertToViewportPoint: (x: number, y: number) => [x * (4 / 3), (792 - y) * (4 / 3)],
      convertToPdfPoint: (x: number, y: number) => [x / (4 / 3), 792 - y / (4 / 3)],
    };
    expect(syncRectToViewport({ page: 1, x: 72, y: 72, width: 144, height: 18 }, viewport)).toEqual(
      { left: 96, top: 96, width: 192, height: 24 },
    );
    expect(viewportPointToSync(1, 96, 96, viewport)).toEqual({ page: 1, x: 72, y: 72 });
  });

  it('normalizes transformed corner order for rotated pages', () => {
    const viewport = {
      viewBox: [10, 20, 210, 320],
      convertToViewportPoint: (x: number, y: number) => [320 - y, x - 10],
      convertToPdfPoint: (x: number, y: number) => [y + 10, 320 - x],
    };
    expect(syncRectToViewport({ page: 2, x: 20, y: 30, width: 40, height: 10 }, viewport)).toEqual({
      left: 30,
      top: 20,
      width: 10,
      height: 40,
    });
  });

  it.each([0, 90, 180, 270] as const)(
    'round-trips crop-box points at multiple scales for %i° rotation',
    (rotation) => {
      for (const scale of [0.5, 1, 4 / 3, 2]) {
        const viewport = mockViewport([10, 20, 210, 320], scale, rotation);
        const pdfPoint = { page: 3, x: 37, y: 81 };
        const absoluteX = 10 + pdfPoint.x;
        const absoluteY = 320 - pdfPoint.y;
        const [x, y] = viewport.convertToViewportPoint(absoluteX, absoluteY);
        const roundTrip = viewportPointToSync(3, x!, y!, viewport);
        expect(roundTrip.x).toBeCloseTo(pdfPoint.x, 8);
        expect(roundTrip.y).toBeCloseTo(pdfPoint.y, 8);
        const rect = syncRectToViewport({ ...pdfPoint, width: 42, height: 17 }, viewport);
        expect(rect.width).toBeGreaterThan(0);
        expect(rect.height).toBeGreaterThan(0);
      }
    },
  );

  it('round-trips the committed crop-box fixture through real PDF.js viewports', async () => {
    const bytes = readFileSync(new URL('./fixtures/synchronization.pdf', import.meta.url));
    const loadingTask = getDocument({ data: new Uint8Array(bytes) });
    const document = await loadingTask.promise;
    expect(document.numPages).toBe(4);
    const cropped = await document.getPage(2);
    const rotated = await document.getPage(3);
    expect(cropped.view).toEqual([18, 24, 594, 768]);
    expect(rotated.rotate).toBe(90);

    for (const rotation of [0, 90, 180, 270]) {
      for (const scale of [0.5, 1, 4 / 3, 2]) {
        const viewport = cropped.getViewport({ scale, rotation });
        const point = { page: 2, x: 72, y: 96 };
        const [x, y] = viewport.convertToViewportPoint(
          viewport.viewBox[0]! + point.x,
          viewport.viewBox[3]! - point.y,
        );
        const roundTrip = viewportPointToSync(point.page, x, y, viewport);
        expect(roundTrip.x).toBeCloseTo(point.x, 6);
        expect(roundTrip.y).toBeCloseTo(point.y, 6);
        const rect = syncRectToViewport({ ...point, width: 120, height: 18 }, viewport);
        expect(rect.width).toBeGreaterThan(0);
        expect(rect.height).toBeGreaterThan(0);
      }
    }
    await loadingTask.destroy();
  });
});

function mockViewport(
  viewBox: [number, number, number, number],
  scale: number,
  rotation: 0 | 90 | 180 | 270,
) {
  const [x0, y0, x1, y1] = viewBox;
  const forward = (x: number, y: number) => {
    if (rotation === 0) return [(x - x0) * scale, (y1 - y) * scale];
    if (rotation === 90) return [(y - y0) * scale, (x - x0) * scale];
    if (rotation === 180) return [(x1 - x) * scale, (y - y0) * scale];
    return [(y1 - y) * scale, (x1 - x) * scale];
  };
  const inverse = (x: number, y: number) => {
    if (rotation === 0) return [x / scale + x0, y1 - y / scale];
    if (rotation === 90) return [y / scale + x0, x / scale + y0];
    if (rotation === 180) return [x1 - x / scale, y / scale + y0];
    return [x1 - y / scale, y1 - x / scale];
  };
  return { viewBox, convertToViewportPoint: forward, convertToPdfPoint: inverse };
}
