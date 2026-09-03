import { describe, expect, it } from 'vitest';
import { diagnosticSchema } from '@latex-workshop/contracts';
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

describe('parseLatexDiagnostics fuzzing', () => {
  it('always returns bounded diagnostics that satisfy the shared contract', () => {
    let state = 0xbadc0de;
    const random = () => {
      state = (Math.imul(state, 22_695_477) + 1) >>> 0;
      return state;
    };
    const tokens = ['!', ':', '.', '/', '\n', '\r', 'Warning', 'l.', 'tex', '9', 'λ', '\0'];

    for (let run = 0; run < 2_000; run += 1) {
      const log = Array.from(
        { length: random() % 500 },
        () => tokens[random() % tokens.length]!,
      ).join('');
      const diagnostics = parseLatexDiagnostics(log);
      expect(diagnostics.length).toBeLessThanOrEqual(500);
      for (const diagnostic of diagnostics) {
        expect(diagnosticSchema.safeParse(diagnostic).success).toBe(true);
      }
    }
  });

  it('does not emit unsafe numeric line values', () => {
    const [diagnostic] = parseLatexDiagnostics(`main.tex:${'9'.repeat(1_000)}: failure`);
    expect(diagnostic?.line).toBeNull();
  });
});
