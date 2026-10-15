import { and, desc, eq } from 'drizzle-orm';
import { compileJobs } from '@latex-workshop/db';
import type { AppContext } from './context.js';
import { conflict, notFound } from './errors.js';
import { requireGrantedProject, serializeAgentCompile } from './agent-proposals.js';
import { requestProjectCompilation } from './project-compiles.js';

type AgentIdentity = { userId: string; clientId: string; clientName: string };

export async function getAgentProjectCompile(
  context: AppContext,
  identity: AgentIdentity,
  projectId: string,
  compileJobId?: string,
) {
  await requireGrantedProject(context, identity, projectId);
  const [job] = await context.db
    .select()
    .from(compileJobs)
    .where(
      and(
        eq(compileJobs.projectId, projectId),
        eq(compileJobs.target, 'accepted'),
        ...(compileJobId ? [eq(compileJobs.id, compileJobId)] : []),
      ),
    )
    .orderBy(desc(compileJobs.createdAt))
    .limit(1);
  if (!job && compileJobId) throw notFound('Compilation not found');
  return job ? serializeAgentCompile(job) : null;
}

export async function compileAgentProject(
  context: AppContext,
  identity: AgentIdentity,
  projectId: string,
  expectedSourceRevision: number,
  signal?: AbortSignal,
) {
  const project = await requireGrantedProject(context, identity, projectId);
  if (project.sourceRevision !== expectedSourceRevision)
    throw conflict('Project changed. Refresh get_project_tree before compiling.', {
      sourceRevision: project.sourceRevision,
    });
  const existing = await getAgentProjectCompile(context, identity, projectId);
  const job =
    existing &&
    existing.sourceRevision === expectedSourceRevision &&
    ['queued', 'running', 'succeeded'].includes(existing.status)
      ? existing
      : (
          await requestProjectCompilation(
            context,
            identity.userId,
            projectId,
            { trigger: 'agent' },
            expectedSourceRevision,
          )
        ).job;
  const deadline = Date.now() + 50_000;
  while (true) {
    const result = await getAgentProjectCompile(context, identity, projectId, job.id);
    if (
      !result ||
      !['queued', 'running'].includes(result.status) ||
      signal?.aborted ||
      Date.now() >= deadline
    )
      return result;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

export async function getAgentProjectPdfArtifact(
  context: AppContext,
  identity: AgentIdentity,
  projectId: string,
  compileJobId: string,
) {
  await requireGrantedProject(context, identity, projectId);
  const [job] = await context.db
    .select({
      id: compileJobs.id,
      projectId: compileJobs.projectId,
      pdfObjectKey: compileJobs.pdfObjectKey,
      status: compileJobs.status,
    })
    .from(compileJobs)
    .where(
      and(
        eq(compileJobs.id, compileJobId),
        eq(compileJobs.projectId, projectId),
        eq(compileJobs.target, 'accepted'),
      ),
    )
    .limit(1);
  if (!job?.pdfObjectKey || job.status !== 'succeeded')
    throw notFound('Compiled project PDF not found');
  return { ...job, pdfObjectKey: job.pdfObjectKey };
}
