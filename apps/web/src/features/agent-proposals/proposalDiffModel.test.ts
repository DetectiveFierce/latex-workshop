import { describe, expect, it } from 'vitest';
import type { AgentProposalChange } from '@latex-workshop/contracts';
import {
  buildProposalFileModel,
  countsForChanges,
  hunkAtProjectedLine,
  hunkWidgetState,
  interpretBufferEdit,
  liveProposalHunks,
  overlayHunksFor,
  reviewableItems,
  shouldBlockProposalOverlay,
} from './proposalDiffModel';

const changeId = '11111111-1111-4111-8111-111111111111';
const nl = String.raw;

describe('proposalDiffModel', () => {
  it('projects additions into the buffer and keeps deletions as view zones', () => {
    const model = buildProposalFileModel({
      path: 'main.tex',
      baseText: nl`alpha
beta
gamma
`,
      hunks: [
        {
          id: 'add',
          changeId,
          baseStart: 1,
          baseEnd: 2,
          baseText: nl`beta
`,
          replacementText: nl`BETA
extra
`,
          decision: 'pending',
        },
      ],
    });
    expect(model.buffer).toBe(nl`alpha
BETA
extra
gamma
`);
    expect(model.acceptedText).toBe(nl`alpha
beta
gamma
`);
    expect(model.segments.map((segment) => segment.kind)).toEqual([
      'unchanged',
      'addition',
      'unchanged',
    ]);
    expect(model.deletions).toEqual([
      expect.objectContaining({
        hunkId: 'add',
        afterLineNumber: 1,
        text: nl`beta
`,
      }),
    ]);
    expect(model.addedLineCount).toBe(2);
    expect(model.deletedLineCount).toBe(1);
    expect(hunkAtProjectedLine(model, 2)).toBe('add');
  });

  it('maps addition edits to replacement text and leaves accepted head unchanged', () => {
    const model = buildProposalFileModel({
      path: 'main.tex',
      baseText: nl`keep
`,
      hunks: liveProposalHunks(
        changeId,
        nl`keep
`,
        nl`keep
added
`,
      ),
    });
    const addition = model.segments.find((segment) => segment.kind === 'addition');
    expect(addition).toBeTruthy();
    const edit = interpretBufferEdit(model, {
      rangeOffset: addition?.bufferStart ?? 0,
      rangeLength: addition?.text.length ?? 0,
      text: nl`revised
`,
    });
    expect(edit.kind).toBe('addition');
    if (edit.kind !== 'addition') return;
    expect(edit.hunkId).toBe(addition?.hunkId);
    expect(edit.replacementText).toBe(nl`revised
`);
    expect(edit.nextBuffer).toContain('revised');
  });

  it('maps unchanged-region edits back onto accepted offsets', () => {
    const model = buildProposalFileModel({
      path: 'main.tex',
      baseText: nl`alpha
beta
`,
      hunks: [
        {
          id: 'add',
          changeId,
          baseStart: 1,
          baseEnd: 1,
          baseText: '',
          replacementText: nl`NEW
`,
          decision: 'pending',
        },
      ],
    });
    expect(model.buffer).toBe(nl`alpha
NEW
beta
`);
    const edit = interpretBufferEdit(model, {
      rangeOffset: 0,
      rangeLength: 5,
      text: 'ALPHA',
    });
    expect(edit.kind).toBe('unchanged');
    if (edit.kind !== 'unchanged') return;
    expect(edit.acceptedStart).toBe(0);
    expect(edit.nextAcceptedText).toBe(nl`ALPHA
beta
`);
    expect(edit.nextBuffer).toBe(nl`ALPHA
NEW
beta
`);
  });

  it('ignores edits that start outside buffer segments such as empty deletions', () => {
    const model = buildProposalFileModel({
      path: 'gone.tex',
      baseText: nl`delete me
`,
      hunks: [
        {
          id: 'del',
          changeId,
          baseStart: 0,
          baseEnd: 1,
          baseText: nl`delete me
`,
          replacementText: '',
          decision: 'pending',
        },
      ],
    });
    expect(model.buffer).toBe('');
    expect(model.deletions).toHaveLength(1);
    expect(interpretBufferEdit(model, { rangeOffset: 0, rangeLength: 0, text: 'x' })).toEqual({
      kind: 'ignore',
    });
  });

  it('clamps an edit that would cross from an addition into unchanged text', () => {
    const model = buildProposalFileModel({
      path: 'main.tex',
      baseText: nl`keep
`,
      hunks: liveProposalHunks(
        changeId,
        nl`keep
`,
        nl`keep
added
`,
      ),
    });
    const addition = model.segments.find((segment) => segment.kind === 'addition');
    if (!addition) throw new Error('expected addition');
    const edit = interpretBufferEdit(model, {
      rangeOffset: addition.bufferStart,
      rangeLength: addition.text.length + 4,
      text: nl`only-add
`,
    });
    expect(edit.kind).toBe('addition');
    if (edit.kind !== 'addition') return;
    expect(edit.replacementText).toBe(nl`only-add
`);
  });

  it('disables accept on conflicted hunks and before freeze', () => {
    expect(hunkWidgetState('draft', 'pending')).toEqual({
      visible: true,
      acceptEnabled: false,
      rejectEnabled: false,
    });
    expect(hunkWidgetState('reviewing', 'pending')).toEqual({
      visible: true,
      acceptEnabled: true,
      rejectEnabled: true,
    });
    expect(hunkWidgetState('reviewing', 'conflicted')).toEqual({
      visible: true,
      acceptEnabled: false,
      rejectEnabled: true,
    });
  });

  it('counts pending hunks and lists structural items for the dock', () => {
    const textChange: AgentProposalChange = {
      id: changeId,
      operation: 'replace_file',
      entryId: changeId,
      entryKind: 'file',
      basePath: 'main.tex',
      targetPath: 'main.tex',
      baseVersion: 1,
      baseHash: 'a'.repeat(64),
      contentHash: 'b'.repeat(64),
      size: 12,
      decision: 'pending',
      hunks: liveProposalHunks(
        changeId,
        nl`a
`,
        nl`a
b
`,
      ),
    };
    const folderChange: AgentProposalChange = {
      id: '22222222-2222-4222-8222-222222222222',
      operation: 'create_folder',
      entryId: null,
      entryKind: 'folder',
      basePath: null,
      targetPath: 'notes',
      baseVersion: null,
      baseHash: null,
      contentHash: null,
      size: 0,
      decision: 'pending',
      hunks: [],
    };
    const items = reviewableItems([textChange, folderChange]);
    expect(items.some((item) => item.structural && item.path === 'notes')).toBe(true);
    expect(countsForChanges([textChange, folderChange]).added).toBeGreaterThan(0);
  });

  it('blocks overlay only for unflushable drafts, not for in-progress accepted edits', () => {
    expect(shouldBlockProposalOverlay({ saveState: 'dirty', overlayAlreadyActive: false })).toBe(
      true,
    );
    expect(shouldBlockProposalOverlay({ saveState: 'dirty', overlayAlreadyActive: true })).toBe(
      false,
    );
    expect(shouldBlockProposalOverlay({ saveState: 'conflict', overlayAlreadyActive: true })).toBe(
      true,
    );
    expect(shouldBlockProposalOverlay({ saveState: 'saved', overlayAlreadyActive: false })).toBe(
      false,
    );
  });

  it('uses live diffs before freeze and frozen hunks while reviewing', () => {
    const change: AgentProposalChange = {
      id: changeId,
      operation: 'replace_file',
      entryId: changeId,
      entryKind: 'file',
      basePath: 'main.tex',
      targetPath: 'main.tex',
      baseVersion: 1,
      baseHash: 'a'.repeat(64),
      contentHash: 'b'.repeat(64),
      size: 12,
      decision: 'pending',
      hunks: [
        {
          id: 'frozen',
          changeId,
          baseStart: 0,
          baseEnd: 1,
          baseText: nl`a
`,
          replacementText: nl`b
`,
          contentHash: 'c'.repeat(64),
          decision: 'pending',
          order: 0,
        },
      ],
    };
    expect(overlayHunksFor('draft', { ...change, hunks: [] }, 'a\n', 'b\n')[0]?.id).toMatch(
      /^draft:/,
    );
    expect(overlayHunksFor('reviewing', change, 'a\n', 'b\n')[0]?.id).toBe('frozen');
  });
});
