import { describe, expect, it } from 'vitest';
import { projectDocumentTitle } from './document-title.js';

describe('projectDocumentTitle', () => {
  it('labels single-purpose editor and PDF tabs', () => {
    expect(projectDocumentTitle('Homework', 'editor')).toBe('Editor - Homework - Latex Workshop');
    expect(projectDocumentTitle('Homework', 'pdf')).toBe('PDF - Homework - Latex Workshop');
  });

  it('omits the view label when editor and PDF are combined', () => {
    expect(projectDocumentTitle('Homework', 'combined')).toBe('Homework - Latex Workshop');
  });
});
