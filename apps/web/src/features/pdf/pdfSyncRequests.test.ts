import { describe, expect, it } from 'vitest';
import { PdfSyncRequests } from './pdfSyncRequests.js';

describe('PDF navigation requests', () => {
  it('cancels an earlier lookup so its late response cannot replace the newer selection', () => {
    const requests = new PdfSyncRequests();
    const old = requests.start('build');
    const next = requests.start('build');
    expect(old.controller.signal.aborted).toBe(true);
    expect(requests.isCurrent(old, 'build')).toBe(false);
    expect(requests.isCurrent(next, 'build')).toBe(true);
  });

  it('rejects locations from a replaced compilation and from an unmounted workspace', () => {
    const requests = new PdfSyncRequests();
    const request = requests.start('old-build');
    expect(requests.isCurrent(request, 'new-build')).toBe(false);
    requests.cancel();
    expect(requests.isCurrent(request, 'old-build')).toBe(false);
  });
});
