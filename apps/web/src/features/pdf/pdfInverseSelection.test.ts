import { describe, expect, it } from 'vitest';
import { clientPointToSync } from './pdfInverseSelection.js';

describe('PDF selection coordinates', () => {
  const view = {
    div: {
      getBoundingClientRect: () => ({
        x: 20,
        y: 30,
        left: 20,
        top: 30,
        right: 428,
        bottom: 558,
        width: 408,
        height: 528,
        toJSON: () => ({}),
      }),
    },
    viewport: {
      viewBox: [0, 0, 612, 792],
      width: 816,
      height: 1056,
      convertToViewportPoint: (x: number, y: number) => [(x * 4) / 3, ((792 - y) * 4) / 3],
      convertToPdfPoint: (x: number, y: number) => [(x * 3) / 4, 792 - (y * 3) / 4],
    },
  };

  it('accounts for CSS scaling and page offsets before inverse search', () => {
    expect(clientPointToSync(84, 68, 78, view)).toEqual({ page: 84, x: 72, y: 72 });
  });

  it('ignores uninitialized or malformed page positions', () => {
    expect(clientPointToSync(0, 68, 78, view)).toBeNull();
    const hidden = {
      ...view,
      div: { getBoundingClientRect: () => ({ ...view.div.getBoundingClientRect(), width: 0 }) },
    };
    expect(clientPointToSync(1, 68, 78, hidden)).toBeNull();
  });
});
