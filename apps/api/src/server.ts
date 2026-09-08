import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { loadConfig } from '@latex-workshop/config';
import { buildOpenApiDocument } from '@latex-workshop/contracts';
import { createContext } from './lib/context.js';
import { HttpError } from './lib/errors.js';
import { serializeAuthProxyBody } from './lib/auth-proxy-body.js';
import { codexCompatibleAuthorizationMetadata } from './lib/oauth-metadata-compat.js';
import { startMaintenance } from './lib/maintenance.js';
import {
  publicAuthBasePath,
  publicRequestUrl,
  publicWellKnownUrl,
} from './lib/public-request-url.js';
import { renderOperationalMetrics } from './lib/operational-metrics.js';
import { scheduleTemplatePreview } from './lib/template-previews.js';
import { registerCompileRoutes } from './routes/compiles.js';
import { registerHistoryRoutes } from './routes/history.js';
import { registerLibraryRoutes } from './routes/library.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerTransferRoutes } from './routes/transfers.js';
import { registerTemplateRoutes } from './routes/templates.js';
import { registerPreferenceRoutes } from './routes/preferences.js';
import { registerEditHistoryRoutes } from './routes/edit-history.js';
import { registerMcpRoutes } from './routes/mcp.js';
import { registerAgentProposalRoutes } from './routes/agent-proposals.js';

