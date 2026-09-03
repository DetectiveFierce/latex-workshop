import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export * from './schema.js';

export function createDatabase(url: string) {
  const client = postgres(url, { max: 10, prepare: false });
  return { db: drizzle(client, { schema }), client };
}

export type Database = ReturnType<typeof createDatabase>['db'];
export type DatabaseTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];
