import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  alignSelectionToCompiled,
  contentHint,
  findSyncTexInput,
  parseSyncTexRecords,
  rankSyncRecords,
  recordToPdfResult,
  structuralSourceAnchors,
  unionSyncResults,
} from './synctex.js';

describe('SyncTeX output', () => {
  it('preserves ordered records and case-sensitive box fields', () => {
    const records = parseSyncTexRecords(fixture('multiple-records.txt'));
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ page: 1, h: 10, H: 7, W: 40 });
    expect(
      recordToPdfResult(records[0]!, {
        artifactStale: false,
        sourceFileChangedSinceCompile: false,
        selectedText: 'word',
        usedContext: true,
      }).rect,
    ).toEqual({ page: 1, x: 10, y: 23, width: 40, height: 9 });
  });

  it('rejects malformed records and creates safe content hints', () => {
    expect(parseSyncTexRecords(fixture('malformed.txt'))).toHaveLength(1);
    expect(parseSyncTexRecords(fixture('empty.txt'))).toEqual([]);
    expect(contentHint('target', 'the previous', 'next value')).toBe('previous/0:target/next');
    expect(contentHint('\\begin', 'before', 'after')).toBe('before/1:begin/after');
  });

  it('aligns stale selections by text and surrounding context', () => {
    const compiled = 'start\nRepeated target old\nmiddle\nRepeated target wanted\nend';
    const current = 'inserted\nstart\nRepeated target old\nmiddle\nRepeated target wanted\nend';
    const aligned = alignSelectionToCompiled(current, compiled, {
      start: { line: 5, column: 10 },
      end: { line: 5, column: 16 },
      text: 'target',
      before: 'Repeated ',
      after: ' wanted',
    });
    expect(aligned.start).toEqual({ line: 4, column: 10 });
    expect(aligned.end).toEqual({ line: 4, column: 16 });
    expect(aligned.text).toBe('target');
  });

  it('finds printable anchors for commands and environments', () => {
    const source = fixture('../source/structures.tex');
    const commandOffset = source.indexOf('\\textbf');
    const command = structuralSourceAnchors(source, selectionAtOffset(source, commandOffset));
    expect(command[0]?.text).toBe('Printable');

    const environmentOffset = source.indexOf('\\begin{align}');
    const environment = structuralSourceAnchors(
      source,
      selectionAtOffset(source, environmentOffset),
    );
    expect(environment.map(({ text }) => text)).toContain('x');
  });

  it('ranks path, page, content, and proximity without losing stable order', () => {
    const records = parseSyncTexRecords(fixture('multiple-records.txt'));
    expect(
      rankSyncRecords(records, {
        path: 'chapters/included.tex',
        line: 18,
        pageHint: 2,
      })[0]?.page,
    ).toBe(2);
  });

  it('uses the exact source spelling recorded in the SyncTeX preamble', () => {
    const preamble =
      'SyncTeX Version:1\nInput:1:/workspace/./main.tex\nInput:2:/workspace/chapters/a.tex';
    expect(findSyncTexInput(preamble, 'main.tex')).toBe('/workspace/./main.tex');
    expect(findSyncTexInput(preamble, 'chapters/a.tex')).toBe('/workspace/chapters/a.tex');
    expect(findSyncTexInput(preamble, 'missing.tex')).toBe('missing.tex');
  });

  it('unions structural boxes only on the nearest result page', () => {
    const base = recordToPdfResult(
      { ...parseSyncTexRecords(fixture('multiple-records.txt'))[0]! },
      {
        artifactStale: false,
        sourceFileChangedSinceCompile: false,
        selectedText: '\\begin',
        usedContext: true,
      },
    );
    const union = unionSyncResults([
      base,
      { ...base, rect: { page: 1, x: 30, y: 20, width: 30, height: 20 } },
      { ...base, rect: { page: 2, x: 0, y: 0, width: 500, height: 500 } },
    ]);
    expect(union?.rect).toEqual({ page: 1, x: 10, y: 20, width: 50, height: 20 });
    expect(union?.matchKind).toBe('container');
  });
});

function fixture(name: string) {
  return readFileSync(new URL(`./fixtures/synctex/${name}`, import.meta.url), 'utf8');
}

function selectionAtOffset(source: string, offset: number) {
  const prefix = source.slice(0, offset);
  const lines = prefix.split('\n');
  const position = { line: lines.length, column: lines.at(-1)!.length + 1 };
  return { start: position, end: position, text: '', before: '', after: '' };
}
