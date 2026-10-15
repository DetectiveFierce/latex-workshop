import { describe, expect, it } from 'vitest';
import { editAgentProjectSchema } from '@latex-workshop/contracts';
import { editMutationId, validateDirectEdit, isRetryableEditConflict } from './agent-edits.js';

const projectId = '11111111-1111-4111-8111-111111111111';
const base = {
  projectId,
  expectedSourceRevision: 5,
  title: 'Revise paper',
  idempotencyKey: '22222222-2222-4222-8222-222222222222',
};

describe('direct edit boundary', () => {
  it('requires a deliberate create-only or current hash choice and an actual change', () => {
    expect(editAgentProjectSchema.safeParse(base).success).toBe(false);
    expect(
      editAgentProjectSchema.safeParse({ ...base, files: [{ path: 'main.tex', content: 'text' }] })
        .success,
    ).toBe(false);
    expect(
      editAgentProjectSchema.safeParse({
        ...base,
        files: [{ path: 'main.tex', content: '', baseHash: null }],
      }).success,
    ).toBe(true);
    expect(
      editAgentProjectSchema.safeParse({
        ...base,
        expectedSourceRevision: -1,
        files: [{ path: 'main.tex', content: '', baseHash: null }],
      }).success,
    ).toBe(false);
  });

  it('rejects duplicate, traversal, and write/delete combinations before any mutation', () => {
    const file = { path: 'main.tex', content: 'text', baseHash: null };
    expect(() =>
      validateDirectEdit(
        editAgentProjectSchema.parse({ ...base, files: [file, { ...file, path: 'MAIN.tex' }] }),
      ),
    ).toThrow('only once');
    expect(() =>
      validateDirectEdit(
        editAgentProjectSchema.parse({ ...base, files: [{ ...file, path: '../main.tex' }] }),
      ),
    ).toThrow();
    expect(() =>
      validateDirectEdit(
        editAgentProjectSchema.parse({
          ...base,
          files: [{ ...file, path: 'chapter/main.tex' }],
          structure: [{ operation: 'delete', basePath: 'chapter' }],
        }),
      ),
    ).toThrow('separate edits');
  });

  it('reports rolled-back database concurrency failures as recoverable conflicts', () => {
    expect(isRetryableEditConflict(new Error('query failed', { cause: { code: '40P01' } }))).toBe(
      true,
    );
    expect(isRetryableEditConflict({ cause: { cause: { code: '40001' } } })).toBe(true);
    expect(isRetryableEditConflict({ code: '23505' })).toBe(false);
    expect(isRetryableEditConflict(null)).toBe(false);
  });

  it('bounds the combined edit size and uses valid durable mutation IDs', () => {
    expect(
      editAgentProjectSchema.safeParse({
        ...base,
        files: Array.from({ length: 100 }, (_, i) => ({
          path: `${i}.tex`,
          content: '',
          baseHash: null,
        })),
        structure: [{ operation: 'create_folder', targetPath: 'extra' }],
      }).success,
    ).toBe(false);
    expect(editMutationId('retry')).toBe(editMutationId('retry'));
    expect(editMutationId('retry')).not.toBe(editMutationId('next edit'));
    expect(editMutationId('retry')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
