import { betterAuth, type BetterAuthPlugin } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { jwt } from 'better-auth/plugins';
import { mcp } from '@better-auth/mcp';
import { cimd } from '@better-auth/cimd';
import { fetchClientMetadataResource } from '@better-auth/cimd/node';
import nodemailer from 'nodemailer';
import type { AppConfig } from '@latex-workshop/config';
import type { Database } from '@latex-workshop/db';
import {
  accounts,
  jwks,
  oauthAccessTokens,
  oauthClientAssertions,
  oauthClientResources,
  oauthClients,
  oauthConsents,
  oauthRefreshTokens,
  oauthResources,
  projectMemberships,
  projects,
  sessions,
  users,
  verifications,
} from '@latex-workshop/db';
import type { ObjectStorage } from '@latex-workshop/storage';
import { eq, inArray } from 'drizzle-orm';
import {
  publicAppPageUrl,
  publicAuthBasePath,
  publicMcpResourceUrl,
} from './public-request-url.js';

export function createAuth(db: Database, storage: ObjectStorage, config: AppConfig) {
  const publicApiUrl = new URL(config.API_ORIGIN);
  const agentMcpResource = config.AGENT_MCP_RESOURCE_URL ?? publicMcpResourceUrl(config.API_ORIGIN);
  const mailer = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: false,
  });
  const send = async (to: string, subject: string, text: string) => {
    await mailer.sendMail({ from: config.SMTP_FROM, to, subject, text }).catch((error) => {
      console.error({ error }, 'Unable to send authentication email');
    });
  };

  return betterAuth({
    appName: 'LaTeX Workshop',
    baseURL: publicApiUrl.origin,
    basePath: publicAuthBasePath(config.API_ORIGIN),
    secret: config.AUTH_SECRET,
    trustedOrigins: [config.WEB_ORIGIN],
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: {
        user: users,
        session: sessions,
        account: accounts,
        verification: verifications,
        jwks,
        oauthClient: oauthClients,
        oauthResource: oauthResources,
        oauthClientResource: oauthClientResources,
        oauthRefreshToken: oauthRefreshTokens,
        oauthAccessToken: oauthAccessTokens,
        oauthConsent: oauthConsents,
        oauthClientAssertion: oauthClientAssertions,
      },
    }),
    // OAuth Provider 1.7.2's generated endpoint metadata is structurally wider than the
    // Better Auth 1.7.2 plugin type even though both packages share the same runtime ABI.
    plugins: (config.AGENT_MCP_ENABLED
      ? [
          jwt(),
          mcp({
            loginPage: publicAppPageUrl(config.WEB_ORIGIN, config.API_ORIGIN, '/auth'),
            consentPage: publicAppPageUrl(config.WEB_ORIGIN, config.API_ORIGIN, '/oauth/consent'),
            resource: agentMcpResource,
            scopes: ['openid', 'profile', 'offline_access', 'projects:read', 'proposals:write'],
            allowDynamicClientRegistration: config.AGENT_MCP_DCR_ENABLED,
            allowUnauthenticatedClientRegistration: config.AGENT_MCP_DCR_ENABLED,
            clientRegistrationDefaultScopes: ['openid', 'profile', 'offline_access'],
            clientRegistrationAllowedScopes: ['projects:read', 'proposals:write'],
            clientRegistrationRequirePKCE: true,
            allowPublicClientPrelogin: true,
            accessTokenExpiresIn: config.AGENT_MCP_ACCESS_TOKEN_TTL_SECONDS,
            // Refresh rotation keeps active harnesses connected without making access tokens
            // themselves long-lived. The owner can revoke every device from Account settings.
            refreshTokenExpiresIn: config.AGENT_MCP_REFRESH_TOKEN_TTL_DAYS * 86_400,
            refreshTokenReuseInterval: 30,
          }),
          cimd({
            fetchClientMetadataResource,
            metadataProfile: 'mcp-2026-07-28',
            metadataFetchPolicy: {
              minimumFetchInterval: 1,
              maximumConcurrentFetches: 16,
              maximumConcurrentFetchesPerOrigin: 4,
              maximumFetchesPerMinute: 120,
              maximumFetchesPerOriginPerMinute: 30,
            },
          }),
        ]
      : []) as BetterAuthPlugin[],
    advanced: {
      useSecureCookies: config.NODE_ENV === 'production',
      ipAddress: { ipAddressHeaders: ['x-client-ip'] },
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: ({ user, url }) =>
        send(user.email, 'Reset your LaTeX Workshop password', `Reset your password: ${url}`),
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: ({ user, url }) =>
        send(user.email, 'Verify your LaTeX Workshop account', `Verify your email: ${url}`),
    },
    user: {
      deleteUser: { enabled: true },
      changeEmail: { enabled: true },
    },
    databaseHooks: {
      user: {
        delete: {
          before: async (user) => {
            const owned = await db
              .select({ id: projects.id })
              .from(projects)
              .innerJoin(projectMemberships, eq(projectMemberships.projectId, projects.id))
              .where(eq(projectMemberships.userId, user.id));
            await Promise.all([
              storage.deletePrefix(`proposals/${user.id}/`),
              ...owned.flatMap(({ id }) => [
                storage.deletePrefix(`artifacts/${id}/`),
                storage.deletePrefix(`edit-history/${id}/`),
              ]),
            ]);
            if (owned.length)
              await db.delete(projects).where(
                inArray(
                  projects.id,
                  owned.map(({ id }) => id),
                ),
              );
          },
        },
      },
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 30,
      customRules: {
        '/get-session': { window: 60, max: 300 },
        '/oauth2/register': { window: 60, max: 10 },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
