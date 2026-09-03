import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((value) => value === 'true');
const optionalUrl = z.preprocess((value) => (value === '' ? undefined : value), z.url().optional());
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  WEB_ORIGIN: z.url().default('http://localhost:5173'),
  API_ORIGIN: z.url().default('http://localhost:3001'),
  API_PORT: z.coerce.number().int().positive().default(3001),
  LSP_PORT: z.coerce.number().int().positive().default(3002),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  S3_ENDPOINT: z.url(),
  S3_PUBLIC_ENDPOINT: optionalUrl,
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('latex-workshop'),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: bool.default(true),
  AUTH_SECRET: z.string().min(32),
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().default(1025),
  SMTP_FROM: z.string().default('LaTeX Workshop <noreply@localhost>'),
  COMPILE_IMAGE: z.string().default('latex-workshop-texlive:latest'),
  COMPILE_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  MAX_PROJECTS_PER_USER: z.coerce.number().int().positive().default(250),
  MAX_USER_BYTES: z.coerce.number().int().positive().default(1_073_741_824),
  MAX_PROJECT_BYTES: z.coerce.number().int().positive().default(262_144_000),
  MAX_FILE_BYTES: z.coerce.number().int().positive().default(52_428_800),
  SESSION_IDLE_MS: z.coerce.number().int().positive().default(900_000),
});

export type AppConfig = z.infer<typeof envSchema>;

/** Load monorepo `.env` when services run from apps/* via turbo (cwd is not root). */
export function loadDotEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (typeof process.loadEnvFile !== 'function') return;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(process.cwd(), '.env'),
    resolve(process.cwd(), '../.env'),
    resolve(process.cwd(), '../../.env'),
    resolve(here, '../../../.env'), // packages/config/dist -> repo root
    resolve(here, '../../../../.env'), // packages/config/src via tsx
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      process.loadEnvFile(path);
      return;
    } catch {
      /* try next candidate */
    }
  }
  void env;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (env === process.env) loadDotEnv(env);
  const config = envSchema.parse(env);
  if (
    config.NODE_ENV === 'production' &&
    config.AUTH_SECRET === 'local-development-secret-change-before-production'
  )
    throw new Error('AUTH_SECRET must be replaced before running in production');
  if (
    config.NODE_ENV === 'production' &&
    [config.WEB_ORIGIN, config.API_ORIGIN].some((origin) => new URL(origin).protocol !== 'https:')
  )
    throw new Error('WEB_ORIGIN and API_ORIGIN must use HTTPS in production');
  return config;
}
