import type { PdfSyncResult } from '@latex-workshop/contracts';

export type CompilationPdfSyncResult = {
  compilationId: string;
  result: PdfSyncResult;
};

export function currentPdfSyncResult(
  value: CompilationPdfSyncResult | null,
  compilationId: string | null,
): PdfSyncResult | null {
  return value?.compilationId === compilationId ? value.result : null;
}
