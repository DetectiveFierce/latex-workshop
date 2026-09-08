import type * as Monaco from 'monaco-editor';
import { hunkWidgetState, type ProposalFileModel } from './proposalDiffModel';
import { createProposalHunkWidget } from './ProposalHunkWidget';
import type { AgentDecision, AgentProposalStatus } from '@latex-workshop/contracts';

export function syncProposalOverlay(
  monaco: typeof Monaco,
  editor: Monaco.editor.IStandaloneCodeEditor,
  overlay: {
    model: ProposalFileModel;
    status: AgentProposalStatus;
    selectedHunkId: string | null;
    onSelectHunk: (hunkId: string) => void;
    onDecide: (hunkId: string, decision: 'accepted' | 'rejected') => void;
  } | null,
): () => void {
  const decorationIds: string[] = [];
  const zoneIds: string[] = [];
  let widget: Monaco.editor.IContentWidget | null = null;
  if (!overlay) return () => undefined;

  const { model } = overlay;
  for (const segment of model.segments) {
    if (segment.kind !== 'addition') continue;
    decorationIds.push(
      ...editor.deltaDecorations(
        [],
        [
          {
            range: new monaco.Range(segment.startLine, 1, segment.endLine, 1),
            options: {
              isWholeLine: true,
              className: 'proposal-addition-line',
              glyphMarginClassName: 'proposal-addition-gutter',
              stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
            },
          },
        ],
      ),
    );
  }

  editor.changeViewZones((accessor) => {
    for (const zone of model.deletions) {
      // Monaco marks its view-zone layer aria-hidden. Keep this visual target out of
      // the tab order; the accessible hunk navigator supplies keyboard decisions.
      const node = document.createElement('div');
      node.className = 'proposal-deletion-zone';
      node.textContent = zone.text.replace(/\n$/, '');
      node.setAttribute('data-proposal-hunk', zone.hunkId);
      node.addEventListener('click', () => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        overlay.onSelectHunk(zone.hunkId);
      });
      zoneIds.push(
        accessor.addZone({
          afterLineNumber: zone.afterLineNumber,
          heightInLines: Math.max(zone.lineCount, 1),
          domNode: node,
        }),
      );
    }
  });

  const selected =
    model.segments.find(
      (segment) => segment.kind === 'addition' && segment.hunkId === overlay.selectedHunkId,
    ) ?? null;
  const selectedDeletion =
    model.deletions.find((zone) => zone.hunkId === overlay.selectedHunkId) ?? null;
  const selectedDecision: AgentDecision | null =
    selected?.decision ?? selectedDeletion?.decision ?? null;
  const bottomLine = selected
    ? selected.endLine
    : selectedDeletion
      ? Math.max(selectedDeletion.afterLineNumber, 1)
      : null;
  if (bottomLine && overlay.selectedHunkId) {
    const visible = editor
      .getVisibleRanges()
      .some((range) => bottomLine >= range.startLineNumber && bottomLine <= range.endLineNumber);
    if (!visible) editor.revealLineInCenter(bottomLine);
    if (selected) {
      const current = editor.getPosition();
      if (
        !current ||
        current.lineNumber < selected.startLine ||
        current.lineNumber > selected.endLine
      )
        editor.setPosition({ lineNumber: selected.startLine, column: 1 });
    }
  }
  if (bottomLine && overlay.selectedHunkId && selectedDecision) {
    const state = hunkWidgetState(overlay.status, selectedDecision);
    if (state.visible) {
      const hunkId = overlay.selectedHunkId;
      const node = createProposalHunkWidget({
        acceptEnabled: state.acceptEnabled,
        rejectEnabled: state.rejectEnabled,
        onAccept: () => overlay.onDecide(hunkId, 'accepted'),
        onReject: () => overlay.onDecide(hunkId, 'rejected'),
      });
      widget = {
        getId: () => 'latex-workshop.proposal-hunk-widget',
        getDomNode: () => node,
        getPosition: () => ({
          position: { lineNumber: bottomLine, column: 1 },
          preference: [monaco.editor.ContentWidgetPositionPreference.BELOW],
        }),
      };
      editor.addContentWidget(widget);
    }
  }

  return () => {
    editor.deltaDecorations(decorationIds, []);
    editor.changeViewZones((accessor) => {
      for (const id of zoneIds) accessor.removeZone(id);
    });
    if (widget) editor.removeContentWidget(widget);
  };
}
