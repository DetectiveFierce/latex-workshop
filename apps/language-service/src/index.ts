import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { fromNodeHeaders } from 'better-auth/node';
import { and, eq, sql } from 'drizzle-orm';
import { WebSocketServer, type WebSocket } from 'ws';
import { loadConfig } from '@latex-workshop/config';
import { buildEntryPaths } from '@latex-workshop/contracts';
import {
  accounts,
  createDatabase,
  entries,
  fileBlobs,
  fileVersions,
  projectMemberships,
  sessions,
  users,
  verifications,
} from '@latex-workshop/db';
import { ObjectStorage } from '@latex-workshop/storage';
import { LspFrameDecoder, LspFrameError } from './lsp-framing.js';
import {
  applyLspContentChanges,
  LatexNavigationIndex,
  type LspPosition,
} from './latex-navigation.js';

const config = loadConfig();
const { db, client } = createDatabase(config.DATABASE_URL);
const storage = new ObjectStorage(config);
const auth = betterAuth({
  appName: 'LaTeX Workshop',
  baseURL: config.API_ORIGIN,
  basePath: '/api/auth',
  secret: config.AUTH_SECRET,
  trustedOrigins: [config.WEB_ORIGIN],
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: { user: users, session: sessions, account: accounts, verification: verifications },
  }),
  advanced: {
    useSecureCookies: config.NODE_ENV === 'production',
    ipAddress: { ipAddressHeaders: ['x-client-ip'] },
  },
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    revokeSessionsOnPasswordReset: true,
  },
  emailVerification: { sendOnSignUp: true, sendOnSignIn: true, autoSignInAfterVerification: true },
  user: { deleteUser: { enabled: true }, changeEmail: { enabled: true } },
  rateLimit: { enabled: true, window: 60, max: 30 },
});

const server = createServer(async (request, response) => {
  if (request.url === '/health/live') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok', service: 'language-service' }));
  } else if (request.url === '/health/ready') {
    try {
      await db.execute(sql`select 1`);
      await storage.ensureBucket();
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'ready', service: 'language-service' }));
    } catch {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'not-ready', service: 'language-service' }));
    }
  } else {
    response.writeHead(404);
    response.end();
  }
});
const sockets = new WebSocketServer({ noServer: true, maxPayload: 2_000_000 });

server.on('upgrade', async (request, socket, head) => {
  try {
    const match = request.url?.match(/^\/api\/v1\/projects\/([0-9a-f-]+)\/lsp$/i);
    if (!match) return socket.destroy();
    const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
    if (!session) return reject(socket, 401, 'Unauthorized');
    const [membership] = await db
      .select()
      .from(projectMemberships)
      .where(
        and(
          eq(projectMemberships.projectId, match[1]!),
          eq(projectMemberships.userId, session.user.id),
        ),
      )
      .limit(1);
    if (!membership) return reject(socket, 404, 'Not found');
    sockets.handleUpgrade(request, socket, head, (ws) => {
      sockets.emit('connection', ws, request, { projectId: match[1]! });
    });
  } catch {
    reject(socket, 500, 'Internal error');
  }
});

sockets.on(
  'connection',
  (socket: WebSocket, _request: IncomingMessage, context: { projectId: string }) => {
    void bridgeTexLab(socket, context.projectId);
  },
);

