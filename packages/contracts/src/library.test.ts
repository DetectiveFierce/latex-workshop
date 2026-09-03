import { describe, expect, it } from 'vitest';
import {
  bulkLibraryActionSchema,
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
});
