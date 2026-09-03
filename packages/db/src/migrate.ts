import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { loadDotEnv } from '@latex-workshop/config';
import { createDatabase } from './index.js';
import { fileURLToPath } from 'node:url';

loadDotEnv();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const { db, client } = createDatabase(databaseUrl);
await migrate(db, { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
await client.end();
