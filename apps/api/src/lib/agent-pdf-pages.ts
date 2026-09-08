import { randomUUID } from 'node:crypto';
import {
  agentPdfPageLimits,
  pdfPageRenderQueuePayloadSchema,
  pdfPageRenderRequestKey,
  pdfPageRenderResultSchema,
  type AgentPdfPageRequest,
} from '@latex-workshop/contracts';
import type { AppContext } from './context.js';
import { conflict } from './errors.js';
import { getAgentProposalPdfArtifact } from './agent-proposals.js';

type AgentIdentity = { userId: string; clientId: string; clientName: string };

export async function renderAgentProposalPdfPages(
  context: AppContext,
  identity: AgentIdentity,
  input: AgentPdfPageRequest,
  signal?: AbortSignal,
) {
  const artifact = await getAgentProposalPdfArtifact(
    context,
    identity,
    input.proposalId,
    input.compileJobId,
  );
  const renderRequestId = randomUUID();
  const key = pdfPageRenderRequestKey(renderRequestId);
  const pages = [...input.pages].sort((left, right) => left - right);
  await context.redis.set(
    key,
    JSON.stringify({
      status: 'queued',
      request: {
        projectId: artifact.projectId,
        compileJobId: artifact.id,
        pages,
      },
    }),
    'EX',
    agentPdfPageLimits.renderRequestTtlSeconds,
  );
  await context.pdfRenderQueue.add(
    'render',
    pdfPageRenderQueuePayloadSchema.parse({ compileJobId: artifact.id }),
    {
      jobId: renderRequestId,
      attempts: 2,
      backoff: { type: 'fixed', delay: 1_000 },
      removeOnComplete: 500,
      removeOnFail: 500,
    },
  );

  const deadline = Date.now() + 45_000;
  while (!signal?.aborted && Date.now() < deadline) {
    const raw = await context.redis.get(key);
    if (!raw) throw conflict('The PDF page render expired; retry the request');
    const envelope = JSON.parse(raw) as { status?: unknown; pages?: unknown; message?: unknown };
    const result = pdfPageRenderResultSchema.safeParse(envelope);
    if (result.success && result.data.status === 'failed') throw conflict(result.data.message);
    if (result.success && result.data.status === 'succeeded') {
      const renderedPages = await Promise.all(
        result.data.pages.map(async (page) => {
          const data = await context.storage.getBuffer(page.objectKey);
          if (data.byteLength > agentPdfPageLimits.maxImageBytes)
            throw conflict(`Rendered page ${page.page} exceeds the image size limit`);
          return { page: page.page, data };
        }),
      );
      return { compileJobId: artifact.id, pages: renderedPages };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw conflict('PDF page rendering is still in progress; retry the request');
}
