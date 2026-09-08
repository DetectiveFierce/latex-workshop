import {
  diffLineHunks,
  lineCount,
  projectAcceptedHunks,
  splitLines,
  type AgentDecision,
  type AgentProposalChange,
  type AgentProposalHunk,
  type AgentProposalStatus,
} from '@latex-workshop/contracts';

export type ProposalBufferChange = {
  rangeOffset: number;
  rangeLength: number;
  text: string;
};

export type ProposalBufferSegment = {
  kind: 'unchanged' | 'addition';
  hunkId: string | null;
  changeId: string | null;
  decision: AgentDecision | null;
  text: string;
  bufferStart: number;
  bufferEnd: number;
  startLine: number;
  endLine: number;
  acceptedStart: number | null;
  acceptedEnd: number | null;
};

export type ProposalDeletionZone = {
  hunkId: string;
  changeId: string;
  decision: AgentDecision;
  text: string;
  afterLineNumber: number;
  lineCount: number;
};

export type ProposalFileModel = {
  path: string;
  buffer: string;
  acceptedText: string;
  segments: ProposalBufferSegment[];
  deletions: ProposalDeletionZone[];
  addedLineCount: number;
  deletedLineCount: number;
};

export type ProposalEdit =
  | {
      kind: 'addition';
      hunkId: string;
      changeId: string;
      replacementText: string;
      nextBuffer: string;
    }
  | {
      kind: 'unchanged';
      acceptedStart: number;
      acceptedEnd: number;
      insertedText: string;
      nextAcceptedText: string;
      nextBuffer: string;
    }
  | { kind: 'ignore' };

export type ReviewableHunk = {
  id: string;
  changeId: string;
  path: string;
  operation: AgentProposalChange['operation'];
  decision: AgentDecision;
  addedLines: number;
  deletedLines: number;
  structural: boolean;
};

const pendingLike = (decision: AgentDecision) =>
  decision === 'pending' || decision === 'conflicted';

export function buildProposalFileModel(input: {
  path: string;
  baseText: string;
  hunks: readonly Pick<
    AgentProposalHunk,
    'id' | 'changeId' | 'baseStart' | 'baseEnd' | 'baseText' | 'replacementText' | 'decision'
  >[];
}): ProposalFileModel {
  const hunks = [...input.hunks].sort((left, right) => left.baseStart - right.baseStart);
  const baseLines = splitLines(input.baseText);
  const segments: ProposalBufferSegment[] = [];
  const deletions: ProposalDeletionZone[] = [];
  let buffer = '';
  let acceptedText = '';
  let cursor = 0;
  let line = 1;
  let addedLineCount = 0;
  let deletedLineCount = 0;

  const pushUnchanged = (text: string) => {
    if (!text) return;
    const start = buffer.length;
    const acceptedStart = acceptedText.length;
    const startLine = line;
    buffer += text;
    acceptedText += text;
    const lines = lineCount(text);
    line += lines;
    segments.push({
      kind: 'unchanged',
      hunkId: null,
      changeId: null,
      decision: null,
      text,
      bufferStart: start,
      bufferEnd: buffer.length,
      startLine,
      endLine: Math.max(startLine, line - 1),
      acceptedStart,
      acceptedEnd: acceptedText.length,
    });
  };

  for (const hunk of hunks) {
    if (hunk.baseStart < cursor || hunk.baseEnd < hunk.baseStart || hunk.baseEnd > baseLines.length)
      throw new Error('Invalid or overlapping proposal hunks');
    pushUnchanged(baseLines.slice(cursor, hunk.baseStart).join(''));
    if (hunk.decision === 'accepted') {
      pushUnchanged(hunk.replacementText);
    } else if (hunk.decision === 'rejected') {
      pushUnchanged(hunk.baseText);
    } else {
      if (hunk.baseText) {
        deletions.push({
          hunkId: hunk.id,
          changeId: hunk.changeId,
          decision: hunk.decision,
          text: hunk.baseText,
          afterLineNumber: line - 1,
          lineCount: lineCount(hunk.baseText),
        });
        acceptedText += hunk.baseText;
        if (pendingLike(hunk.decision)) deletedLineCount += lineCount(hunk.baseText);
      }
      if (hunk.replacementText) {
        const start = buffer.length;
        const startLine = line;
        buffer += hunk.replacementText;
        const lines = lineCount(hunk.replacementText);
        line += lines;
        segments.push({
          kind: 'addition',
          hunkId: hunk.id,
          changeId: hunk.changeId,
          decision: hunk.decision,
          text: hunk.replacementText,
          bufferStart: start,
          bufferEnd: buffer.length,
          startLine,
          endLine: Math.max(startLine, line - 1),
          acceptedStart: null,
          acceptedEnd: null,
        });
        if (pendingLike(hunk.decision)) addedLineCount += lines;
      }
    }
    cursor = hunk.baseEnd;
  }
  pushUnchanged(baseLines.slice(cursor).join(''));
  return {
    path: input.path,
    buffer,
    acceptedText,
    segments,
    deletions,
    addedLineCount,
    deletedLineCount,
  };
}

