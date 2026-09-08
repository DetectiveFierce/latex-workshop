import type { CompileJob } from '@latex-workshop/contracts';

export type AutoCompileTarget =
  | { target: 'accepted'; revision: number }
  | { target: 'proposal'; proposalId: string; revision: number };

export type AutoCompileDecision = 'compile' | 'covered' | 'wait';

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
