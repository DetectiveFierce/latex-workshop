import { and, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { compileJobs, projectMemberships, projects, userTemplateSeeds } from '@latex-workshop/db';
import type { AppContext } from '../lib/context.js';
import { requireUser } from '../lib/context.js';
import { incrementMetric } from '../lib/operational-metrics.js';
import { AIDAN_TEMPLATE_SEED_KEY, ensureAidanTemplate } from '../lib/project-creation.js';
import { scheduleTemplatePreview } from '../lib/template-previews.js';

export async function registerTemplateRoutes(app: FastifyInstance, context: AppContext) {
  app.get('/api/v1/templates', async (request) => {
    const user = await requireUser(context, request);
    try {
      const created = await ensureAidanTemplate(context, user.id);
      if (created) incrementMetric('latex_template_seed_total', { status: 'created' });
    } catch (error) {
      incrementMetric('latex_template_seed_total', { status: 'failed' });
      throw error;
    }

    const rows = await context.db
      .select({ project: projects, seedKey: userTemplateSeeds.seedKey })
      .from(projects)
      .innerJoin(projectMemberships, eq(projectMemberships.projectId, projects.id))
      .leftJoin(
        userTemplateSeeds,
        and(eq(userTemplateSeeds.projectId, projects.id), eq(userTemplateSeeds.userId, user.id)),
      )
      .where(
        and(
          eq(projectMemberships.userId, user.id),
          eq(projects.isTemplate, true),
          isNull(projects.trashedAt),
        ),
      )
      .orderBy(desc(projects.updatedAt));
    const projectIds = rows.map(({ project }) => project.id);
    const compiles = projectIds.length
      ? await context.db
          .selectDistinctOn([compileJobs.projectId], {
            id: compileJobs.id,
            projectId: compileJobs.projectId,
          })
          .from(compileJobs)
          .where(
            and(
              inArray(compileJobs.projectId, projectIds),
              eq(compileJobs.status, 'succeeded'),
              isNotNull(compileJobs.pdfObjectKey),
            ),
          )
          .orderBy(compileJobs.projectId, desc(compileJobs.createdAt))
      : [];
    const previewByProject = new Map(compiles.map((compile) => [compile.projectId, compile.id]));
    for (const projectId of projectIds) scheduleTemplatePreview(context, projectId);
    return {
      templates: rows.map(({ project, seedKey }) => ({
        ...project,
        isStarter: seedKey === AIDAN_TEMPLATE_SEED_KEY,
        previewJobId: previewByProject.get(project.id) ?? null,
        createdAt: project.createdAt.toISOString(),
        updatedAt: project.updatedAt.toISOString(),
        trashedAt: null,
      })),
    };
  });
}
