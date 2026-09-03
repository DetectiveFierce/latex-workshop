import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TexLabClient } from './lspClient';

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeSocket[] = [];

  readyState = FakeSocket.CONNECTING;
  sent: Array<Record<string, unknown>> = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(value: string) {
    this.sent.push(JSON.parse(value));
  }

  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  respondTo(method: string, result: unknown) {
    const request = this.sent.find((message) => message.method === method);
    if (!request?.id) throw new Error(`No ${method} request was sent`);
    this.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) });
  }

  disconnect() {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }

  close() {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.disconnect();
  }
}

describe('TexLabClient lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('window', {
      location: { protocol: 'http:', host: 'localhost:5173' },
      setTimeout,
      clearTimeout,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('opens models queued before initialization and replays them after reconnect', async () => {
    const registrations = { completions: 0, hovers: 0, definitions: 0, references: 0, symbols: 0 };
    const disposable = { dispose: vi.fn() };
    const monaco = {
      languages: {
        CompletionItemKind: { Text: 0 },
        CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
        SymbolKind: { String: 14 },
        registerCompletionItemProvider: () => {
          registrations.completions += 1;
          return disposable;
        },
        registerHoverProvider: () => {
          registrations.hovers += 1;
          return disposable;
        },
        registerDefinitionProvider: () => {
          registrations.definitions += 1;
          return disposable;
        },
        registerReferenceProvider: () => {
          registrations.references += 1;
          return disposable;
        },
        registerDocumentSymbolProvider: () => {
          registrations.symbols += 1;
          return disposable;
        },
      },
      editor: { getModel: vi.fn(), setModelMarkers: vi.fn() },
      Uri: { parse: (value: string) => value },
      MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
      Range: class {},
    };
    const model = {
      uri: { scheme: 'file', toString: () => 'file:///workspace/main.tex' },
      getLanguageId: () => 'latex',
      getVersionId: () => 7,
      getValue: () => 'queued source',
    };
    const statuses: string[] = [];
    const client = new TexLabClient(monaco as never, 'project-id', (status) =>
      statuses.push(status),
    );

    client.connect();
    client.open(model as never);
    expect(FakeSocket.instances).toHaveLength(1);
    const first = FakeSocket.instances[0]!;
    first.open();
    first.respondTo('initialize', {});
    await vi.runAllTicks();
    await Promise.resolve();

    expect(first.sent.filter((message) => message.method === 'textDocument/didOpen')).toHaveLength(
      1,
    );
    expect(registrations).toEqual({
      completions: 1,
      hovers: 1,
      definitions: 1,
      references: 1,
      symbols: 1,
    });
    expect(statuses).toContain('ready');
    for (const data of [
      'not json',
      'null',
      '[]',
      '{"jsonrpc":"1.0"}',
      '{"jsonrpc":"2.0","id":{}}',
    ]) {
      expect(() => first.onmessage?.({ data })).not.toThrow();
    }

    first.disconnect();
    expect(statuses.at(-1)).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(500);
    expect(FakeSocket.instances).toHaveLength(2);
    const second = FakeSocket.instances[1]!;
    second.open();
    second.respondTo('initialize', {});
    await vi.runAllTicks();
    await Promise.resolve();

    expect(second.sent.filter((message) => message.method === 'textDocument/didOpen')).toHaveLength(
      1,
    );
    expect(registrations.completions).toBe(1);
    client.dispose();
  });
});
