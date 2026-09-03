import type { Diagnostic } from '@latex-workshop/contracts';

export function parseLatexDiagnostics(log: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const seen = new Set<string>();
  const lines = log.replaceAll('\r\n', '\n').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const fileLine = line.match(/^(.+?\.(?:tex|sty|cls|bib)):(\d+):\s*(.+)$/i);
    if (fileLine) {
      add({
        severity: /warning/i.test(fileLine[3]!) ? 'warning' : 'error',
        file: cleanPath(fileLine[1]!),
        line: Number(fileLine[2]),
        column: null,
        message: fileLine[3]!.trim(),
        source: 'latex',
      });
      continue;
    }
    if (line.startsWith('! ')) {
      const location = lines
        .slice(index + 1, index + 4)
        .join(' ')
        .match(/l\.(\d+)/);
      add({
        severity: 'error',
        file: null,
        line: location ? Number(location[1]) : null,
        column: null,
        message: line.slice(2).trim(),
        source: 'latex',
      });
      continue;
    }
    const warning = line.match(
      /(?:LaTeX|Package .+?) Warning:\s*(.+?)(?: on input line (\d+))?\.?$/,
    );
    if (warning)
      add({
        severity: 'warning',
        file: null,
        line: warning[2] ? Number(warning[2]) : null,
        column: null,
        message: warning[1]!.trim(),
        source: 'latex',
      });
  }
  return diagnostics.slice(0, 500);

  function add(diagnostic: Diagnostic) {
    const key = `${diagnostic.severity}:${diagnostic.file}:${diagnostic.line}:${diagnostic.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      diagnostics.push(diagnostic);
    }
  }
}

function cleanPath(path: string) {
  return path.replace(/^.*?\/workspace\//, '').replace(/^\.\//, '');
}
