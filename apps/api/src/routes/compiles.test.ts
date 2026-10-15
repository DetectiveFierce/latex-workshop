import { describe, expect, it } from 'vitest';
import { pdfAttachmentDisposition } from './compiles.js';

describe('PDF downloads', () => {
  it('uses the project name as the PDF filename', () => {
    expect(pdfAttachmentDisposition('Research Notes')).toBe(
      `attachment; filename="Research Notes.pdf"; filename*=UTF-8''Research%20Notes.pdf`,
    );
  });

  it('preserves Unicode names without allowing header injection', () => {
    expect(pdfAttachmentDisposition('Résumé "final"\r\nInjected')).toBe(
      `attachment; filename="Resume _final___Injected.pdf"; filename*=UTF-8''R%C3%A9sum%C3%A9%20%22final%22%0D%0AInjected.pdf`,
    );
  });
});
