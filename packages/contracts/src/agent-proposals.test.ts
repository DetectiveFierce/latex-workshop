import { describe, expect, it } from 'vitest';
import {
  allProposalItemsAccepted,
  agentPdfPageLimits,
  agentPdfPageRequestSchema,
  agentProposalLimits,
  checkpointManifestSchema,
  createAgentProjectSchema,
  putAgentConnectionGrantSchema,
  putAgentProposalFileSchema,
  putOwnerProposalFileSchema,
  readTextFileSchema,
  renameAgentProjectSchema,
  reviseAgentProposalHunkSchema,
} from './index.js';

const legacy = {
  entryId: '11111111-1111-4111-8111-111111111111',
  path: 'main.tex',
  versionId: '22222222-2222-4222-8222-222222222222',
  blobHash: 'a'.repeat(64),
  objectKey: 'blobs/aa/hash',
  size: 12,
  mimeType: 'text/x-tex',
};

describe('agent proposal contracts', () => {
  it('identifies a proposal whose complete output was accepted', () => {
    const textChange = {
      operation: 'replace_file' as const,
      decision: 'pending' as const,
      hunks: [{ decision: 'accepted' as const }],
    };
    const folderChange = {
      operation: 'create_folder' as const,
      decision: 'accepted' as const,
      hunks: [],
    };

    expect(allProposalItemsAccepted([textChange, folderChange])).toBe(true);
    expect(
      allProposalItemsAccepted([{ ...textChange, hunks: [{ decision: 'rejected' as const }] }]),
    ).toBe(false);
    expect(allProposalItemsAccepted([{ ...folderChange, decision: 'rejected' as const }])).toBe(
      false,
    );
  });

  it('reads both historical and proposal checkpoint manifest entries', () => {
    expect(checkpointManifestSchema.parse([legacy])).toHaveLength(1);
    expect(
      checkpointManifestSchema.parse([
        {
          ...legacy,
          versionId: null,
          source: {
            kind: 'proposal',
            proposalId: '33333333-3333-4333-8333-333333333333',
            revision: 4,
            contentHash: 'b'.repeat(64),
          },
        },
      ])[0]?.source?.kind,
    ).toBe('proposal');
    expect(() =>
      checkpointManifestSchema.parse([
        {
          ...legacy,
          source: {
            kind: 'proposal',
            proposalId: '33333333-3333-4333-8333-333333333333',
            revision: 4,
            contentHash: 'b'.repeat(64),
          },
        },
      ]),
    ).toThrow();
  });

  it('enforces independent proposal write and read limits', () => {
    expect(() =>
      putAgentProposalFileSchema.parse({
        expectedProposalRevision: 0,
        idempotencyKey: '44444444-4444-4444-8444-444444444444',
        path: 'main.tex',
        content: 'x'.repeat(agentProposalLimits.maxFileBytes + 1),
      }),
    ).toThrow();
    expect(() =>
      readTextFileSchema.parse({
        projectId: legacy.entryId,
        path: legacy.path,
        limit: agentProposalLimits.maxReadBytes + 1,
      }),
    ).toThrow();
    expect(() =>
      putOwnerProposalFileSchema.parse({
        expectedProposalRevision: 1,
        path: 'main.tex',
        content: 'x'.repeat(agentProposalLimits.maxFileBytes + 1),
      }),
    ).toThrow();
    expect(
      putAgentConnectionGrantSchema.parse({
        clientId: 'pi-agent',
        projectIds: [],
        allProjects: true,
      }).allProjects,
    ).toBe(true);
    expect(
      putAgentConnectionGrantSchema.parse({
        clientId: 'pi-agent',
        projectIds: [legacy.entryId],
      }).allProjects,
    ).toBe(false);
    expect(() =>
      reviseAgentProposalHunkSchema.parse({
        expectedProposalRevision: 1,
        replacementText: 'x'.repeat(agentProposalLimits.maxFileBytes + 1),
      }),
    ).toThrow();
  });

  it('validates agent project creation and rename requests', () => {
    expect(
      createAgentProjectSchema.parse({
        name: '  Homework  ',
        sourceProjectId: legacy.entryId,
        isTemplate: true,
        idempotencyKey: '55555555-5555-4555-8555-555555555555',
      }),
    ).toEqual({
      name: 'Homework',
      sourceProjectId: legacy.entryId,
      isTemplate: true,
      idempotencyKey: '55555555-5555-4555-8555-555555555555',
    });
    expect(
      createAgentProjectSchema.parse({
        name: 'Blank',
        idempotencyKey: '66666666-6666-4666-8666-666666666666',
      }).isTemplate,
    ).toBe(false);
    expect(
      renameAgentProjectSchema.parse({
        projectId: legacy.entryId,
        name: ' Renamed ',
        idempotencyKey: '77777777-7777-4777-8777-777777777777',
      }).name,
    ).toBe('Renamed');
  });

  it('bounds and deduplicates compiled PDF page-image requests', () => {
    const request = {
      proposalId: '88888888-8888-4888-8888-888888888888',
      compileJobId: '99999999-9999-4999-8999-999999999999',
      pages: [1, 3],
    };
    expect(agentPdfPageRequestSchema.parse(request).pages).toEqual([1, 3]);
    expect(() => agentPdfPageRequestSchema.parse({ ...request, pages: [1, 1] })).toThrow();
    expect(() =>
      agentPdfPageRequestSchema.parse({
        ...request,
        pages: Array.from({ length: agentPdfPageLimits.maxPagesPerRequest + 1 }, (_, i) => i + 1),
      }),
    ).toThrow();
  });
});
