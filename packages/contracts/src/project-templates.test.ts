import { describe, expect, it } from 'vitest';
import {
  createProjectSchema,
  projectSchema,
  templateListResponseSchema,
  updateProjectSchema,
} from './index.js';

const id = '123e4567-e89b-42d3-a456-426614174000';

describe('project template contracts', () => {
  it('accepts blank and template-backed project creation', () => {
    expect(createProjectSchema.parse({ name: ' Blank ' })).toEqual({ name: 'Blank' });
    expect(createProjectSchema.parse({ name: 'Paper', templateProjectId: id })).toEqual({
      name: 'Paper',
      templateProjectId: id,
    });
    expect(() => createProjectSchema.parse({ name: 'Paper', templateProjectId: 'nope' })).toThrow();
  });

  it('accepts explicit template designation updates', () => {
    expect(updateProjectSchema.parse({ isTemplate: true })).toEqual({ isTemplate: true });
  });

  it('requires template state on public projects and starter metadata in template lists', () => {
    const project = {
      id,
      name: 'Aidan Template',
      compiler: 'pdflatex' as const,
      mainFileId: null,
      autoCompile: false,
      sourceRevision: 1,
      isTemplate: true,
      trashedAt: null,
      createdAt: '2026-09-03T12:00:00.000Z',
      updatedAt: '2026-09-03T12:00:00.000Z',
    };
    expect(projectSchema.parse(project).isTemplate).toBe(true);
    expect(
      templateListResponseSchema.parse({
        templates: [{ ...project, isStarter: true, previewJobId: null }],
      }).templates[0]?.isStarter,
    ).toBe(true);
  });
});
