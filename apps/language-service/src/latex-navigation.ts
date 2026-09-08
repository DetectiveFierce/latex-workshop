export type LspPosition = { line: number; character: number };
export type LspRange = { start: LspPosition; end: LspPosition };
export type LspLocation = { uri: string; range: LspRange };

type SymbolKind = 'command' | 'environment';
type LatexSymbol = {
  kind: SymbolKind;
  name: string;
  range: LspRange;
  definition: boolean;
};
type IndexedDocument = { text: string; symbols: LatexSymbol[] };

const COMMAND_DECLARATION =
  /\\(?:newcommand|renewcommand|providecommand|DeclareRobustCommand|NewDocumentCommand|RenewDocumentCommand|ProvideDocumentCommand|DeclareDocumentCommand|DeclareMathOperator)\*?\s*(?:\{\s*)?(\\[A-Za-z@]+)(?:\s*\})?/g;
const PRIMITIVE_COMMAND_DECLARATION =
  /\\(?:(?:global|long)\s*\\)*(?:gdef|edef|xdef|def)\s*(\\[A-Za-z@]+)/g;
const LET_DECLARATION = /\\let\s*(\\[A-Za-z@]+)/g;
const ENVIRONMENT_DECLARATION =
  /\\(?:newenvironment|renewenvironment|NewDocumentEnvironment|RenewDocumentEnvironment|ProvideDocumentEnvironment|DeclareDocumentEnvironment|newtheorem)\*?\s*\{\s*([^\s{}]+)\s*\}/g;
const COMMAND = /\\(?:[A-Za-z@]+|[^\s])/g;
const ENVIRONMENT = /\\(?:begin|end)\s*\{\s*([^\s{}]+)\s*\}/g;

export class LatexNavigationIndex {
  private readonly documents = new Map<string, IndexedDocument>();

  upsert(uri: string, text: string) {
    this.documents.set(uri, { text, symbols: indexDocument(text) });
  }

  remove(uri: string) {
    this.documents.delete(uri);
  }

  text(uri: string) {
    return this.documents.get(uri)?.text;
  }

  definition(uri: string, position: LspPosition): LspLocation[] | null {
    const target = this.symbolAt(uri, position);
    if (!target) return null;
    const locations = this.matches(target.kind, target.name, true);
    return locations.length ? locations : null;
  }

  references(
    uri: string,
    position: LspPosition,
    includeDeclaration: boolean,
  ): LspLocation[] | null {
    const target = this.symbolAt(uri, position);
    if (!target) return null;
    // A symbol with no project declaration belongs to a package or the TeX runtime. Let TexLab
    // answer those requests instead of treating every built-in command as a project symbol.
    if (!this.matches(target.kind, target.name, true).length) return null;
    return this.matches(target.kind, target.name, includeDeclaration ? undefined : false);
  }

  private symbolAt(uri: string, position: LspPosition) {
    const document = this.documents.get(uri);
    if (!document) return null;
    const offset = offsetAt(document.text, position);
    if (offset === null) return null;
    return (
      document.symbols.find((symbol) => rangeContainsOffset(document.text, symbol.range, offset)) ??
      // Editors commonly ask at the end of a token, where the cursor is one character beyond it.
      document.symbols.find(
        (symbol) => offset > 0 && rangeContainsOffset(document.text, symbol.range, offset - 1),
      ) ??
      null
    );
  }

  private matches(kind: SymbolKind, name: string, definition?: boolean) {
    const locations: LspLocation[] = [];
    for (const [uri, document] of this.documents) {
      for (const symbol of document.symbols) {
        if (
          symbol.kind === kind &&
          symbol.name === name &&
          (definition === undefined || symbol.definition === definition)
        )
          locations.push({ uri, range: symbol.range });
      }
    }
    return locations;
  }
}

export function applyLspContentChanges(text: string, changes: readonly unknown[]): string | null {
  let result = text;
  for (const value of changes) {
    if (!isRecord(value) || typeof value.text !== 'string') return null;
    if (value.range === undefined) {
      result = value.text;
      continue;
    }
    if (!isRange(value.range)) return null;
    const start = offsetAt(result, value.range.start);
    const end = offsetAt(result, value.range.end);
    if (start === null || end === null || start > end) return null;
    result = `${result.slice(0, start)}${value.text}${result.slice(end)}`;
  }
  return result;
}

