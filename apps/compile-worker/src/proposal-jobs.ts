export type ProposalCompileJobLike = {
  target: 'accepted' | 'proposal';
  proposalId: string | null;
  proposalRevision: number | null;
};

export function isStaleProposalCompile(
  job: ProposalCompileJobLike,
  proposal: { revision: number } | null,
): boolean {
  if (job.target !== 'proposal' || !job.proposalId) return false;
  return !proposal || proposal.revision !== job.proposalRevision;
}

export function compileArtifactObjectKeys(projectId: string, jobId: string) {
  return {
    pdf: `artifacts/${projectId}/${jobId}/document.pdf`,
    synctex: `artifacts/${projectId}/${jobId}/document.synctex.gz`,
  };
}
