import type { FastifyRequest } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { AppConfig } from '@latex-workshop/config';
import { createDatabase } from '@latex-workshop/db';
import { ObjectStorage } from '@latex-workshop/storage';
import { createAuth } from './auth.js';
import { HttpError } from './errors.js';

export function createContext(config: AppConfig) {
  const database = createDatabase(config.DATABASE_URL);
  const storage = new ObjectStorage(config);
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  const queue = new Queue('latex-compiles', { connection: redis });
  const auth = createAuth(database.db, storage, config);
  return { config, ...database, storage, redis, queue, auth };
}

export type AppContext = ReturnType<typeof createContext>;

export async function requireUser(context: AppContext, request: FastifyRequest) {
  return (await requireSession(context, request)).user;
}

export async function requireSession(context: AppContext, request: FastifyRequest) {
  const session = await context.auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
  if (!session) throw new HttpError(401, 'UNAUTHORIZED', 'Please sign in to continue');
  return session;
}
