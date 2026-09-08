import { describe, expect, it } from 'vitest';
import { capturePdfViewport, parsePdfViewportState, restorePdfViewport } from './pdfViewportState';

describe('PDF viewport state', () => {
  it('restores the same offset within the visible page after page positions change', () => {
    const container = { scrollLeft: 72, scrollTop: 1_340 };
    const oldViewer = viewer(2, 3, 'page-width', [20, 1_100, 2_180]);
    const state = capturePdfViewport(container, oldViewer);

    const newViewer = viewer(1, 3, 'auto', [20, 1_240, 2_460]);
    restorePdfViewport(container, newViewer, state);

    expect(newViewer.currentPageNumber).toBe(2);
    expect(newViewer.currentScaleValue).toBe('page-width');
    expect(container).toEqual({ scrollLeft: 72, scrollTop: 1_480 });
  });

  it('accepts legacy page and scale state with a top-of-page anchor', () => {
    expect(parsePdfViewportState({ page: 4, scale: 'page-fit' })).toEqual({
      page: 4,
      scale: 'page-fit',
      anchor: { kind: 'page', x: 0, y: 0 },
    });
  });

  it('rejects malformed persisted offsets', () => {
    expect(
      parsePdfViewportState({
        page: 2,
        scale: 'page-width',
        anchor: { kind: 'page', x: 0, y: Number.NaN },
      }),
    ).toBeNull();
  });
});

function viewer(page: number, pages: number, scale: string, pageTops: number[]) {
  return {
    currentPageNumber: page,
    currentScaleValue: scale,
    pagesCount: pages,
    getPageView(index: number) {
      const offsetTop = pageTops[index];
      return offsetTop === undefined ? undefined : { div: { offsetLeft: 24, offsetTop } };
    },
  };
}