export function liveProposalHunks(
  changeId: string,
  baseText: string,
  proposedText: string,
): AgentProposalHunk[] {
  return diffLineHunks(baseText, proposedText).map((hunk, order) => ({
    id: `draft:${changeId}:${order}`,
    changeId,
    baseStart: hunk.baseStart,
    baseEnd: hunk.baseEnd,
    baseText: hunk.baseText,
    replacementText: hunk.replacementText,
    contentHash: '0'.repeat(64),
    decision: 'pending',
    order,
  }));
}

export function segmentAtOffset(
  model: ProposalFileModel,
  offset: number,
): ProposalBufferSegment | null {
  if (!model.segments.length) return null;
  const inside = model.segments.find(
    (segment) => offset >= segment.bufferStart && offset < segment.bufferEnd,
  );
  if (inside) return inside;
  if (offset === model.buffer.length) return model.segments.at(-1) ?? null;
  return null;
}

export function hunkAtProjectedLine(model: ProposalFileModel, line: number): string | null {
  const addition = model.segments.find(
    (segment) =>
      segment.kind === 'addition' &&
      segment.hunkId &&
      line >= segment.startLine &&
      line <= segment.endLine,
  );
  if (addition?.hunkId) return addition.hunkId;
  const deletion = model.deletions.find(
    (zone) => line === zone.afterLineNumber || line === zone.afterLineNumber + 1,
  );
  return deletion?.hunkId ?? null;
}

export function clampChangeToStartSegment(
  model: ProposalFileModel,
  change: ProposalBufferChange,
): ProposalBufferChange {
  const segment = segmentAtOffset(model, change.rangeOffset);
  if (!segment) return change;
  const maxEnd = segment.bufferEnd;
  const requestedEnd = change.rangeOffset + change.rangeLength;
  if (requestedEnd <= maxEnd) return change;
  return { ...change, rangeLength: Math.max(0, maxEnd - change.rangeOffset) };
}

export function interpretBufferEdit(
  model: ProposalFileModel,
  rawChange: ProposalBufferChange,
): ProposalEdit {
  const change = clampChangeToStartSegment(model, rawChange);
  const segment = segmentAtOffset(model, change.rangeOffset);
  if (!segment) return { kind: 'ignore' };
  if (segment.kind === 'addition') {
    if (!segment.hunkId || !segment.changeId) return { kind: 'ignore' };
    const localStart = change.rangeOffset - segment.bufferStart;
    const replacementText =
      segment.text.slice(0, localStart) +
      change.text +
      segment.text.slice(localStart + change.rangeLength);
    const nextBuffer =
      model.buffer.slice(0, segment.bufferStart) +
      replacementText +
      model.buffer.slice(segment.bufferEnd);
    return {
      kind: 'addition',
      hunkId: segment.hunkId,
      changeId: segment.changeId,
      replacementText,
      nextBuffer,
    };
  }
  if (segment.acceptedStart === null || segment.acceptedEnd === null) return { kind: 'ignore' };
  const localStart = change.rangeOffset - segment.bufferStart;
  const acceptedStart = segment.acceptedStart + localStart;
  const acceptedEnd = acceptedStart + change.rangeLength;
  const nextAcceptedText =
    model.acceptedText.slice(0, acceptedStart) +
    change.text +
    model.acceptedText.slice(acceptedEnd);
  const nextBuffer =
    model.buffer.slice(0, change.rangeOffset) +
    change.text +
    model.buffer.slice(change.rangeOffset + change.rangeLength);
  return {
    kind: 'unchanged',
    acceptedStart,
    acceptedEnd,
    insertedText: change.text,
    nextAcceptedText,
    nextBuffer,
  };
}

