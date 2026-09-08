import { describe, expect, it } from 'vitest';
import {
  agentProposalFileQuerySchema,
  putOwnerProposalFileSchema,
  reviseAgentProposalHunkSchema,
} from '@latex-workshop/contracts';
import { notFound } from '../lib/errors.js';
import {
  canAgentMutateProposal,
  canOwnerReviseAddition,
  canOwnerReviseProposalFile,
  hunkDecisionAfterReplacement,
} from '../lib/agent-proposal-policy.js';

describe('owner proposal routes', () => {
  it('requires a path for overlay GET and keeps addition-edit from deciding', () => {
    expect(() => agentProposalFileQuerySchema.parse({})).toThrow();
    expect(agentProposalFileQuerySchema.parse({ path: 'main.tex' }).path).toBe('main.tex');
    expect(
      putOwnerProposalFileSchema.parse({
        expectedProposalRevision: 2,
        path: 'main.tex',
        content: 'hello\n',
      }).path,
    ).toBe('main.tex');
    expect(
      reviseAgentProposalHunkSchema.parse({
        expectedProposalRevision: 4,
        replacementText: 'revised\n',
      }).replacementText,
    ).toBe('revised\n');
    expect(hunkDecisionAfterReplacement('pending')).toBe('pending');
  });

  it('freezes agent writes after review and uses identical 404s for missing grants', () => {
    expect(canAgentMutateProposal('reviewing')).toBe(false);
    expect(canOwnerReviseAddition('reviewing')).toBe(true);
    expect(canOwnerReviseAddition('draft')).toBe(false);
    expect(canOwnerReviseProposalFile('draft')).toBe(true);
    expect(canOwnerReviseProposalFile('needs_rebase')).toBe(true);
    expect(canOwnerReviseProposalFile('reviewing')).toBe(true);
    expect(canOwnerReviseProposalFile('resolved')).toBe(false);
    const missingGrant = notFound('Proposal not found');
    const missingFile = notFound('Proposal file not found');
    expect(missingGrant.statusCode).toBe(404);
    expect(missingFile.statusCode).toBe(404);
    expect(missingGrant.code).toBe(missingFile.code);
  });
});
