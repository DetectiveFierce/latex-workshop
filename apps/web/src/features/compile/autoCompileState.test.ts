import { describe, expect, it } from 'vitest';
import type { CompileJob } from '@latex-workshop/contracts';
import {
  autoCompileTargetKey,
  decideAutoCompile,
  effectivePreviewTarget,
  latestCompileForPreview,
  selectAutoCompileTarget,
  successfulCompileForPreview,
  type AutoCompileTarget,
} from './autoCompileState';

const accepted: AutoCompileTarget = { target: 'accepted', revision: 12 };
const proposal: AutoCompileTarget = {
  target: 'proposal',
  proposalId: '11111111-1111-4111-8111-111111111111',
  revision: 7,
};

function job(overrides: Partial<CompileJob>): CompileJob {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    projectId: '33333333-3333-4333-8333-333333333333',
    checkpointId: '44444444-4444-4444-8444-444444444444',
    sourceRevision: 11,
    engine: 'pdflatex',
    status: 'succeeded',
    trigger: 'auto',
    target: 'accepted',
    proposalId: null,
    proposalRevision: null,
    diagnostics: [],
    log: '',
    durationMs: null,
    createdAt: new Date(0).toISOString(),
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

describe('auto compile decisions', () => {
  it('keeps proposal-only projects on their compilable source', () => {
    expect(
      effectivePreviewTarget({
        preferredTarget: 'accepted',
        acceptedSourceAvailable: false,
        proposalId: proposal.proposalId,
      }),
    ).toBe('proposal');
    expect(
      effectivePreviewTarget({
        preferredTarget: 'accepted',
        acceptedSourceAvailable: true,
        proposalId: proposal.proposalId,
      }),
    ).toBe('accepted');
    expect(
      effectivePreviewTarget({
        preferredTarget: 'proposal',
        acceptedSourceAvailable: false,
        proposalId: null,
      }),
    ).toBe('accepted');
  });

  it('shows diagnostics from the selected source instead of the newest unrelated job', () => {
    const acceptedFailure = job({ status: 'failed', diagnostics: [] });
    const proposalSuccess = job({
      id: '55555555-5555-4555-8555-555555555555',
      target: 'proposal',
      proposalId: proposal.proposalId,
      proposalRevision: proposal.revision,
    });
    const jobs = [acceptedFailure, proposalSuccess];
    expect(latestCompileForPreview(jobs, 'proposal', proposal.proposalId)).toBe(proposalSuccess);
    expect(latestCompileForPreview(jobs, 'accepted', proposal.proposalId)).toBe(acceptedFailure);
  });

  it('only exposes a PDF compiled from the current proposal revision', () => {
    const acceptedSuccess = job({ sourceRevision: 12 });
    const staleProposalSuccess = job({
      id: '55555555-5555-4555-8555-555555555555',
      target: 'proposal',
      proposalId: proposal.proposalId,
      proposalRevision: proposal.revision - 1,
    });
    const jobs = [staleProposalSuccess, acceptedSuccess];

    expect(
      successfulCompileForPreview({
        jobs,
        target: 'proposal',
        proposalId: proposal.proposalId,
        proposalRevision: proposal.revision,
        compileJobId: staleProposalSuccess.id,
        acceptedFallback: acceptedSuccess,
      }),
    ).toBeNull();
    expect(
      successfulCompileForPreview({
        jobs: [
          job({
            id: '66666666-6666-4666-8666-666666666666',
            target: 'proposal',
            proposalId: proposal.proposalId,
            proposalRevision: proposal.revision,
          }),
          ...jobs,
        ],
        target: 'proposal',
        proposalId: proposal.proposalId,
        proposalRevision: proposal.revision,
        compileJobId: '66666666-6666-4666-8666-666666666666',
        acceptedFallback: acceptedSuccess,
      })?.proposalRevision,
    ).toBe(proposal.revision);
  });

  it('compiles the viewed stale target first and trails the other stale source', () => {
    const input = {
      preferredTarget: 'proposal' as const,
      acceptedRevision: 12,
      acceptedCompiledRevision: 11,
      proposal: {
        id: proposal.proposalId,
        revision: 7,
        compiledRevision: 6,
      },
    };
    expect(selectAutoCompileTarget(input)).toEqual(proposal);
    expect(
      selectAutoCompileTarget({
        ...input,
        proposal: { ...input.proposal, compiledRevision: 7 },
      }),
    ).toEqual(accepted);
    expect(
      selectAutoCompileTarget({ ...input, acceptedCompiledRevision: 12, proposal: null }),
    ).toBeNull();
  });

  it('does not repeat work already queued, running, or completed for the target revision', () => {
    for (const status of ['queued', 'running', 'succeeded'] as const) {
      expect(decideAutoCompile(accepted, [job({ sourceRevision: 12, status })], null)).toBe(
        'covered',
      );
    }
  });

  it('waits for an older active compile and then requests the trailing revision', () => {
    expect(decideAutoCompile(accepted, [job({ status: 'running' })], null)).toBe('wait');
    expect(decideAutoCompile(accepted, [job({ status: 'succeeded' })], null)).toBe('compile');
  });

  it('keys proposal revisions independently from accepted source revisions', () => {
    expect(autoCompileTargetKey(proposal)).toBe('proposal:11111111-1111-4111-8111-111111111111:7');
    expect(
      decideAutoCompile(
        proposal,
        [
          job({
            target: 'proposal',
            proposalId: proposal.proposalId,
            proposalRevision: 7,
          }),
        ],
        null,
      ),
    ).toBe('covered');
  });

  it('suppresses automatic retry loops after one failed request for the same revision', () => {
    expect(decideAutoCompile(accepted, [], autoCompileTargetKey(accepted))).toBe('covered');
    expect(
      decideAutoCompile({ target: 'accepted', revision: 13 }, [], autoCompileTargetKey(accepted)),
    ).toBe('compile');
  });
});
