import { describe, expect, it } from 'vitest';
import { pdfPageRenderDockerArgs } from './pdf-page-renderer.js';

describe('PDF page renderer isolation', () => {
  it('passes only validated page numbers into a bounded, networkless container', () => {
    const args = pdfPageRenderDockerArgs(
      { COMPILE_IMAGE: 'texlive@sha256:abc' },
      '/tmp/render-id',
      'latex-workshop-pdf-id',
      [2, 5],
      10001,
      10001,
    );

    expect(args).toContain('none');
    expect(args).toContain('ALL');
    expect(args).toContain('no-new-privileges');
    expect(args).toContain('512m');
    expect(args).toContain('-sPageList=2,5');
    expect(args.at(-1)).toBe('/workspace/document.pdf');
  });
});
