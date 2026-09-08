import { describe, expect, it } from 'vitest';
import { agentProposalLimits } from '@latex-workshop/contracts';
import { HttpError } from './errors.js';
import {
  assertProposalRevision,
  assertProposalWriteLimits,
  canAgentMutateProposal,
  canAgentReviseProposal,
  canOwnerReviseAddition,
  canOwnerDiscardDraftChange,
  canOwnerDiscardProposal,
  checkpointContentMatches,
  compileArtifactObjectKeys,
  hasCaseInsensitivePathCollision,
  hunkDecisionAfterReplacement,
  isStaleProposalCompile,
  isOAuthTokenAfterRevocation,
  nextProposalByteTotal,
  proposalFileBase,
  queuedProposalCompile,
  shouldResetFrozenProposalReview,
} from './agent-proposal-policy.js';

describe('agent proposal policy', () => {
  it('allows feedback revisions while keeping finish-only states narrow', () => {
    expect(canAgentMutateProposal('draft')).toBe(true);
    expect(canAgentMutateProposal('needs_rebase')).toBe(true);
    expect(canAgentMutateProposal('reviewing')).toBe(false);
    expect(canAgentReviseProposal('draft')).toBe(true);
    expect(canAgentReviseProposal('needs_rebase')).toBe(true);
    expect(canAgentReviseProposal('reviewing')).toBe(true);
    expect(canAgentReviseProposal('resolved')).toBe(false);
    expect(shouldResetFrozenProposalReview('reviewing')).toBe(true);
    expect(shouldResetFrozenProposalReview('draft')).toBe(false);
    expect(canOwnerReviseAddition('reviewing')).toBe(true);
    expect(canOwnerReviseAddition('draft')).toBe(false);
    expect(canOwnerReviseAddition('resolved')).toBe(false);
    expect(canOwnerDiscardProposal('draft')).toBe(true);
    expect(canOwnerDiscardProposal('needs_rebase')).toBe(true);
    expect(canOwnerDiscardProposal('reviewing')).toBe(true);
    expect(canOwnerDiscardProposal('resolved')).toBe(false);
    expect(canOwnerDiscardDraftChange('draft')).toBe(true);
    expect(canOwnerDiscardDraftChange('needs_rebase')).toBe(true);
    expect(canOwnerDiscardDraftChange('reviewing')).toBe(false);
  });

  it('revises an addition without changing its decision', () => {
    expect(hunkDecisionAfterReplacement('pending')).toBe('pending');
    expect(hunkDecisionAfterReplacement('conflicted')).toBe('conflicted');
    expect(hunkDecisionAfterReplacement('accepted')).toBe('accepted');
  });

  it('refreshes the accepted base when a proposed file is overwritten', () => {
    expect(
      proposalFileBase(
        { id: 'entry', version: 7, currentVersionId: 'version-7' },
        'template.tex',
        'hash-7',
      ),
    ).toEqual({
      entryId: 'entry',
      operation: 'replace_file',
      basePath: 'template.tex',
      baseVersion: 7,
      baseVersionId: 'version-7',
      baseHash: 'hash-7',
    });
  });

  it('enforces CAS, size, and case-insensitive path collisions', () => {
    expect(() => assertProposalRevision(3, 2, 'proposal')).toThrow(HttpError);
    expect(nextProposalByteTotal(100, 40, 70)).toBe(130);
    expect(() =>
      assertProposalWriteLimits({
        fileBytes: agentProposalLimits.maxFileBytes + 1,
        nextTotalBytes: 1,
        changedEntries: 1,
      }),
    ).toThrow(HttpError);
    expect(() =>
      assertProposalWriteLimits({
        fileBytes: 1,
        nextTotalBytes: agentProposalLimits.maxProposalBytes + 1,
        changedEntries: 1,
      }),
    ).toThrow(HttpError);
    expect(() =>
      assertProposalWriteLimits({
        fileBytes: 1,
        nextTotalBytes: 1,
        changedEntries: agentProposalLimits.maxChangedEntries + 1,
      }),
    ).toThrow(HttpError);
    expect(hasCaseInsensitivePathCollision(['Main.tex'], 'main.tex')).toBe(true);
    expect(hasCaseInsensitivePathCollision(['notes.tex'], 'main.tex')).toBe(false);
  });

  it('queues compile by proposal revision and isolates proposal PDFs', () => {
    expect(queuedProposalCompile('proposal-1', 4)).toEqual({
      proposalId: 'proposal-1',
      expectedRevision: 4,
    });
    expect(
      isStaleProposalCompile(
        { target: 'proposal', proposalId: 'proposal-1', proposalRevision: 3 },
        { revision: 4 },
      ),
    ).toBe(true);
    expect(
      isStaleProposalCompile(
        { target: 'accepted', proposalId: null, proposalRevision: null },
        { revision: 4 },
      ),
    ).toBe(false);
    const accepted = compileArtifactObjectKeys('project-a', 'job-accepted');
    const proposal = compileArtifactObjectKeys('project-a', 'job-proposal');
    expect(accepted.pdf).not.toBe(proposal.pdf);
    expect(accepted.pdf).toContain('job-accepted');
    expect(proposal.pdf).toContain('job-proposal');
  });

  it('matches a proposal artifact to accepted content without relying on entry ids', () => {
    const accepted = [
      { path: 'main.tex', blobHash: 'a', size: 4, mimeType: 'text/x-tex' },
      { path: 'chapters/one.tex', blobHash: 'b', size: 8, mimeType: null },
    ];
    expect(checkpointContentMatches([...accepted].reverse(), accepted)).toBe(true);
    expect(
      checkpointContentMatches([{ ...accepted[0]!, blobHash: 'changed' }, accepted[1]!], accepted),
    ).toBe(false);
  });

  it('invalidates every access token issued at or before the revocation cutoff', () => {
    const revokedAt = new Date('2026-09-04T01:00:00.900Z');
    expect(isOAuthTokenAfterRevocation(1_788_483_599, revokedAt)).toBe(false);
    expect(isOAuthTokenAfterRevocation(1_788_483_600, revokedAt)).toBe(false);
    expect(isOAuthTokenAfterRevocation(1_788_483_601, revokedAt)).toBe(true);
    expect(isOAuthTokenAfterRevocation(undefined, revokedAt)).toBe(false);
    expect(isOAuthTokenAfterRevocation(undefined, null)).toBe(true);
  });
});
