import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import nodemailer from 'nodemailer';
import type { AppConfig } from '@latex-workshop/config';
import type { Database } from '@latex-workshop/db';
import {
  accounts,
  projectMemberships,
  projects,
  sessions,
  users,
  verifications,
} from '@latex-workshop/db';
import type { ObjectStorage } from '@latex-workshop/storage';
import { eq, inArray } from 'drizzle-orm';
import { publicAuthBasePath } from './public-request-url.js';

export function createAuth(db: Database, storage: ObjectStorage, config: AppConfig) {
  const publicApiUrl = new URL(config.API_ORIGIN);
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
            await Promise.all(
              owned.flatMap(({ id }) => [
                storage.deletePrefix(`artifacts/${id}/`),
                storage.deletePrefix(`edit-history/${id}/`),
              ]),
            );
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
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
