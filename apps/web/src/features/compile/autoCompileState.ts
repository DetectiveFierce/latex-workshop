import type { CompileJob } from '@latex-workshop/contracts';

export type AutoCompileTarget =
  | { target: 'accepted'; revision: number }
  | { target: 'proposal'; proposalId: string; revision: number };

export type AutoCompileDecision = 'compile' | 'covered' | 'wait';

export function effectivePreviewTarget(input: {
  preferredTarget: 'accepted' | 'proposal';
  acceptedSourceAvailable: boolean;
  proposalId: string | null;
}): 'accepted' | 'proposal' {
  if (!input.proposalId) return 'accepted';
  if (!input.acceptedSourceAvailable) return 'proposal';
  return input.preferredTarget;
}

export function latestCompileForPreview(
  jobs: readonly CompileJob[] | undefined,
  target: 'accepted' | 'proposal',
  proposalId: string | null,
  proposalRevision?: number | null,
): CompileJob | null {
  return (
    jobs?.find((job) =>
      target === 'accepted'
        ? job.target === 'accepted'
        : job.target === 'proposal' &&
          job.proposalId === proposalId &&
          (proposalRevision === undefined || job.proposalRevision === proposalRevision),
    ) ?? null
  );
}

export function successfulCompileForPreview(input: {
  jobs: readonly CompileJob[] | undefined;
  target: 'accepted' | 'proposal';
  proposalId: string | null;
  proposalRevision?: number | null;
  compileJobId?: string | null;
  acceptedFallback?: CompileJob | null;
}): CompileJob | null {
  const matching = input.compileJobId
    ? (input.jobs?.find((job) => job.id === input.compileJobId) ?? null)
    : latestCompileForPreview(input.jobs, input.target, input.proposalId, input.proposalRevision);
  if (
    matching &&
    (matching.target !== input.target ||
      (input.target === 'proposal' &&
        (matching.proposalId !== input.proposalId ||
          matching.proposalRevision !== input.proposalRevision)))
  )
    return null;
  if (matching?.status === 'succeeded') return matching;
  if (input.target === 'accepted' && input.acceptedFallback?.status === 'succeeded')
    return input.acceptedFallback;
  return null;
}

export function selectAutoCompileTarget(input: {
  preferredTarget: 'accepted' | 'proposal';
  acceptedRevision: number;
  acceptedCompiledRevision: number | null;
  proposal: {
    id: string;
    revision: number;
    compiledRevision: number | null;
  } | null;
}): AutoCompileTarget | null {
  const accepted =
    input.acceptedCompiledRevision === input.acceptedRevision
      ? null
      : ({ target: 'accepted', revision: input.acceptedRevision } as const);
  const proposal =
    input.proposal && input.proposal.compiledRevision !== input.proposal.revision
      ? ({
          target: 'proposal',
          proposalId: input.proposal.id,
          revision: input.proposal.revision,
        } as const)
      : null;
  if (input.preferredTarget === 'proposal') return proposal ?? accepted;
  return accepted ?? proposal;
}

export function autoCompileTargetKey(target: AutoCompileTarget) {
  return target.target === 'accepted'
    ? `accepted:${target.revision}`
    : `proposal:${target.proposalId}:${target.revision}`;
}

export function decideAutoCompile(
  target: AutoCompileTarget,
  jobs: readonly CompileJob[],
  attemptedTargetKey: string | null,
): AutoCompileDecision {
  const matchingJob = jobs.find((job) => {
    if (target.target === 'accepted')
      return job.target === 'accepted' && job.sourceRevision === target.revision;
    return (
      job.target === 'proposal' &&
      job.proposalId === target.proposalId &&
      job.proposalRevision === target.revision
    );
  });
  if (matchingJob && ['queued', 'running', 'succeeded'].includes(matchingJob.status))
    return 'covered';
  if (attemptedTargetKey === autoCompileTargetKey(target)) return 'covered';
  if (jobs.some((job) => job.status === 'queued' || job.status === 'running')) return 'wait';
  return 'compile';
}