export function applyBufferEdit(
  model: ProposalFileModel,
  change: ProposalBufferChange,
): { model: ProposalFileModel; edit: ProposalEdit } {
  const edit = interpretBufferEdit(model, change);
  if (edit.kind === 'ignore') return { model, edit };
  const clamped = clampChangeToStartSegment(model, change);
  const target = segmentAtOffset(model, clamped.rangeOffset);
  if (!target) return { model, edit };
  const localStart = clamped.rangeOffset - target.bufferStart;
  const nextText =
    target.text.slice(0, localStart) +
    clamped.text +
    target.text.slice(localStart + clamped.rangeLength);
  const delta = nextText.length - target.text.length;
  const lineDelta = lineCount(nextText) - lineCount(target.text);
  const acceptedDelta =
    edit.kind === 'unchanged' ? edit.nextAcceptedText.length - model.acceptedText.length : 0;
  const segments = model.segments.map((segment) => {
    if (segment.bufferStart > target.bufferStart) {
      return {
        ...segment,
        bufferStart: segment.bufferStart + delta,
        bufferEnd: segment.bufferEnd + delta,
        startLine: segment.startLine + lineDelta,
        endLine: segment.endLine + lineDelta,
        acceptedStart:
          segment.acceptedStart === null ? null : segment.acceptedStart + acceptedDelta,
        acceptedEnd: segment.acceptedEnd === null ? null : segment.acceptedEnd + acceptedDelta,
      };
    }
    if (segment.bufferStart !== target.bufferStart) return segment;
    return {
      ...segment,
      text: nextText,
      bufferEnd: segment.bufferStart + nextText.length,
      endLine: Math.max(
        segment.startLine,
        segment.startLine + Math.max(lineCount(nextText) - 1, 0),
      ),
      acceptedEnd: segment.acceptedStart === null ? null : segment.acceptedStart + nextText.length,
    };
  });
  return {
    model: {
      ...model,
      buffer:
        model.buffer.slice(0, clamped.rangeOffset) +
        clamped.text +
        model.buffer.slice(clamped.rangeOffset + clamped.rangeLength),
      acceptedText: edit.kind === 'unchanged' ? edit.nextAcceptedText : model.acceptedText,
      segments,
      deletions: model.deletions.map((zone) =>
        zone.afterLineNumber >= target.startLine
          ? { ...zone, afterLineNumber: zone.afterLineNumber + lineDelta }
          : zone,
      ),
      addedLineCount:
        target.kind === 'addition' ? model.addedLineCount + lineDelta : model.addedLineCount,
    },
    edit,
  };
}

export function countsForChanges(changes: readonly AgentProposalChange[]) {
  let added = 0;
  let deleted = 0;
  for (const change of changes) {
    if (change.decision === 'rejected' || change.decision === 'accepted') continue;
    if (change.hunks.length) {
      for (const hunk of change.hunks) {
        if (!pendingLike(hunk.decision)) continue;
        added += lineCount(hunk.replacementText);
        deleted += lineCount(hunk.baseText);
      }
      continue;
    }
    if (change.operation === 'create_file') added += 1;
    if (change.operation === 'delete') deleted += 1;
  }
  return { added, deleted };
}

export function reviewableItems(changes: readonly AgentProposalChange[]): ReviewableHunk[] {
  const items: ReviewableHunk[] = [];
  for (const change of changes) {
    const path = change.targetPath ?? change.basePath ?? '';
    if (change.hunks.length) {
      for (const hunk of change.hunks) {
        if (!pendingLike(hunk.decision)) continue;
        items.push({
          id: hunk.id,
          changeId: change.id,
          path,
          operation: change.operation,
          decision: hunk.decision,
          addedLines: lineCount(hunk.replacementText),
          deletedLines: lineCount(hunk.baseText),
          structural: false,
        });
      }
      continue;
    }
    if (!pendingLike(change.decision)) continue;
    if (change.operation === 'create_file' || change.operation === 'replace_file') {
      items.push({
        id: change.id,
        changeId: change.id,
        path,
        operation: change.operation,
        decision: change.decision,
        addedLines: change.operation === 'create_file' ? 1 : 0,
        deletedLines: 0,
        structural: false,
      });
      continue;
    }
    if (
      change.operation === 'create_folder' ||
      change.operation === 'move' ||
      change.operation === 'delete'
    ) {
      items.push({
        id: change.id,
        changeId: change.id,
        path,
        operation: change.operation,
        decision: change.decision,
        addedLines: change.operation === 'create_folder' ? 1 : 0,
        deletedLines: change.operation === 'delete' ? 1 : 0,
        structural: true,
      });
    }
  }
  return items;
}

export function hunkWidgetState(
  status: AgentProposalStatus,
  decision: AgentDecision,
): { visible: boolean; acceptEnabled: boolean; rejectEnabled: boolean } {
  const visible = decision === 'pending' || decision === 'conflicted';
  if (!visible) return { visible: false, acceptEnabled: false, rejectEnabled: false };
  if (status !== 'reviewing') return { visible: true, acceptEnabled: false, rejectEnabled: false };
  if (decision === 'conflicted')
    return { visible: true, acceptEnabled: false, rejectEnabled: true };
  return { visible: true, acceptEnabled: true, rejectEnabled: true };
}

export function shouldBlockProposalOverlay(input: {
  saveState?: string | undefined;
  overlayAlreadyActive: boolean;
}): boolean {
  if (input.saveState === 'offline' || input.saveState === 'conflict') return true;
  if (input.overlayAlreadyActive) return false;
  return input.saveState === 'dirty';
}

export function overlayHunksFor(
  status: AgentProposalStatus,
  change: AgentProposalChange,
  baseText: string,
  proposedText: string,
) {
  if (status === 'reviewing' && change.hunks.length > 0) return change.hunks;
  return liveProposalHunks(change.id, baseText, proposedText);
}

export { projectAcceptedHunks, lineCount };