async function bridgeTexLab(socket: WebSocket, projectId: string) {
  const workspace = await mkdtemp(join(tmpdir(), 'latex-lsp-'));
  const navigation = new LatexNavigationIndex();
  let processHandle: ChildProcessWithoutNullStreams | null = null;
  let idleTimer: NodeJS.Timeout | null = null;
  let socketClosed = false;
  let forwardMessage: ((message: string) => void) | null = null;
  const queuedMessages: string[] = [];
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => socket.close(1000, 'Idle session closed'), config.SESSION_IDLE_MS);
  };
  resetIdle();
  socket.on('message', (raw) => {
    resetIdle();
    const message = raw.toString();
    if (forwardMessage) forwardMessage(message);
    else queuedMessages.push(message);
  });
  socket.once('close', () => {
    socketClosed = true;
    processHandle?.kill('SIGTERM');
  });
  socket.on('error', () => processHandle?.kill('SIGTERM'));
  try {
    const rows = await db
      .select({ entry: entries, blob: fileBlobs })
      .from(entries)
      .leftJoin(fileVersions, eq(entries.currentVersionId, fileVersions.id))
      .leftJoin(fileBlobs, eq(fileVersions.blobHash, fileBlobs.hash))
      .where(eq(entries.projectId, projectId));
    const paths = buildEntryPaths(rows.map(({ entry }) => entry));
    for (const row of rows) {
      if (row.entry.kind !== 'file' || !row.blob) continue;
      const path = paths.get(row.entry.id);
      if (!path) throw new Error('Language-service file path is missing');
      const target = join(workspace, path);
      await mkdir(dirname(target), { recursive: true });
      const contents = await storage.getBuffer(row.blob.objectKey);
      await writeFile(target, contents);
      if (/\.(?:tex|sty|cls)$/i.test(path))
        navigation.upsert(pathToFileURL(join('/workspace', path)).href, contents.toString('utf8'));
    }

    processHandle = spawn('texlab', ['run'], {
      cwd: workspace,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH ?? '/usr/bin', HOME: workspace },
    });
    const serverRoot = pathToFileURL(workspace).href.replace(/\/$/, '');
    const decoder = new LspFrameDecoder();
    forwardMessage = (message: string) => {
      try {
        const parsed = record(JSON.parse(message));
        if (!parsed) return;
        if (
          parsed.method === 'textDocument/build' ||
          parsed.method === 'workspace/executeCommand'
        ) {
          if (isRpcId(parsed.id))
            socket.send(
              JSON.stringify({
                jsonrpc: '2.0',
                id: parsed.id,
                error: {
                  code: -32601,
                  message: 'Build commands are disabled; use the compilation API',
                },
              }),
            );
          return;
        }
        synchronizeNavigationDocument(navigation, parsed);
        const response = navigationResponse(navigation, parsed);
        if (response) {
          socket.send(JSON.stringify(response));
          return;
        }
      } catch {
        return;
      }
      const rewritten = message.replaceAll('file:///workspace', serverRoot);
      processHandle?.stdin.write(
        `Content-Length: ${Buffer.byteLength(rewritten)}\r\n\r\n${rewritten}`,
      );
    };
    for (const message of queuedMessages.splice(0)) forwardMessage(message);
    processHandle.stdout.on('data', (chunk: Buffer) => {
      try {
        for (const message of decoder.push(chunk)) {
          const body = message.replaceAll(serverRoot, 'file:///workspace');
          if (socket.readyState === socket.OPEN) socket.send(body);
        }
      } catch (error) {
        const detail = error instanceof LspFrameError ? error.message : 'unknown framing error';
        console.error(`[texlab:${projectId}] ${detail}`);
        processHandle?.kill('SIGKILL');
        if (socket.readyState === socket.OPEN) socket.close(1011, 'Invalid language-server output');
      }
    });
    processHandle.stderr.on('data', (chunk: Buffer) =>
      console.error(`[texlab:${projectId}] ${chunk.toString('utf8')}`),
    );
    processHandle.on(
      'close',
      () => socket.readyState === socket.OPEN && socket.close(1011, 'Language server stopped'),
    );
  } catch (error) {
    console.error(error);
    if (socket.readyState === socket.OPEN) socket.close(1011, 'Unable to start language server');
  } finally {
    if (!socketClosed) await new Promise<void>((resolve) => socket.once('close', () => resolve()));
    if (idleTimer) clearTimeout(idleTimer);
    processHandle?.kill('SIGKILL');
    await rm(workspace, { recursive: true, force: true });
  }
}

function synchronizeNavigationDocument(
  navigation: LatexNavigationIndex,
  message: Record<string, unknown>,
) {
  const params = record(message.params);
  const textDocument = record(params?.textDocument);
  const uri = textDocument?.uri;
  if (typeof uri !== 'string' || !isWorkspaceLatexUri(uri)) return;
  if (message.method === 'textDocument/didOpen' && typeof textDocument?.text === 'string') {
    navigation.upsert(uri, textDocument.text);
    return;
  }
  if (message.method === 'textDocument/didSave' && typeof params?.text === 'string') {
    navigation.upsert(uri, params.text);
    return;
  }
  if (message.method !== 'textDocument/didChange' || !Array.isArray(params?.contentChanges)) return;
  const current = navigation.text(uri);
  if (current === undefined) return;
  const changed = applyLspContentChanges(current, params.contentChanges);
  if (changed !== null) navigation.upsert(uri, changed);
}

function navigationResponse(navigation: LatexNavigationIndex, message: Record<string, unknown>) {
  if (!isRpcId(message.id)) return null;
  const params = record(message.params);
  const textDocument = record(params?.textDocument);
  const uri = textDocument?.uri;
  const position = lspPosition(params?.position);
  if (typeof uri !== 'string' || !position) return null;
  if (message.method === 'textDocument/definition') {
    const result = navigation.definition(uri, position);
    return result ? { jsonrpc: '2.0' as const, id: message.id, result } : null;
  }
  if (message.method === 'textDocument/references') {
    const context = record(params?.context);
    const result = navigation.references(uri, position, context?.includeDeclaration === true);
    return result ? { jsonrpc: '2.0' as const, id: message.id, result } : null;
  }
  return null;
}

function lspPosition(value: unknown): LspPosition | null {
  const candidate = record(value);
  if (!candidate) return null;
  return typeof candidate.line === 'number' && typeof candidate.character === 'number'
    ? { line: candidate.line, character: candidate.character }
    : null;
}

function isWorkspaceLatexUri(uri: string) {
  return uri.startsWith('file:///workspace/') && /\.(?:tex|sty|cls)$/i.test(uri);
}

function isRpcId(value: unknown): value is string | number {
  return typeof value === 'string' || typeof value === 'number';
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function reject(socket: import('node:stream').Duplex, status: number, message: string) {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

server.listen(config.LSP_PORT, '0.0.0.0', () =>
  console.log(`Language service listening on ${config.LSP_PORT}`),
);
const shutdown = async () => {
  sockets.close();
  server.close();
  await client.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
