import { describe, expect, it } from 'vitest';
import {
  canDiscardDraftChange,
  canDiscardProposal,
  isActiveProposalStatus,
} from './proposalActiveState';

describe('activeProposalAfterMutation', () => {
  it.each(['draft', 'needs_rebase', 'reviewing'] as const)(
    'keeps an unresolved %s proposal active',
    (status) => expect(isActiveProposalStatus(status)).toBe(true),
  );

  it.each(['resolved', 'rejected'] as const)(
    'removes a proposal immediately after an all-changes %s decision',
    (status) => expect(isActiveProposalStatus(status)).toBe(false),
  );

  it('always leaves an owner escape hatch for unfinished proposals', () => {
    expect(canDiscardProposal('draft', false)).toBe(true);
    expect(canDiscardProposal('needs_rebase', false)).toBe(true);
    expect(canDiscardProposal('reviewing', false)).toBe(true);
    expect(canDiscardProposal('draft', true)).toBe(false);
    expect(canDiscardProposal('resolved', false)).toBe(false);
    expect(canDiscardDraftChange('draft')).toBe(true);
    expect(canDiscardDraftChange('needs_rebase')).toBe(true);
    expect(canDiscardDraftChange('reviewing')).toBe(false);
  });
});
