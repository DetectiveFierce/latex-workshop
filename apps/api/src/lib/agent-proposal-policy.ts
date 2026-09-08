import {
  agentProposalLimits,
  type AgentDecision,
  type AgentProposalStatus,
} from '@latex-workshop/contracts';
import { conflict, quotaExceeded } from './errors.js';

export function canAgentMutateProposal(status: AgentProposalStatus): boolean {
  return status === 'draft' || status === 'needs_rebase';
}

export function canAgentReviseProposal(status: AgentProposalStatus): boolean {
  return canAgentMutateProposal(status) || status === 'reviewing';
}

export function shouldResetFrozenProposalReview(status: AgentProposalStatus): boolean {
  return status === 'reviewing';
}

export function proposalFileBase(
  existing: { id: string; version: number; currentVersionId: string | null } | null,
  path: string,
  hash: string | null,
) {
  return {
    entryId: existing?.id ?? null,
    operation: existing ? ('replace_file' as const) : ('create_file' as const),
    basePath: existing ? path : null,
    baseVersion: existing?.version ?? null,
    baseVersionId: existing?.currentVersionId ?? null,
    baseHash: hash,
  };
}

export function canOwnerReviseAddition(status: AgentProposalStatus): boolean {
  return status === 'reviewing';
}

export function canOwnerReviseProposalFile(status: AgentProposalStatus): boolean {
  return canAgentMutateProposal(status) || status === 'reviewing';
}

export function canOwnerDiscardProposal(status: AgentProposalStatus): boolean {
  return status === 'draft' || status === 'needs_rebase' || status === 'reviewing';
}

export function canOwnerDiscardDraftChange(status: AgentProposalStatus): boolean {
  return status === 'draft' || status === 'needs_rebase';
}

export function hunkDecisionAfterReplacement(decision: AgentDecision): AgentDecision {
  return decision;
}

export function hasCaseInsensitivePathCollision(
  existingPaths: Iterable<string>,
  targetPath: string,
): boolean {
  const lower = targetPath.toLowerCase();
  for (const path of existingPaths) if (path.toLowerCase() === lower) return true;
  return false;
}

export function nextProposalByteTotal(
  currentTotal: number,
  previousSize: number,
  nextSize: number,
) {
  return currentTotal - previousSize + nextSize;
}

export function assertProposalWriteLimits(input: {
  fileBytes: number;
  nextTotalBytes: number;
  changedEntries: number;
}) {
  if (input.fileBytes > agentProposalLimits.maxFileBytes)
    throw quotaExceeded('Proposed file is too large');
  if (input.nextTotalBytes > agentProposalLimits.maxProposalBytes)
    throw quotaExceeded('Proposal is too large');
  if (input.changedEntries > agentProposalLimits.maxChangedEntries)
    throw quotaExceeded('Proposal has too many changed entries');
}

export function assertProposalRevision(actual: number, expected: number, proposalId: string) {
  if (actual !== expected)
    throw conflict('Proposal revision is stale', { proposalId, revision: actual });
}

export function queuedProposalCompile(proposalId: string, expectedRevision: number) {
  return { proposalId, expectedRevision };
}

export function isOAuthTokenAfterRevocation(
  issuedAtSeconds: number | undefined,
  tokensRevokedAt: Date | null,
): boolean {
  if (tokensRevokedAt === null) return true;
  if (issuedAtSeconds === undefined) return false;
  return issuedAtSeconds > Math.floor(tokensRevokedAt.getTime() / 1_000);
}

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

type ManifestContent = {
  path: string;
  blobHash: string;
  size: number;
  mimeType: string | null;
};

export function checkpointContentMatches(
  compiled: readonly ManifestContent[],
  accepted: readonly ManifestContent[],
): boolean {
  if (compiled.length !== accepted.length) return false;
  const byPath = new Map(compiled.map((item) => [item.path, item]));
  return accepted.every((item) => {
    const candidate = byPath.get(item.path);
    return (
      candidate?.blobHash === item.blobHash &&
      candidate.size === item.size &&
      candidate.mimeType === item.mimeType
    );
  });
}
