import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  agentConnectionQuerySchema,
  agentClientMetadataSchema,
  agentProposalFileQuerySchema,
  proposalBulkDecisionSchema,
  proposalDecisionSchema,
  putAgentConnectionGrantSchema,
  putOwnerProposalFileSchema,
  reviseAgentProposalHunkSchema,
} from '@latex-workshop/contracts';
import {
  agentClientPolicies,
  agentProjectGrants,
  agentProposals,
  auditEvents,
  oauthAccessTokens,
  oauthClients,
  oauthConsents,
  oauthRefreshTokens,
  projectMemberships,
  projects,
} from '@latex-workshop/db';
import type { AppContext } from '../lib/context.js';
import { requireUser } from '../lib/context.js';
import { badRequest, notFound } from '../lib/errors.js';
import { requireProject } from '../lib/domain.js';
import {
  acceptRemainingProposalItems,
  decideProposalItem,
  discardDraftProposalChange,
  finishAgentProposal,
  getAgentProposal,
  getAgentProposalFile,
  putOwnerProposalFile,
  rejectRemainingProposalItems,
  requestProposalCompilation,
  reviseAgentProposalHunk,
  reconcileProposalCompilation,
} from '../lib/agent-proposals.js';

export async function registerAgentProposalRoutes(app: FastifyInstance, context: AppContext) {
  app.get('/api/v1/agent-connections/client', async (request) => {
    await requireUser(context, request);
    const { clientId } = agentConnectionQuerySchema.parse(request.query);
    const [client] = await context.db
      .select({ clientId: oauthClients.clientId, clientName: oauthClients.name })
      .from(oauthClients)
      .where(and(eq(oauthClients.clientId, clientId), eq(oauthClients.disabled, false)))
      .limit(1);
    if (!client) throw notFound('Agent connection not found');
    return agentClientMetadataSchema.parse({
      clientId: client.clientId,
      clientName: client.clientName ?? client.clientId,
    });
  });

  app.get('/api/v1/agent-connections', async (request) => {
    const user = await requireUser(context, request);
    const grants = await context.db
      .select()
      .from(agentProjectGrants)
      .where(eq(agentProjectGrants.userId, user.id))
      .orderBy(asc(agentProjectGrants.createdAt));
    const consents = await context.db
      .select({
        clientId: oauthConsents.clientId,
        createdAt: oauthConsents.createdAt,
        updatedAt: oauthConsents.updatedAt,
      })
      .from(oauthConsents)
      .where(eq(oauthConsents.userId, user.id));
    const policies = await context.db
      .select()
      .from(agentClientPolicies)
      .where(eq(agentClientPolicies.userId, user.id));
    const relevantClientIds = [
      ...new Set([
        ...grants.map((grant) => grant.clientId),
        ...consents.map((consent) => consent.clientId),
        ...policies.map((policy) => policy.clientId),
      ]),
    ];
    // OAuth client registration is global metadata. Never enumerate unrelated clients
    // into another owner's account; resolve metadata only for this user's connections.
    const clients = relevantClientIds.length
      ? await context.db
          .select({
            clientId: oauthClients.clientId,
            clientName: oauthClients.name,
            createdAt: oauthClients.createdAt,
            updatedAt: oauthClients.updatedAt,
            disabled: oauthClients.disabled,
          })
          .from(oauthClients)
          .where(inArray(oauthClients.clientId, relevantClientIds))
          .orderBy(asc(oauthClients.createdAt))
      : [];
    const grouped = new Map<
      string,
      {
        clientId: string;
        clientName: string;
        projectIds: string[];
        allProjects: boolean;
        createdAt: Date;
        updatedAt: Date;
      }
    >();
    for (const client of clients) {
      if (client.disabled) continue;
      grouped.set(client.clientId, {
        clientId: client.clientId,
        clientName: client.clientName ?? client.clientId,
        projectIds: [],
        allProjects: false,
        createdAt: client.createdAt,
        updatedAt: client.updatedAt,
      });
    }
    for (const consent of consents) {
      let current = grouped.get(consent.clientId);
      if (!current) {
        current = {
          clientId: consent.clientId,
          clientName: consent.clientId,
          projectIds: [],
          allProjects: false,
          createdAt: consent.createdAt,
          updatedAt: consent.updatedAt,
        };
        grouped.set(consent.clientId, current);
      }
      if (consent.updatedAt > current.updatedAt) current.updatedAt = consent.updatedAt;
    }
    for (const grant of grants) {
      const current = grouped.get(grant.clientId);
      if (current) {
        current.projectIds.push(grant.projectId);
        if (grant.updatedAt > current.updatedAt) current.updatedAt = grant.updatedAt;
      } else {
        grouped.set(grant.clientId, {
          clientId: grant.clientId,
          clientName: grant.clientName,
          projectIds: [grant.projectId],
          allProjects: false,
          createdAt: grant.createdAt,
          updatedAt: grant.updatedAt,
        });
      }
    }
    for (const policy of policies) {
      let current = grouped.get(policy.clientId);
      if (!current) {
        current = {
          clientId: policy.clientId,
          clientName: policy.clientId,
          projectIds: [],
          allProjects: false,
          createdAt: policy.createdAt,
          updatedAt: policy.updatedAt,
        };
        grouped.set(policy.clientId, current);
      }
      current.allProjects = policy.allProjects;
      if (policy.updatedAt > current.updatedAt) current.updatedAt = policy.updatedAt;
    }
    return {
      connections: [...grouped.values()].map((connection) => ({
        ...connection,
        createdAt: connection.createdAt.toISOString(),
        updatedAt: connection.updatedAt.toISOString(),
      })),
    };
  });

  app.put('/api/v1/agent-connections/grants', async (request) => {
    const user = await requireUser(context, request);
    const parsed = putAgentConnectionGrantSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Invalid project grants', parsed.error.flatten());
    const { clientId } = parsed.data;
    const allProjects = parsed.data.allProjects;
    const projectIds = allProjects ? [] : [...new Set(parsed.data.projectIds)];
    if (!allProjects && !projectIds.length) throw badRequest('Select at least one project');
    const owned = projectIds.length
      ? await context.db
          .select({ id: projects.id })
          .from(projects)
          .innerJoin(projectMemberships, eq(projectMemberships.projectId, projects.id))
          .where(
            and(
              inArray(projects.id, projectIds),
              eq(projectMemberships.userId, user.id),
              eq(projectMemberships.role, 'owner'),
              isNull(projects.trashedAt),
            ),
          )
      : [];
    if (owned.length !== projectIds.length) throw notFound('Project not found');
    const [client] = await context.db
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.clientId, clientId))
      .limit(1);
    if (!client) throw notFound('Agent connection not found');
    const clientName = client.name ?? clientId;
    await context.db.transaction(async (tx) => {
      await tx
        .delete(agentProjectGrants)
        .where(
          and(eq(agentProjectGrants.userId, user.id), eq(agentProjectGrants.clientId, clientId)),
        );
      if (!allProjects && projectIds.length)
        await tx
          .insert(agentProjectGrants)
          .values(
            projectIds.map((projectId) => ({ userId: user.id, clientId, clientName, projectId })),
          );
      await tx
        .insert(agentClientPolicies)
        .values({ userId: user.id, clientId, allProjects })
        .onConflictDoUpdate({
          target: [agentClientPolicies.userId, agentClientPolicies.clientId],
          set: { allProjects, updatedAt: new Date() },
        });
      await tx.insert(auditEvents).values({
        userId: user.id,
        action: 'agent_connection.grants_changed',
        details: { clientId, projectCount: projectIds.length, allProjects },
      });
    });
    return { clientId, clientName, projectIds, allProjects };
  });

  app.delete('/api/v1/agent-connections', async (request, reply) => {
    const user = await requireUser(context, request);
    const { clientId } = agentConnectionQuerySchema.parse(request.query);
    const [client] = await context.db
      .select({ clientId: oauthClients.clientId })
      .from(oauthClients)
      .where(eq(oauthClients.clientId, clientId))
      .limit(1);
    await context.db.transaction(async (tx) => {
      await tx
        .delete(agentProjectGrants)
        .where(
          and(eq(agentProjectGrants.userId, user.id), eq(agentProjectGrants.clientId, clientId)),
        );
      await tx
        .delete(agentClientPolicies)
        .where(
          and(eq(agentClientPolicies.userId, user.id), eq(agentClientPolicies.clientId, clientId)),
        );
      if (client) {
        await tx
          .delete(oauthAccessTokens)
          .where(
            and(
              eq(oauthAccessTokens.userId, user.id),
              eq(oauthAccessTokens.clientId, client.clientId),
            ),
          );
        await tx
          .delete(oauthRefreshTokens)
          .where(
            and(
              eq(oauthRefreshTokens.userId, user.id),
              eq(oauthRefreshTokens.clientId, client.clientId),
            ),
          );
        await tx
          .delete(oauthConsents)
          .where(
            and(eq(oauthConsents.userId, user.id), eq(oauthConsents.clientId, client.clientId)),
          );
      }
      await tx.insert(auditEvents).values({
        userId: user.id,
        action: 'agent_connection.revoked',
        details: { clientId },
      });
    });
    return reply.code(204).send();
  });

  app.delete('/api/v1/agent-connections/tokens', async (request, reply) => {
    const user = await requireUser(context, request);
    const { clientId } = agentConnectionQuerySchema.parse(request.query);
    const [client] = await context.db
      .select({ clientId: oauthClients.clientId })
      .from(oauthClients)
      .where(eq(oauthClients.clientId, clientId))
      .limit(1);
    if (!client) throw notFound('Agent connection not found');
    await context.db.transaction(async (tx) => {
      await tx
        .delete(oauthAccessTokens)
        .where(
          and(
            eq(oauthAccessTokens.userId, user.id),
            eq(oauthAccessTokens.clientId, client.clientId),
          ),
        );
      await tx
        .delete(oauthRefreshTokens)
        .where(
          and(
            eq(oauthRefreshTokens.userId, user.id),
            eq(oauthRefreshTokens.clientId, client.clientId),
          ),
        );
      await tx
        .update(agentClientPolicies)
        .set({ tokensRevokedAt: new Date(), updatedAt: new Date() })
        .where(
          and(eq(agentClientPolicies.userId, user.id), eq(agentClientPolicies.clientId, clientId)),
        );
      await tx.insert(auditEvents).values({
        userId: user.id,
        action: 'agent_connection.tokens_revoked',
        details: { clientId },
      });
    });
    return reply.code(204).send();
  });

  app.get('/api/v1/projects/:projectId/proposals/active', async (request) => {
    const user = await requireUser(context, request);
    const { projectId } = request.params as { projectId: string };
    await requireProject(context.db, user.id, projectId);
    const [active] = await context.db
      .select({ id: agentProposals.id })
      .from(agentProposals)
      .where(
        and(
          eq(agentProposals.projectId, projectId),
          inArray(agentProposals.status, ['draft', 'needs_rebase', 'reviewing']),
        ),
      )
      .limit(1);
    return { proposal: active ? await getAgentProposal(context, user.id, active.id) : null };
  });

  app.get('/api/v1/projects/:projectId/proposals/:proposalId', async (request) => {
    const user = await requireUser(context, request);
    const { projectId, proposalId } = request.params as { projectId: string; proposalId: string };
    await requireProject(context.db, user.id, projectId);
    const proposal = await getAgentProposal(context, user.id, proposalId);
    if (proposal.projectId !== projectId) throw notFound('Proposal not found');
    return { proposal };
  });

  app.get('/api/v1/projects/:projectId/proposals/:proposalId/files', async (request) => {
    const user = await requireUser(context, request);
    const { projectId, proposalId } = request.params as { projectId: string; proposalId: string };
    const query = agentProposalFileQuerySchema.parse(request.query);
    return getAgentProposalFile(context, user.id, projectId, proposalId, query.path);
  });

  app.put('/api/v1/projects/:projectId/proposals/:proposalId/files', async (request) => {
    const user = await requireUser(context, request);
    const { projectId, proposalId } = request.params as { projectId: string; proposalId: string };
    const input = putOwnerProposalFileSchema.parse(request.body);
    return {
      proposal: await putOwnerProposalFile(context, user.id, projectId, proposalId, input),
    };
  });

  app.delete(
    '/api/v1/projects/:projectId/proposals/:proposalId/changes/:changeId',
    async (request) => {
      const user = await requireUser(context, request);
      const { projectId, proposalId, changeId } = request.params as {
        projectId: string;
        proposalId: string;
        changeId: string;
      };
      const { expectedProposalRevision } = proposalBulkDecisionSchema
        .pick({ expectedProposalRevision: true })
        .parse(request.body);
      return {
        proposal: await discardDraftProposalChange(
          context,
          user.id,
          projectId,
          proposalId,
          changeId,
          expectedProposalRevision,
        ),
      };
    },
  );

  app.post('/api/v1/projects/:projectId/proposals/:proposalId/hunks/:hunkId', async (request) => {
    const user = await requireUser(context, request);
    const { projectId, proposalId, hunkId } = request.params as {
      projectId: string;
      proposalId: string;
      hunkId: string;
    };
    const input = reviseAgentProposalHunkSchema.parse(request.body);
    return {
      proposal: await reviseAgentProposalHunk(
        context,
        user.id,
        projectId,
        proposalId,
        hunkId,
        input,
      ),
    };
  });

  app.post('/api/v1/projects/:projectId/proposals/:proposalId/finish', async (request) => {
    const user = await requireUser(context, request);
    const { projectId, proposalId } = request.params as { projectId: string; proposalId: string };
    await requireProject(context.db, user.id, projectId);
    const proposal = await getAgentProposal(context, user.id, proposalId);
    if (proposal.projectId !== projectId) throw notFound('Proposal not found');
    const body = request.body as { expectedProposalRevision?: unknown; idempotencyKey?: unknown };
    const input = proposalBulkDecisionSchema
      .pick({ expectedProposalRevision: true })
      .extend({ idempotencyKey: proposalDecisionSchema.shape.itemId })
      .parse(body);
    return {
      proposal: await finishAgentProposal(
        context,
        { userId: user.id, clientId: proposal.clientId, clientName: proposal.clientName },
        proposalId,
        input,
      ),
    };
  });

  app.post('/api/v1/projects/:projectId/proposals/:proposalId/decisions', async (request) => {
    const user = await requireUser(context, request);
    const { projectId, proposalId } = request.params as { projectId: string; proposalId: string };
    await requireProject(context.db, user.id, projectId);
    const proposal = await getAgentProposal(context, user.id, proposalId);
    if (proposal.projectId !== projectId) throw notFound('Proposal not found');
    const input = proposalDecisionSchema.parse(request.body);
    await decideProposalItem(context, user.id, proposalId, input);
    const updated = await reconcileProposalCompilation(context, user.id, proposalId).catch(() =>
      getAgentProposal(context, user.id, proposalId),
    );
    return { proposal: updated };
  });

  app.post(
    '/api/v1/projects/:projectId/proposals/:proposalId/reject-remaining',
    async (request) => {
      const user = await requireUser(context, request);
      const { projectId, proposalId } = request.params as { projectId: string; proposalId: string };
      await requireProject(context.db, user.id, projectId);
      const proposal = await getAgentProposal(context, user.id, proposalId);
      if (proposal.projectId !== projectId) throw notFound('Proposal not found');
      const input = proposalBulkDecisionSchema.parse(request.body);
      if (input.decision !== 'rejected')
        throw badRequest('Only pending rejection is supported here');
      await rejectRemainingProposalItems(
        context,
        user.id,
        proposalId,
        input.expectedProposalRevision,
      );
      const updated = await reconcileProposalCompilation(context, user.id, proposalId).catch(() =>
        getAgentProposal(context, user.id, proposalId),
      );
      return { proposal: updated };
    },
  );

  app.post(
    '/api/v1/projects/:projectId/proposals/:proposalId/accept-remaining',
    async (request) => {
      const user = await requireUser(context, request);
      const { projectId, proposalId } = request.params as {
        projectId: string;
        proposalId: string;
      };
      await requireProject(context.db, user.id, projectId);
      const proposal = await getAgentProposal(context, user.id, proposalId);
      if (proposal.projectId !== projectId) throw notFound('Proposal not found');
      const input = proposalBulkDecisionSchema.parse(request.body);
      if (input.decision !== 'accepted')
        throw badRequest('Only pending acceptance is supported here');
      await acceptRemainingProposalItems(
        context,
        user.id,
        proposalId,
        input.expectedProposalRevision,
      );
      const updated = await reconcileProposalCompilation(context, user.id, proposalId).catch(() =>
        getAgentProposal(context, user.id, proposalId),
      );
      return { proposal: updated };
    },
  );

  app.post('/api/v1/projects/:projectId/proposals/:proposalId/compile', async (request, reply) => {
    const user = await requireUser(context, request);
    const { projectId, proposalId } = request.params as { projectId: string; proposalId: string };
    await requireProject(context.db, user.id, projectId);
    const proposal = await getAgentProposal(context, user.id, proposalId);
    if (proposal.projectId !== projectId) throw notFound('Proposal not found');
    const input = proposalBulkDecisionSchema
      .pick({ expectedProposalRevision: true })
      .extend({ idempotencyKey: proposalDecisionSchema.shape.itemId })
      .parse(request.body);
    const updated = await requestProposalCompilation(
      context,
      { userId: user.id, clientId: proposal.clientId, clientName: proposal.clientName },
      proposalId,
      input,
    );
    return reply.code(202).send({ proposal: updated });
  });

  app.get('/api/v1/projects/:projectId/proposal-events', async (request, reply) => {
    const user = await requireUser(context, request);
    const { projectId } = request.params as { projectId: string };
    await requireProject(context.db, user.id, projectId);
    const subscriber = context.redis.duplicate();
    await subscriber.subscribe('agent-proposal-events');
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const heartbeat = setInterval(
      () =>
        reply.raw.write(
          `event: heartbeat\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`,
        ),
      15_000,
    );
    const cleanup = () => {
      clearInterval(heartbeat);
      void subscriber.quit();
    };
    request.raw.on('close', cleanup);
    subscriber.on('message', async (_channel: string, message: string) => {
      try {
        const event = JSON.parse(message) as { proposalId?: unknown; revision?: unknown };
        if (typeof event.proposalId !== 'string' || typeof event.revision !== 'number') return;
        const [proposal] = await context.db
          .select({ projectId: agentProposals.projectId })
          .from(agentProposals)
          .where(eq(agentProposals.id, event.proposalId))
          .limit(1);
        if (proposal?.projectId === projectId)
          reply.raw.write(
            `event: proposal\ndata: ${JSON.stringify({ type: 'proposal', proposalId: event.proposalId, revision: event.revision })}\n\n`,
          );
      } catch {
        // Durable state is refetched after the next valid event or reconnect.
      }
    });
  });
}
