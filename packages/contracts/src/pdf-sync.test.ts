import { describe, expect, it } from 'vitest';
import { forwardSyncRequestSchema, inverseSyncRequestSchema } from './pdf-sync.js';

describe('SyncTeX source identity', () => {
  it('defaults legacy accepted-head requests to the accepted source', () => {
    const request = inverseSyncRequestSchema.parse({ page: 1, x: 10, y: 20 });
    expect(request.source).toEqual({ target: 'accepted' });
  });

  it('preserves immutable proposal provenance', () => {
    const proposalId = '11111111-1111-4111-8111-111111111111';
    const request = forwardSyncRequestSchema.parse({
      path: 'main.tex',
      selection: {
        start: { line: 1, column: 1 },
        end: { line: 1, column: 1 },
      },
      entryVersion: 2,
      source: { target: 'proposal', proposalId, proposalRevision: 7 },
    });
    expect(request.source).toEqual({ target: 'proposal', proposalId, proposalRevision: 7 });
  });

  it('rejects a proposal source without a revision', () => {
    expect(() =>
      inverseSyncRequestSchema.parse({
        page: 1,
        x: 10,
        y: 20,
        source: {
          target: 'proposal',
          proposalId: '11111111-1111-4111-8111-111111111111',
        },
      }),
    ).toThrow();
  });
});
