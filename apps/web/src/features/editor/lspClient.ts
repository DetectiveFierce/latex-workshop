import type * as Monaco from 'monaco-editor';
import { appPath } from '../../lib/api';

type JsonRpc = {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: any;
};
type Pending = {
  resolve: (value: any) => void;
  reject: (reason: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
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
    this.socket.onmessage = (event) => this.receive(JSON.parse(String(event.data)) as JsonRpc);
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
          const items = Array.isArray(response) ? response : (response?.items ?? []);
          return {
            suggestions: items.map((item: any) => ({
              label: typeof item.label === 'string' ? item.label : item.label.label,
              detail: item.detail,
              documentation: markup(item.documentation),
              kind: mapCompletionKind(this.monaco, item.kind),
              insertText: item.textEdit?.newText ?? item.insertText ?? item.label,
              range: item.textEdit?.range
                ? toMonacoRange(this.monaco, item.textEdit.range)
                : undefined,
              insertTextRules:
                item.insertTextFormat === 2
                  ? this.monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
                  : undefined,
            })),
          };
        },
      }),
    );
    this.disposables.push(
      this.monaco.languages.registerHoverProvider(selector, {
        provideHover: async (model, position) => {
          const result = await this.request('textDocument/hover', {
            textDocument: { uri: model.uri.toString() },
            position: toLspPosition(position),
          }).catch(() => null);
          if (!result) return null;
          const contents = Array.isArray(result.contents) ? result.contents : [result.contents];
          return {
            ...(result.range ? { range: toMonacoRange(this.monaco, result.range) } : {}),
            contents: contents.map((value: any) => ({ value: markup(value) || '' })),
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
          const result = await this.request('textDocument/documentSymbol', {
            textDocument: { uri: model.uri.toString() },
          }).catch(() => []);
          return (result ?? []).map((symbol: any) => ({
            name: symbol.name,
            detail: symbol.detail ?? '',
            kind: symbol.kind ?? this.monaco.languages.SymbolKind.String,
            range: toMonacoRange(this.monaco, symbol.range ?? symbol.location.range),
            selectionRange: toMonacoRange(
              this.monaco,
              symbol.selectionRange ?? symbol.range ?? symbol.location.range,
            ),
            tags: [],
          }));
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
    const result = await this.request(method, {
      textDocument: { uri: model.uri.toString() },
      position: toLspPosition(position),
      ...extra,
    }).catch(() => []);
    const locations = Array.isArray(result) ? result : result ? [result] : [];
    return locations.map((location: any) => ({
      uri: this.monaco.Uri.parse(location.uri ?? location.targetUri),
      range: toMonacoRange(this.monaco, location.range ?? location.targetSelectionRange),
    }));
  }

  private receive(message: JsonRpc) {
    if (message.id !== undefined && (message.result !== undefined || message.error)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      const result =
        message.method === 'workspace/configuration'
          ? (message.params?.items ?? []).map(() => ({
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
      const uri = this.monaco.Uri.parse(message.params.uri);
      const model = this.monaco.editor.getModel(uri);
      if (!model) return;
      this.monaco.editor.setModelMarkers(
        model,
        'texlab',
        (message.params.diagnostics ?? []).map((diagnostic: any) => ({
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
          code: typeof diagnostic.code === 'string' ? diagnostic.code : undefined,
        })),
      );
    }
  }

  private request(method: string, params: unknown) {
    const id = ++this.requestId;
    return new Promise<any>((resolve, reject) => {
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
const toMonacoRange = (monaco: typeof Monaco, range: any) =>
  new monaco.Range(
    range.start.line + 1,
    range.start.character + 1,
    range.end.line + 1,
    range.end.character + 1,
  );
const rangeToMarker = (range: any) => ({
  startLineNumber: range.start.line + 1,
  startColumn: range.start.character + 1,
  endLineNumber: range.end.line + 1,
  endColumn: range.end.character + 1,
});
function markup(value: any): string | undefined {
  return typeof value === 'string' ? value : (value?.value ?? value?.contents);
}
function mapCompletionKind(monaco: typeof Monaco, kind?: number) {
  return kind && kind >= 1 && kind <= 25 ? kind - 1 : monaco.languages.CompletionItemKind.Text;
}
