import { describe, expect, it } from 'vitest';
import { isAgentEditableSource, serializeAgentCompile } from './agent-proposals.js';
import { createFrozenHunks, projectAcceptedHunks } from '@latex-workshop/contracts';

const changeId = '11111111-1111-4111-8111-111111111111';

describe('agent proposal hunks', () => {
  it('creates deterministic, non-overlapping hunks for separated edits', () => {
    const before = 'alpha\nbeta\ngamma\ndelta\n';
    const after = 'alpha\nBETA\ngamma\nDELTA\n';
    const first = createFrozenHunks(changeId, before, after);
    const second = createFrozenHunks(changeId, before, after);

    expect(first).toEqual(second);
    expect(first).toHaveLength(2);
    expect(first[0]?.baseEnd).toBeLessThanOrEqual(first[1]?.baseStart ?? -1);
    expect(new Set(first.map((hunk) => hunk.id)).size).toBe(first.length);
  });

  it('projects only the selected hunks onto the immutable base', () => {
    const before = 'alpha\nbeta\ngamma\ndelta\n';
    const after = 'alpha\nBETA\ngamma\nDELTA\n';
    const hunks = createFrozenHunks(changeId, before, after);

    expect(projectAcceptedHunks(before, hunks.slice(0, 1))).toBe('alpha\nBETA\ngamma\ndelta\n');
    expect(projectAcceptedHunks(before, hunks)).toBe(after);
  });

  it('rejects overlapping or out-of-range hunk projections', () => {
    expect(() =>
      projectAcceptedHunks('one\ntwo\n', [
        { baseStart: 0, baseEnd: 2, replacementText: '' },
        { baseStart: 1, baseEnd: 2, replacementText: 'x\n' },
      ]),
    ).toThrow('overlapping');
  });
});

describe('agent editable source policy', () => {
  it('allows source text and rejects binary files', () => {
    expect(isAgentEditableSource('paper.tex', null)).toBe(true);
    expect(isAgentEditableSource('references.bib', 'application/x-bibtex')).toBe(true);
    expect(isAgentEditableSource('notes', 'text/plain')).toBe(true);
    expect(isAgentEditableSource('figure.png', 'image/png')).toBe(false);
  });

  it('returns compile diagnostics without exposing storage object keys', () => {
    const job: Parameters<typeof serializeAgentCompile>[0] = {
      id: '22222222-2222-4222-8222-222222222222',
      projectId: '33333333-3333-4333-8333-333333333333',
      checkpointId: '44444444-4444-4444-8444-444444444444',
      sourceRevision: 7,
      engine: 'pdflatex',
      trigger: 'agent',
      target: 'proposal',
      proposalId: '55555555-5555-4555-8555-555555555555',
      proposalRevision: 3,
      status: 'failed',
      log: 'Undefined control sequence',
      diagnostics: [
        {
          severity: 'error',
          file: 'main.tex',
          line: 12,
          column: null,
          message: 'Undefined control sequence',
          source: 'latex',
        },
      ],
      pdfObjectKey: 'private/pdf-key',
      synctexObjectKey: 'private/synctex-key',
      durationMs: 125,
      startedAt: new Date('2026-01-01T00:00:01.000Z'),
      finishedAt: new Date('2026-01-01T00:00:02.000Z'),
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    };

    const serialized = serializeAgentCompile(job);
    expect(serialized.status).toBe('failed');
    expect(serialized.diagnostics[0]?.file).toBe('main.tex');
    expect(serialized).not.toHaveProperty('pdfObjectKey');
    expect(serialized).not.toHaveProperty('synctexObjectKey');
  });
});
