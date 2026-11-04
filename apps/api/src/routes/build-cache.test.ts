import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../lib/context.js';
import { requireUser } from '../lib/context.js';
import { requireProject } from '../lib/domain.js';
import { clearProjectSyncArtifacts } from '../lib/synctex-artifacts.js';
import { registerCompileRoutes } from './compiles.js';

vi.mock('../lib/context.js', () => ({ requireUser: vi.fn() }));
vi.mock('../lib/domain.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/domain.js')>()),
  requireProject: vi.fn(),
}));
vi.mock('../lib/synctex-artifacts.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/synctex-artifacts.js')>()),
  clearProjectSyncArtifacts: vi.fn(),
}));
const id = '00000000-0000-4000-8000-000000000001';
afterEach(() => {
  vi.resetAllMocks();
});
describe('clear project build metadata', () => {
  async function fixture() {
    const app = Fastify();
    const context = { db: {}, storage: {} } as unknown as AppContext;
    await registerCompileRoutes(app, context);
    return { app, context };
  }
  it('checks session and project ownership before evicting any metadata', async () => {
    const { app, context } = await fixture();
    vi.mocked(requireUser).mockResolvedValue({ id: 'owner' } as Awaited<
      ReturnType<typeof requireUser>
    >);
    vi.mocked(clearProjectSyncArtifacts).mockReturnValue({
      clearedEntries: 2,
      invalidatedInFlight: 1,
    });
    const reply = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${id}/build-cache/clear`,
    });
    expect(reply.statusCode).toBe(200);
    expect(requireProject).toHaveBeenCalledWith(context.db, 'owner', id);
    expect(clearProjectSyncArtifacts).toHaveBeenCalledWith(context.storage, id);
    expect(reply.json()).toEqual({
      clearedEntries: 2,
      invalidatedInFlight: 1,
      compilationDirectories: 'ephemeral',
    });
    await app.close();
  });
  it('does not evict for missing memberships or unauthenticated requests', async () => {
    const { app } = await fixture();
    vi.mocked(requireUser).mockRejectedValueOnce(
      Object.assign(new Error('Unauthorized'), { statusCode: 401 }),
    );
    expect(
      (await app.inject({ method: 'POST', url: `/api/v1/projects/${id}/build-cache/clear` }))
        .statusCode,
    ).toBe(401);
    expect(requireProject).not.toHaveBeenCalled();
    vi.mocked(requireUser).mockResolvedValue({ id: 'other' } as Awaited<
      ReturnType<typeof requireUser>
    >);
    vi.mocked(requireProject).mockRejectedValueOnce(
      Object.assign(new Error('Not found'), { statusCode: 404 }),
    );
    expect(
      (await app.inject({ method: 'POST', url: `/api/v1/projects/${id}/build-cache/clear` }))
        .statusCode,
    ).toBe(404);
    expect(clearProjectSyncArtifacts).not.toHaveBeenCalled();
    await app.close();
  });
  it('rejects malformed project IDs without accessing the cache', async () => {
    const { app } = await fixture();
    vi.mocked(requireUser).mockResolvedValue({ id: 'owner' } as Awaited<
      ReturnType<typeof requireUser>
    >);
    const reply = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/not-a-uuid/build-cache/clear',
    });
    expect(reply.statusCode).toBe(400);
    expect(requireProject).not.toHaveBeenCalled();
    expect(clearProjectSyncArtifacts).not.toHaveBeenCalled();
    await app.close();
  });
});
