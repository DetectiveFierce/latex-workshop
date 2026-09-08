import type { AgentProposalStatus } from '@latex-workshop/contracts';

export function isActiveProposalStatus(status: AgentProposalStatus): boolean {
  return status !== 'resolved' && status !== 'rejected';
}

export function canDiscardProposal(status: AgentProposalStatus, busy: boolean): boolean {
  return !busy && isActiveProposalStatus(status);
}

export function canDiscardDraftChange(status: AgentProposalStatus): boolean {
  return status === 'draft' || status === 'needs_rebase';
}
