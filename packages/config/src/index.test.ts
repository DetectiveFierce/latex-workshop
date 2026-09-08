import { describe, expect, it } from 'vitest';
import { loadConfig } from './index.js';

const base = {
  NODE_ENV: 'production',
  WEB_ORIGIN: 'https://workshop.example.com',
  API_ORIGIN: 'https://workshop.example.com',
  DATABASE_URL: 'postgres://app:secret@db/workshop',
  REDIS_URL: 'redis://redis:6379',
  S3_ENDPOINT: 'http://minio:9000',
  S3_PUBLIC_ENDPOINT: '',
  S3_ACCESS_KEY: 'access',
  S3_SECRET_KEY: 'secret',
  S3_FORCE_PATH_STYLE: 'false',
  AUTH_SECRET: 'a-production-secret-that-is-long-enough',
} satisfies NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('accepts an empty optional public S3 endpoint', () => {
    const config = loadConfig({ ...base });
    expect(config.S3_PUBLIC_ENDPOINT).toBeUndefined();
    expect(config.S3_FORCE_PATH_STYLE).toBe(false);
    expect(config.AGENT_MCP_ACCESS_TOKEN_TTL_SECONDS).toBe(3_600);
    expect(config.AGENT_MCP_REFRESH_TOKEN_TTL_DAYS).toBe(365);
  });

  it('rejects ambiguous boolean values', () => {
    expect(() => loadConfig({ ...base, S3_FORCE_PATH_STYLE: 'yes' })).toThrow();
  });

  it('rejects the development secret in production', () => {
    expect(() =>
      loadConfig({
        ...base,
        AUTH_SECRET: 'local-development-secret-change-before-production',
      }),
    ).toThrow('AUTH_SECRET');
  });

  it('requires public origins to use TLS in production', () => {
    expect(() => loadConfig({ ...base, WEB_ORIGIN: 'http://workshop.example.com' })).toThrow(
      'HTTPS',
    );
  });

  it('requires an HTTPS MCP resource when agent access is enabled in production', () => {
    expect(() => loadConfig({ ...base, AGENT_MCP_ENABLED: 'true' })).toThrow(
      'AGENT_MCP_RESOURCE_URL',
    );
    expect(() =>
      loadConfig({
        ...base,
        AGENT_MCP_ENABLED: 'true',
        AGENT_MCP_RESOURCE_URL: 'http://workshop.example.com/api/mcp',
      }),
    ).toThrow('HTTPS');
    expect(
      loadConfig({
        ...base,
        AGENT_MCP_ENABLED: 'true',
        AGENT_MCP_RESOURCE_URL: 'https://workshop.example.com/api/mcp',
      }).AGENT_MCP_ENABLED,
    ).toBe(true);
  });

  it.each([
    ['API_PORT', '0'],
    ['LSP_PORT', '65536'],
    ['SMTP_PORT', '1.5'],
    ['MAX_FILE_BYTES', String(Number.MAX_SAFE_INTEGER + 1)],
    ['AGENT_MCP_REFRESH_TOKEN_TTL_DAYS', '3651'],
  ])('rejects invalid bounded integer configuration for %s', (key, value) => {
    expect(() => loadConfig({ ...base, [key]: value })).toThrow();
  });
});
