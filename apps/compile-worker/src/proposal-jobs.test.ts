import { describe, expect, it } from 'vitest';
import { compileArtifactObjectKeys, isStaleProposalCompile } from './proposal-jobs.js';

describe('proposal compile jobs', () => {
  it('cancels stale proposal revisions and leaves accepted jobs alone', () => {
    expect(
      isStaleProposalCompile(
        { target: 'proposal', proposalId: 'p1', proposalRevision: 2 },
        { revision: 3 },
      ),
    ).toBe(true);
    expect(
      isStaleProposalCompile(
        { target: 'proposal', proposalId: 'p1', proposalRevision: 3 },
        { revision: 3 },
      ),
    ).toBe(false);
    expect(
      isStaleProposalCompile({ target: 'proposal', proposalId: 'p1', proposalRevision: 3 }, null),
    ).toBe(true);
    expect(
      isStaleProposalCompile(
        { target: 'accepted', proposalId: null, proposalRevision: null },
        { revision: 9 },
      ),
    ).toBe(false);
  });

  it('stores proposal PDFs under job-scoped keys so they cannot replace accepted artifacts', () => {
    const accepted = compileArtifactObjectKeys('project', 'accepted-job');
    const proposal = compileArtifactObjectKeys('project', 'proposal-job');
    expect(accepted.pdf).not.toBe(proposal.pdf);
    expect(accepted.pdf).toBe('artifacts/project/accepted-job/document.pdf');
    expect(proposal.pdf).toBe('artifacts/project/proposal-job/document.pdf');
  });
});
