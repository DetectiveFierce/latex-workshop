import type * as Monaco from 'monaco-editor';
import { appPath } from '../../lib/api';

type JsonRpc = {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};
type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type LspPosition = { line: number; character: number };
type LspRange = { start: LspPosition; end: LspPosition };
type LspMarkup = string | { value?: string; contents?: string };
type LspCompletionItem = {
  label: string | { label: string };
  detail?: string;
  documentation?: LspMarkup;
  kind?: number;
  insertText?: string;
  insertTextFormat?: number;
  textEdit?: { newText: string; range: LspRange };
};
type LspHover = { contents: LspMarkup | LspMarkup[]; range?: LspRange };
type LspLocation = {
  uri?: string;
  targetUri?: string;
  range?: LspRange;
  targetSelectionRange?: LspRange;
};
type LspDocumentSymbol = {
  name: string;
  detail?: string;
  kind?: number;
  range?: LspRange;
  selectionRange?: LspRange;
  location?: { range: LspRange };
};
type LspDiagnostic = {
  range: LspRange;
  message: string;
  severity?: number;
  source?: string;
  code?: string | number;
};
export type TexLabStatus = 'connecting' | 'ready' | 'reconnecting' | 'failed';

function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error('Language server initialization timed out')),
      milliseconds,
    );
    void promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class TexLabClient {
  private socket: WebSocket | null = null;
  private requestId = 0;
  private pending = new Map<number | string, Pending>();
  private opened = new Set<string>();
  private desired = new Map<string, Monaco.editor.ITextModel>();
  private disposables: Monaco.IDisposable[] = [];
  private ready = false;
  private disposed = false;
  private reconnectTimer: number | null = null;
  private reconnectAttempt = 0;
  private providersRegistered = false;

  constructor(
    private monaco: typeof Monaco,
    private projectId: string,
    private onStatus: (status: TexLabStatus) => void,
  ) {}

  connect() {
    if (
      this.disposed ||
      this.socket?.readyState === WebSocket.CONNECTING ||
      this.socket?.readyState === WebSocket.OPEN
    )
      return;
    this.onStatus(this.reconnectAttempt ? 'reconnecting' : 'connecting');
    const configured = import.meta.env.VITE_LSP_URL as string | undefined;
    const base =
      configured ??
      `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`;
    this.socket = new WebSocket(`${base}${appPath(`/api/v1/projects/${this.projectId}/lsp`)}`);
    this.socket.onopen = async () => {
      try {
        await withTimeout(
          this.request('initialize', {
            processId: null,
            rootUri: 'file:///workspace',
            workspaceFolders: [{ uri: 'file:///workspace', name: 'project' }],
            capabilities: {
              workspace: { workspaceFolders: true, configuration: true },
              textDocument: {
                synchronization: { didSave: true },
                completion: {
                  completionItem: {
                    snippetSupport: true,
                    documentationFormat: ['markdown', 'plaintext'],
                  },
                },
                hover: { contentFormat: ['markdown', 'plaintext'] },
                definition: { linkSupport: true },
                references: {},
                documentSymbol: { hierarchicalDocumentSymbolSupport: true },
                publishDiagnostics: { relatedInformation: true },
              },
            },
            initializationOptions: {
              texlab: { build: { onSave: false }, diagnostics: { delay: 300 } },
            },
          }),
          8_000,
        );
        this.notify('initialized', {});
        this.ready = true;
        this.reconnectAttempt = 0;
        this.onStatus('ready');
        if (!this.providersRegistered) {
          this.registerProviders();
          this.providersRegistered = true;
        }
        this.opened.clear();
        for (const model of this.desired.values()) this.open(model);
      } catch {
        this.onStatus('reconnecting');
        this.socket?.close();
      }
    };
    this.socket.onmessage = (event) => {
      const message = parseJsonRpc(String(event.data));
      if (message) this.receive(message);
    };
    this.socket.onclose = () => {
      this.ready = false;
      this.onStatus('reconnecting');
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error('Language server disconnected'));
      }
      this.pending.clear();
      this.opened.clear();
      this.socket = null;
      if (!this.disposed && this.reconnectAttempt < 7) {
        const delay = Math.min(15_000, 500 * 2 ** this.reconnectAttempt++);
        this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
      } else if (!this.disposed) this.onStatus('failed');
    };
    this.socket.onerror = () => this.onStatus('reconnecting');
  }

  dispose() {
    this.disposed = true;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    for (const disposable of this.disposables) disposable.dispose();
    for (const uri of this.opened) this.notify('textDocument/didClose', { textDocument: { uri } });
    this.desired.clear();
    this.socket?.close();
  }

  open(model: Monaco.editor.ITextModel) {
    if (model.getLanguageId() !== 'latex' || model.uri.scheme !== 'file') return;
    const uri = model.uri.toString();
    this.desired.set(uri, model);
    if (!this.ready) return;
    if (this.opened.has(uri)) return;
    this.opened.add(uri);
    this.notify('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId: 'latex',
        version: model.getVersionId(),
        text: model.getValue(),
      },
    });
  }

  close(model: Monaco.editor.ITextModel) {
    const uri = model.uri.toString();
    this.desired.delete(uri);
    if (!this.opened.delete(uri)) return;
    if (this.ready)
      this.notify('textDocument/didClose', {
        textDocument: { uri },
      });
  }

  change(model: Monaco.editor.ITextModel) {
    if (!this.ready || !this.opened.has(model.uri.toString())) return;
    this.notify('textDocument/didChange', {
      textDocument: { uri: model.uri.toString(), version: model.getVersionId() },
      contentChanges: [{ text: model.getValue() }],
    });
  }

  save(model: Monaco.editor.ITextModel) {
    if (this.ready && this.opened.has(model.uri.toString()))
      this.notify('textDocument/didSave', {
        textDocument: { uri: model.uri.toString() },
        text: model.getValue(),
      });
  }

  private registerProviders() {
    const selector = { language: 'latex', scheme: 'file' };
    this.disposables.push(
      this.monaco.languages.registerCompletionItemProvider(selector, {
        triggerCharacters: ['\\', '{'],
        provideCompletionItems: async (model, position) => {
          const response = await this.request('textDocument/completion', {
            textDocument: { uri: model.uri.toString() },
            position: toLspPosition(position),
          }).catch(() => null);
          const items = completionItems(response);
          const word = model.getWordUntilPosition(position);
          const defaultRange = {
            startLineNumber: position.lineNumber,
            startColumn: word.startColumn,
            endLineNumber: position.lineNumber,
            endColumn: word.endColumn,
          };
          return {
            suggestions: items.map((item) => {
              const label = typeof item.label === 'string' ? item.label : item.label.label;
              const documentation = markup(item.documentation);
              return {
                label,
                kind: mapCompletionKind(this.monaco, item.kind),
                insertText: item.textEdit?.newText ?? item.insertText ?? label,
                range: item.textEdit?.range
                  ? toMonacoRange(this.monaco, item.textEdit.range)
                  : defaultRange,
                ...(item.detail !== undefined ? { detail: item.detail } : {}),
                ...(documentation !== undefined ? { documentation } : {}),
                ...(item.insertTextFormat === 2
                  ? {
                      insertTextRules:
                        this.monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                    }
                  : {}),
              };
            }),
          };
        },
      }),
    );
    this.disposables.push(
      this.monaco.languages.registerHoverProvider(selector, {
        provideHover: async (model, position) => {
          const response = await this.request('textDocument/hover', {
            textDocument: { uri: model.uri.toString() },
            position: toLspPosition(position),
          }).catch(() => null);
          const result = isLspHover(response) ? response : null;
          if (result === null) return null;
          const contents = Array.isArray(result.contents) ? result.contents : [result.contents];
          return {
            ...(result.range ? { range: toMonacoRange(this.monaco, result.range) } : {}),
            contents: contents.map((value) => ({ value: markup(value) || '' })),
          };
        },
      }),
    );
    this.disposables.push(
      this.monaco.languages.registerDefinitionProvider(selector, {
        provideDefinition: (model, position) =>
          this.locations('textDocument/definition', model, position),
      }),
    );
    this.disposables.push(
      this.monaco.languages.registerReferenceProvider(selector, {
        provideReferences: (model, position, context) =>
          this.locations('textDocument/references', model, position, { context }),
      }),
    );
    this.disposables.push(
      this.monaco.languages.registerDocumentSymbolProvider(selector, {
        provideDocumentSymbols: async (model) => {
          const response = await this.request('textDocument/documentSymbol', {
            textDocument: { uri: model.uri.toString() },
          }).catch(() => []);
          const symbols = Array.isArray(response) ? response.filter(isLspDocumentSymbol) : [];
          return symbols.flatMap((symbol) => {
            const range = symbol.range ?? symbol.location?.range;
            const selectionRange = symbol.selectionRange ?? range;
            if (!range || !selectionRange) return [];
            return [
              {
                name: symbol.name,
                detail: symbol.detail ?? '',
                kind: symbol.kind ?? this.monaco.languages.SymbolKind.String,
                range: toMonacoRange(this.monaco, range),
                selectionRange: toMonacoRange(this.monaco, selectionRange),
                tags: [],
              },
            ];
          });
        },
      }),
    );
  }

  private async locations(
    method: string,
    model: Monaco.editor.ITextModel,
    position: Monaco.Position,
    extra = {},
  ) {
    const response = await this.request(method, {
      textDocument: { uri: model.uri.toString() },
      position: toLspPosition(position),
      ...extra,
    }).catch(() => []);
    const locations = (Array.isArray(response) ? response : [response]).filter(isLspLocation);
    return locations.flatMap((location) => {
      const uri = location.uri ?? location.targetUri;
      const range = location.range ?? location.targetSelectionRange;
      return uri && range
        ? [{ uri: this.monaco.Uri.parse(uri), range: toMonacoRange(this.monaco, range) }]
        : [];
    });
  }

  private receive(message: JsonRpc) {
    if (message.id !== undefined && (message.result !== undefined || message.error)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) pending.reject(new Error(rpcErrorMessage(message.error)));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      const params = record(message.params);
      const result =
        message.method === 'workspace/configuration'
          ? (Array.isArray(params?.items) ? params.items : []).map(() => ({
              build: { onSave: false },
              chktex: { onOpenAndSave: true, onEdit: true },
            }))
          : message.method === 'workspace/workspaceFolders'
            ? [{ uri: 'file:///workspace', name: 'project' }]
            : null;
      this.send({ jsonrpc: '2.0', id: message.id, result });
      return;
    }
    if (message.method === 'textDocument/publishDiagnostics') {
      const params = record(message.params);
      if (typeof params?.uri !== 'string') return;
      const uri = this.monaco.Uri.parse(params.uri);
      const model = this.monaco.editor.getModel(uri);
      if (!model) return;
      const diagnostics = Array.isArray(params.diagnostics)
        ? params.diagnostics.filter(isLspDiagnostic)
        : [];
      this.monaco.editor.setModelMarkers(
        model,
        'texlab',
        diagnostics.map((diagnostic) => ({
          ...rangeToMarker(diagnostic.range),
          message: diagnostic.message,
          severity:
            diagnostic.severity === 1
              ? this.monaco.MarkerSeverity.Error
              : diagnostic.severity === 2
                ? this.monaco.MarkerSeverity.Warning
                : diagnostic.severity === 3
                  ? this.monaco.MarkerSeverity.Info
                  : this.monaco.MarkerSeverity.Hint,
          source: diagnostic.source ?? 'TexLab',
          ...(typeof diagnostic.code === 'string' ? { code: diagnostic.code } : {}),
        })),
      );
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.requestId;
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 10_000);
      this.pending.set(id, { resolve, reject, timeout });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }
  private notify(method: string, params: unknown) {
    this.send({ jsonrpc: '2.0', method, params });
  }
  private send(message: JsonRpc) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }
}

