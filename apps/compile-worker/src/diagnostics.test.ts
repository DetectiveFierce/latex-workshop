import { describe, expect, it } from 'vitest';
import { parseLatexDiagnostics } from './diagnostics.js';

describe('LaTeX log diagnostics', () => {
  it('parses file-line errors', () => {
    expect(parseLatexDiagnostics('./main.tex:12: Undefined control sequence.')).toEqual([
      {
        severity: 'error',
        file: 'main.tex',
        line: 12,
        column: null,
        message: 'Undefined control sequence.',
        source: 'latex',
      },
    ]);
  });
  it('parses warnings', () =>
    expect(
      parseLatexDiagnostics('LaTeX Warning: Reference `x` undefined on input line 8.')[0]?.severity,
    ).toBe('warning'));
});
