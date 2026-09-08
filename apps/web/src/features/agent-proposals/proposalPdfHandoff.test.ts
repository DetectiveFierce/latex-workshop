import { describe, expect, it } from 'vitest';
import type { AgentProposal, CompileJob } from '@latex-workshop/contracts';
import { preserveFullyAcceptedProposalCompile } from './proposalPdfHandoff';

const proposalId = '11111111-1111-4111-8111-111111111111';
const compileId = '22222222-2222-4222-8222-222222222222';

const compile: CompileJob = {
  id: compileId,
  projectId: '33333333-3333-4333-8333-333333333333',
  checkpointId: '44444444-4444-4444-8444-444444444444',
  sourceRevision: 7,
  engine: 'pdflatex',
  status: 'succeeded',
  trigger: 'agent',
  target: 'proposal',
  proposalId,
  proposalRevision: 3,
  log: '',
  diagnostics: [],
  durationMs: 100,
  createdAt: '2026-09-07T00:00:00.000Z',
  startedAt: '2026-09-07T00:00:00.000Z',
  finishedAt: '2026-09-07T00:00:01.000Z',
};

const proposal: AgentProposal = {
  id: proposalId,
  projectId: compile.projectId,
  clientId: 'codex',
  clientName: 'Codex',
  title: 'Update document',
  status: 'resolved',
  revision: 4,
  changedEntryCount: 1,
  totalBytes: 10,
  conflicts: [],
  changes: [
    {
      id: '55555555-5555-4555-8555-555555555555',
      operation: 'replace_file',
      entryId: '66666666-6666-4666-8666-666666666666',
      entryKind: 'file',
      basePath: 'main.tex',
      targetPath: 'main.tex',
      baseVersion: 1,
      baseHash: 'a'.repeat(64),
      contentHash: 'b'.repeat(64),
      size: 10,
      decision: 'pending',
      hunks: [
        {
          id: '77777777-7777-4777-8777-777777777777',
          changeId: '55555555-5555-4555-8555-555555555555',
          baseStart: 0,
          baseEnd: 1,
          baseText: 'a',
          replacementText: 'b',
          contentHash: 'c'.repeat(64),
          decision: 'accepted',
          order: 0,
        },
      ],
    },
  ],
  compileJobId: compileId,
  createdAt: '2026-09-07T00:00:00.000Z',
  updatedAt: '2026-09-07T00:00:02.000Z',
};

describe('proposal PDF handoff', () => {
  it('preserves the successful compilation id when every edit is accepted', () => {
    const [preserved] = preserveFullyAcceptedProposalCompile([compile], proposal);

    expect(preserved).toMatchObject({
      id: compileId,
      target: 'accepted',
      proposalId: null,
      proposalRevision: null,
    });
  });

  it('does not promote a preview when any edit was rejected', () => {
    const rejected = {
      ...proposal,
      changes: proposal.changes.map((change) => ({
        ...change,
        hunks: change.hunks.map((hunk) => ({ ...hunk, decision: 'rejected' as const })),
      })),
    };

    expect(preserveFullyAcceptedProposalCompile([compile], rejected)).toEqual([compile]);
  });
});