const toLspPosition = (position: Monaco.Position) => ({
  line: position.lineNumber - 1,
  character: position.column - 1,
});
const toMonacoRange = (monaco: typeof Monaco, range: LspRange) =>
  new monaco.Range(
    range.start.line + 1,
    range.start.character + 1,
    range.end.line + 1,
    range.end.character + 1,
  );
const rangeToMarker = (range: LspRange) => ({
  startLineNumber: range.start.line + 1,
  startColumn: range.start.character + 1,
  endLineNumber: range.end.line + 1,
  endColumn: range.end.character + 1,
});
function markup(value: LspMarkup | undefined): string | undefined {
  return typeof value === 'string' ? value : (value?.value ?? value?.contents);
}
function mapCompletionKind(monaco: typeof Monaco, kind?: number) {
  return kind && kind >= 1 && kind <= 25 ? kind - 1 : monaco.languages.CompletionItemKind.Text;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseJsonRpc(value: string): JsonRpc | null {
  try {
    const parsed = record(JSON.parse(value));
    if (!parsed || parsed.jsonrpc !== '2.0') return null;
    if (parsed.id !== undefined && typeof parsed.id !== 'number' && typeof parsed.id !== 'string')
      return null;
    if (parsed.method !== undefined && typeof parsed.method !== 'string') return null;
    return {
      jsonrpc: '2.0',
      ...(parsed.id !== undefined ? { id: parsed.id } : {}),
      ...(parsed.method !== undefined ? { method: parsed.method } : {}),
      ...(parsed.params !== undefined ? { params: parsed.params } : {}),
      ...(parsed.result !== undefined ? { result: parsed.result } : {}),
      ...(parsed.error !== undefined ? { error: parsed.error } : {}),
    };
  } catch {
    return null;
  }
}

function isLspPosition(value: unknown): value is LspPosition {
  const position = record(value);
  return (
    typeof position?.line === 'number' &&
    Number.isInteger(position.line) &&
    position.line >= 0 &&
    typeof position.character === 'number' &&
    Number.isInteger(position.character) &&
    position.character >= 0
  );
}

function isLspRange(value: unknown): value is LspRange {
  const range = record(value);
  return isLspPosition(range?.start) && isLspPosition(range.end);
}

function isLspMarkup(value: unknown): value is LspMarkup {
  if (typeof value === 'string') return true;
  const markup = record(value);
  return (
    markup !== null && (typeof markup.value === 'string' || typeof markup.contents === 'string')
  );
}

function isLspCompletionItem(value: unknown): value is LspCompletionItem {
  const item = record(value);
  const label = record(item?.label);
  const textEdit = record(item?.textEdit);
  return (
    item !== null &&
    (typeof item.label === 'string' || typeof label?.label === 'string') &&
    (item.detail === undefined || typeof item.detail === 'string') &&
    (item.documentation === undefined || isLspMarkup(item.documentation)) &&
    (item.kind === undefined || typeof item.kind === 'number') &&
    (item.insertText === undefined || typeof item.insertText === 'string') &&
    (item.insertTextFormat === undefined || typeof item.insertTextFormat === 'number') &&
    (item.textEdit === undefined ||
      (textEdit !== null && typeof textEdit.newText === 'string' && isLspRange(textEdit.range)))
  );
}

function completionItems(value: unknown): LspCompletionItem[] {
  const response = record(value);
  const items = Array.isArray(value) ? value : Array.isArray(response?.items) ? response.items : [];
  return items.filter(isLspCompletionItem);
}

function isLspHover(value: unknown): value is LspHover {
  const hover = record(value);
  const contents = hover?.contents;
  return (
    hover !== null &&
    (isLspMarkup(contents) || (Array.isArray(contents) && contents.every(isLspMarkup))) &&
    (hover.range === undefined || isLspRange(hover.range))
  );
}

function isLspLocation(value: unknown): value is LspLocation {
  const location = record(value);
  return (
    location !== null &&
    (typeof location.uri === 'string' || typeof location.targetUri === 'string') &&
    (isLspRange(location.range) || isLspRange(location.targetSelectionRange))
  );
}

function isLspDocumentSymbol(value: unknown): value is LspDocumentSymbol {
  const symbol = record(value);
  const location = record(symbol?.location);
  return (
    symbol !== null &&
    typeof symbol.name === 'string' &&
    (symbol.detail === undefined || typeof symbol.detail === 'string') &&
    (symbol.kind === undefined || typeof symbol.kind === 'number') &&
    (isLspRange(symbol.range) || isLspRange(location?.range)) &&
    (symbol.selectionRange === undefined || isLspRange(symbol.selectionRange))
  );
}

function isLspDiagnostic(value: unknown): value is LspDiagnostic {
  const diagnostic = record(value);
  return (
    isLspRange(diagnostic?.range) &&
    typeof diagnostic.message === 'string' &&
    (diagnostic.severity === undefined || typeof diagnostic.severity === 'number') &&
    (diagnostic.source === undefined || typeof diagnostic.source === 'string') &&
    (diagnostic.code === undefined ||
      typeof diagnostic.code === 'string' ||
      typeof diagnostic.code === 'number')
  );
}

function rpcErrorMessage(value: unknown): string {
  const error = record(value);
  return typeof error?.message === 'string' ? error.message : 'Language server request failed';
}