export async function buildServer() {
  const config = loadConfig();
  const context = createContext(config);
  const app = Fastify({
    logger: {
      level: config.NODE_ENV === 'development' ? 'debug' : 'info',
      redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers.set-cookie'],
    },
    bodyLimit: config.MAX_FILE_BYTES,
    trustProxy: config.NODE_ENV === 'production',
    requestIdHeader: 'x-request-id',
  });

  await context.storage.ensureBucket();
  await app.register(cors, {
    origin: config.WEB_ORIGIN,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        workerSrc: ["'self'", 'blob:'],
        connectSrc: [
          "'self'",
          config.WEB_ORIGIN,
          config.API_ORIGIN,
          config.API_ORIGIN.replace('http', 'ws'),
        ],
        fontSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  });
  await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute' });
  await app.register(formbody);
  await app.register(multipart, { limits: { fileSize: config.MAX_PROJECT_BYTES, files: 1 } });
  app.addHook('onResponse', async (request, reply) => {
    if (request.method === 'GET' || request.method === 'HEAD' || reply.statusCode >= 400) return;
    const parsed = z.object({ projectId: z.uuid() }).safeParse(request.params);
    if (parsed.success) scheduleTemplatePreview(context, parsed.data.projectId);
  });
  await app.register(swagger, {
    mode: 'static',
    specification: { document: buildOpenApiDocument(config.API_ORIGIN) },
  });
  await app.register(swaggerUi, { routePrefix: '/api/docs' });

  const proxyAuth = async (request: FastifyRequest, reply: FastifyReply) => {
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    }
    headers.set('x-client-ip', request.ip);
    // Fastify has already consumed the incoming stream. Reconstruct the representation
    // Better Auth expects, especially OAuth's required form-encoded token requests.
    headers.delete('content-length');
    const incomingUrl = request.raw.url ?? '/';
    const publicUrl = incomingUrl.startsWith('/.well-known/')
      ? publicWellKnownUrl(config.API_ORIGIN, incomingUrl)
      : publicRequestUrl(config.API_ORIGIN, incomingUrl);
    const body =
      request.method !== 'GET' && request.method !== 'HEAD'
        ? serializeAuthProxyBody(request.headers['content-type'], request.body)
        : undefined;
    const response = await context.auth.handler(
      new Request(publicUrl, {
        method: request.method,
        headers,
        ...(body === undefined ? {} : { body }),
      }),
    );
    reply.code(response.status);
    for (const [key, value] of response.headers.entries())
      if (key !== 'set-cookie') reply.header(key, value);
    const cookies = response.headers.getSetCookie();
    if (cookies.length) reply.header('set-cookie', cookies);
    const responseBody = new Uint8Array(await response.arrayBuffer());
    return reply.send(Buffer.from(codexCompatibleAuthorizationMetadata(incomingUrl, responseBody)));
  };
  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    handler: proxyAuth,
  });
  if (config.AGENT_MCP_ENABLED) {
    const resourcePath = new URL(
      config.AGENT_MCP_RESOURCE_URL ?? publicRequestUrl(config.API_ORIGIN, '/api/mcp').href,
    ).pathname.replace(/\/+$/, '');
    for (const path of new Set([
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/api/mcp',
      `/.well-known/oauth-protected-resource${resourcePath}`,
      '/.well-known/oauth-authorization-server/api/auth',
      `/.well-known/oauth-authorization-server${publicAuthBasePath(config.API_ORIGIN)}`,
      '/api/auth/.well-known/oauth-authorization-server',
      '/api/auth/.well-known/openid-configuration',
    ]))
      app.route({ method: ['GET', 'HEAD'], url: path, handler: proxyAuth });
  }

  app.get('/health/live', async () => ({ status: 'ok', service: 'api' }));
  app.get('/health/ready', async (_request, reply) => {
    try {
      await context.db.execute(sql`select 1`);
      await context.redis.ping();
      await context.storage.ensureBucket();
      return { status: 'ready' };
    } catch (error) {
      app.log.error(error);
      return reply.code(503).send({ status: 'not-ready' });
    }
  });
  app.get('/metrics', async (_request, reply) => {
    const [counts, renderCounts] = await Promise.all([
      context.queue.getJobCounts('waiting', 'active', 'completed', 'failed'),
      context.pdfRenderQueue.getJobCounts('waiting', 'active', 'completed', 'failed'),
    ]);
    reply.type('text/plain; version=0.0.4');
    return [
      '# HELP latex_compile_jobs Number of compilation jobs by state',
      '# TYPE latex_compile_jobs gauge',
      ...Object.entries(counts).map(
        ([state, count]) => `latex_compile_jobs{state="${state}"} ${count}`,
      ),
      '# HELP latex_pdf_render_jobs Number of PDF page render jobs by state',
      '# TYPE latex_pdf_render_jobs gauge',
      ...Object.entries(renderCounts).map(
        ([state, count]) => `latex_pdf_render_jobs{state="${state}"} ${count}`,
      ),
      ...renderOperationalMetrics(),
    ].join('\n');
  });

  await registerProjectRoutes(app, context);
  await registerLibraryRoutes(app, context);
  await registerHistoryRoutes(app, context);
  await registerCompileRoutes(app, context);
  await registerTransferRoutes(app, context);
  await registerTemplateRoutes(app, context);
  await registerPreferenceRoutes(app, context);
  await registerEditHistoryRoutes(app, context);
  await registerMcpRoutes(app, context);
  await registerAgentProposalRoutes(app, context);
  const stopMaintenance =
    config.NODE_ENV === 'test' ? () => undefined : startMaintenance(context, app.log);

  app.setErrorHandler((error, request, reply) => {
    const postgresCode = findDatabaseCode(error);
    const errorRecord =
      typeof error === 'object' && error !== null
        ? (error as { statusCode?: unknown; validation?: unknown })
        : null;
    const validationError = errorRecord?.validation !== undefined;
    const clientStatusCode =
      typeof errorRecord?.statusCode === 'number' && errorRecord.statusCode < 500
        ? errorRecord.statusCode
        : null;
    const statusCode =
      error instanceof HttpError
        ? error.statusCode
        : postgresCode === '23505'
          ? 409
          : postgresCode === '23503'
            ? 400
            : validationError
              ? 400
              : clientStatusCode !== null
                ? clientStatusCode
                : 500;
    const code =
      error instanceof HttpError
        ? error.code
        : postgresCode === '23505'
          ? 'CONFLICT'
          : postgresCode === '23503'
            ? 'INVALID_REFERENCE'
            : validationError
              ? 'VALIDATION_ERROR'
              : 'INTERNAL_ERROR';
    if (statusCode >= 500) request.log.error(error);
    reply.code(statusCode).send({
      error: {
        code,
        message:
          statusCode >= 500
            ? 'An unexpected error occurred'
            : postgresCode === '23505'
              ? 'An item with that name already exists'
              : postgresCode === '23503'
                ? 'A referenced item does not exist'
                : error instanceof Error
                  ? error.message
                  : 'The request could not be processed',
        ...(error instanceof HttpError && error.details !== undefined
          ? { details: error.details }
          : {}),
        requestId: request.id,
      },
    });
  });

  app.addHook('onClose', async () => {
    stopMaintenance();
    await context.queue.close();
    await context.pdfRenderQueue.close();
    await context.redis.quit();
    await context.client.end();
  });
  return { app, config, context };
}

function findDatabaseCode(error: unknown): string | undefined {
  let cursor = error as { code?: unknown; cause?: unknown } | undefined;
  for (let depth = 0; cursor && depth < 5; depth += 1) {
    if (typeof cursor.code === 'string' && /^23\d{3}$/.test(cursor.code)) return cursor.code;
    cursor = cursor.cause as typeof cursor;
  }
  return undefined;
}

if (process.env.NODE_ENV !== 'test') {
  const { app, config } = await buildServer();
  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await app.listen({ host: '0.0.0.0', port: config.API_PORT });
}
