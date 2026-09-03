import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import {
  migrateLegacyShortcutOverrides,
  putKeyboardShortcutsSchema,
  type KeyboardKeymap,
} from '@latex-workshop/contracts';
import { userPreferences } from '@latex-workshop/db';
import { requireUser, type AppContext } from '../lib/context.js';
import { badRequest } from '../lib/errors.js';

export async function registerPreferenceRoutes(app: FastifyInstance, context: AppContext) {
  app.get('/api/v1/preferences/keyboard-shortcuts', async (request) => {
    const user = await requireUser(context, request);
    const [preferences] = await context.db
      .select()
      .from(userPreferences)
      .where(eq(userPreferences.userId, user.id))
      .limit(1);
    const keymap = preferences?.keyboardKeymap === 'macos' ? 'macos' : 'linux';
    return {
      version: 2 as const,
      keymap,
      overrides: migrateLegacyShortcutOverrides(preferences?.keyboardShortcutOverrides),
      updatedAt: preferences?.updatedAt.toISOString() ?? null,
    };
  });

  app.put('/api/v1/preferences/keyboard-shortcuts', async (request) => {
    const user = await requireUser(context, request);
    const parsed = putKeyboardShortcutsSchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest('Invalid keyboard shortcut overrides', parsed.error.flatten());
    }
    let keymap: KeyboardKeymap;
    let overrides;
    if ('keymap' in parsed.data) {
      keymap = parsed.data.keymap;
      overrides = parsed.data.overrides;
    } else {
      keymap = 'linux';
      overrides = migrateLegacyShortcutOverrides(parsed.data.overrides);
    }
    const [preferences] = await context.db
      .insert(userPreferences)
      .values({
        userId: user.id,
        keyboardKeymap: keymap,
        keyboardShortcutOverrides: overrides,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: userPreferences.userId,
        set: {
          keyboardKeymap: keymap,
          keyboardShortcutOverrides: overrides,
          updatedAt: new Date(),
        },
      })
      .returning();
    return {
      version: 2 as const,
      keymap: preferences!.keyboardKeymap === 'macos' ? 'macos' : 'linux',
      overrides: migrateLegacyShortcutOverrides(preferences!.keyboardShortcutOverrides),
      updatedAt: preferences!.updatedAt.toISOString(),
    };
  });
}
