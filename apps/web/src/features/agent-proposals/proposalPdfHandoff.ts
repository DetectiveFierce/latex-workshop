import {
  allProposalItemsAccepted,
  type AgentProposal,
  type CompileJob,
} from '@latex-workshop/contracts';

export function preserveFullyAcceptedProposalCompile(
  jobs: readonly CompileJob[],
  proposal: AgentProposal,
): CompileJob[] {
  if (
    proposal.status !== 'resolved' ||
    !proposal.compileJobId ||
    !allProposalItemsAccepted(proposal.changes)
  )
    return [...jobs];

  return jobs.map((job) =>
    job.id === proposal.compileJobId &&
    job.status === 'succeeded' &&
    job.target === 'proposal' &&
    job.proposalId === proposal.id
      ? { ...job, target: 'accepted', proposalId: null, proposalRevision: null }
      : job,
  );
}