function indexDocument(text: string) {
  const searchable = maskComments(text);
  const definitions: LatexSymbol[] = [];
  collectCommandDefinitions(text, searchable, COMMAND_DECLARATION, definitions);
  collectCommandDefinitions(text, searchable, PRIMITIVE_COMMAND_DECLARATION, definitions);
  collectCommandDefinitions(text, searchable, LET_DECLARATION, definitions);
  collectEnvironmentDefinitions(text, searchable, definitions);

  const symbols: LatexSymbol[] = [];
  for (const match of searchable.matchAll(COMMAND)) {
    const token = match[0];
    const start = match.index;
    symbols.push({
      kind: 'command',
      name: token,
      range: rangeAt(text, start, start + token.length),
      definition: definitions.some(
        (definition) =>
          definition.kind === 'command' &&
          definition.name === token &&
          rangesEqual(definition.range, rangeAt(text, start, start + token.length)),
      ),
    });
  }
  for (const match of searchable.matchAll(ENVIRONMENT)) {
    const name = match[1];
    if (!name) continue;
    const relativeStart = match[0].indexOf(name);
    const start = match.index + relativeStart;
    symbols.push({
      kind: 'environment',
      name,
      range: rangeAt(text, start, start + name.length),
      definition: false,
    });
  }
  // Declaration names do not look like ordinary environment uses, so add them explicitly. Command
  // declarations have already been found by the general command scanner and are marked above.
  symbols.push(...definitions.filter((definition) => definition.kind === 'environment'));
  return symbols;
}

function collectCommandDefinitions(
  text: string,
  searchable: string,
  pattern: RegExp,
  target: LatexSymbol[],
) {
  for (const match of searchable.matchAll(pattern)) {
    const name = match[1];
    if (!name) continue;
    const relativeStart = match[0].lastIndexOf(name);
    const start = match.index + relativeStart;
    target.push({
      kind: 'command',
      name,
      range: rangeAt(text, start, start + name.length),
      definition: true,
    });
  }
}

function collectEnvironmentDefinitions(text: string, searchable: string, target: LatexSymbol[]) {
  for (const match of searchable.matchAll(ENVIRONMENT_DECLARATION)) {
    const name = match[1];
    if (!name) continue;
    const relativeStart = match[0].lastIndexOf(name);
    const start = match.index + relativeStart;
    target.push({
      kind: 'environment',
      name,
      range: rangeAt(text, start, start + name.length),
      definition: true,
    });
  }
}

function maskComments(text: string) {
  let escaped = false;
  let comment = false;
  let result = '';
  for (const character of text) {
    if (comment) {
      if (character === '\n') {
        comment = false;
        result += character;
      } else result += ' ';
      escaped = false;
      continue;
    }
    if (character === '%' && !escaped) {
      comment = true;
      result += ' ';
      escaped = false;
      continue;
    }
    result += character;
    escaped = character === '\\' ? !escaped : false;
  }
  return result;
}

function offsetAt(text: string, position: LspPosition) {
  if (
    !Number.isInteger(position.line) ||
    !Number.isInteger(position.character) ||
    position.line < 0 ||
    position.character < 0
  )
    return null;
  let offset = 0;
  for (let line = 0; line < position.line; line += 1) {
    const next = text.indexOf('\n', offset);
    if (next < 0) return null;
    offset = next + 1;
  }
  const lineEnd = text.indexOf('\n', offset);
  const available = (lineEnd < 0 ? text.length : lineEnd) - offset;
  return position.character <= available ? offset + position.character : null;
}

function positionAt(text: string, offset: number): LspPosition {
  let line = 0;
  let lineStart = 0;
  for (let index = 0; index < offset; index += 1) {
    if (text[index] === '\n') {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, character: offset - lineStart };
}

function rangeAt(text: string, start: number, end: number): LspRange {
  return { start: positionAt(text, start), end: positionAt(text, end) };
}

function rangeContainsOffset(text: string, range: LspRange, offset: number) {
  const start = offsetAt(text, range.start);
  const end = offsetAt(text, range.end);
  return start !== null && end !== null && offset >= start && offset < end;
}

function rangesEqual(left: LspRange, right: LspRange) {
  return (
    left.start.line === right.start.line &&
    left.start.character === right.start.character &&
    left.end.line === right.end.line &&
    left.end.character === right.end.character
  );
}

function isRange(value: unknown): value is LspRange {
  if (!isRecord(value) || !isPosition(value.start) || !isPosition(value.end)) return false;
  return true;
}

function isPosition(value: unknown): value is LspPosition {
  return isRecord(value) && typeof value.line === 'number' && typeof value.character === 'number';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
