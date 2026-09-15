import { describe, expect, it } from 'vitest';
import type { PdfSyncResult } from '@latex-workshop/contracts';
import {
  currentPdfSyncResult,
  shouldRefreshPdfSync,
  type CompilationPdfSyncResult,
} from './pdfSyncState';

const result: PdfSyncResult = {
  point: { page: 1, x: 10, y: 20 },
  rect: { page: 1, x: 10, y: 20, width: 30, height: 12 },
  path: 'template.tex',
  line: 4,
  column: 1,
  matchKind: 'text',
  confidence: 'approximate',
  artifactStale: true,
  sourceFileChangedSinceCompile: true,
  selectedText: 'title',
};

describe('currentPdfSyncResult', () => {
  const sync: CompilationPdfSyncResult = { compilationId: 'compile-1', result };

  it('keeps a forward-search result on the PDF that produced it', () => {
    expect(currentPdfSyncResult(sync, 'compile-1')).toBe(result);
  });

  it('drops an older PDF result when a successful recompile replaces the preview', () => {
    expect(currentPdfSyncResult(sync, 'compile-2')).toBeNull();
  });

  it('does not expose a result without an active compilation', () => {
    expect(currentPdfSyncResult(sync, null)).toBeNull();
  });

  it('requests a fresh mapping when the displayed PDF changes', () => {
    expect(shouldRefreshPdfSync(sync, 'compile-1')).toBe(false);
    expect(shouldRefreshPdfSync(sync, 'compile-2')).toBe(true);
    expect(shouldRefreshPdfSync(null, 'compile-2')).toBe(false);
  });
});
