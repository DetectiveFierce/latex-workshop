import { describe, expect, it } from 'vitest';
import {
  agentLibraryMutationSchema,
  bulkLibraryActionSchema,
  createAgentProjectSchema,
  createLibraryFolderSchema,
  createProjectTagSchema,
  updateLibraryFolderSchema,
} from './index.js';

const projectId = '0f4f00ed-e4c8-4c6d-aedf-9c413af8be4d';
const folderId = '1e8d4444-a609-4c9d-a674-4b89292362c6';
const tagId = '872576fc-211c-49d3-b775-90fd9256c621';

describe('library contracts', () => {
  it('normalizes folder and tag names and validates the color palette', () => {
    expect(createLibraryFolderSchema.parse({ name: '  Research  ' })).toEqual({
      name: 'Research',
      parentId: null,
    });
    expect(createProjectTagSchema.parse({ name: '  Draft  ', color: 'amber' })).toEqual({
      name: 'Draft',
      color: 'amber',
    });
    expect(() => createProjectTagSchema.parse({ name: 'Draft', color: 'rainbow' })).toThrow();
  });

  it('requires a real folder update and accepts an explicit root move', () => {
    expect(() => updateLibraryFolderSchema.parse({})).toThrow();
    expect(updateLibraryFolderSchema.parse({ parentId: null })).toEqual({ parentId: null });
  });

  it('validates the discriminated bulk action shapes', () => {
    expect(
      bulkLibraryActionSchema.parse({ action: 'move', projectIds: [projectId], folderId }),
    ).toEqual({ action: 'move', projectIds: [projectId], folderId });
    expect(
      bulkLibraryActionSchema.parse({
        action: 'add-tags',
        projectIds: [projectId],
        tagIds: [tagId],
      }),
    ).toBeDefined();
    expect(() =>
      bulkLibraryActionSchema.parse({ action: 'move', projectIds: [], folderId: null }),
    ).toThrow();
  });

  it('validates agent library organization and project placement', () => {
    expect(
      createAgentProjectSchema.parse({
        name: 'Research notes',
        folderId,
        tagIds: [tagId],
        isTemplate: false,
        idempotencyKey: '11111111-1111-4111-8111-111111111111',
      }),
    ).toMatchObject({ folderId, tagIds: [tagId] });
    expect(
      agentLibraryMutationSchema.parse({
        action: 'move_project',
        projectId,
        folderId,
        idempotencyKey: '22222222-2222-4222-8222-222222222222',
      }),
    ).toMatchObject({ action: 'move_project', projectId, folderId });
    expect(() =>
      agentLibraryMutationSchema.parse({
        action: 'update_folder',
        folderId,
        idempotencyKey: '33333333-3333-4333-8333-333333333333',
      }),
    ).toThrow();
    expect(() =>
      agentLibraryMutationSchema.parse({
        action: 'set_project_tags',
        projectId,
        tagIds: [tagId, tagId],
        idempotencyKey: '44444444-4444-4444-8444-444444444444',
      }),
    ).toThrow();
  });
});
