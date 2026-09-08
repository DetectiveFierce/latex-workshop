import { Check, ChevronDown, ChevronUp, Snowflake, X } from 'lucide-react';
import type { AgentProposalStatus, CompileJob } from '@latex-workshop/contracts';
import { Button, IconButton } from '../../components/Button';
import type { ReviewableHunk } from './proposalDiffModel';
import { canDiscardProposal } from './proposalActiveState';

export function ProposalEditorDock({
  status,
  currentAdded,
  currentDeleted,
  items,
  selectedId,
  expanded,
  busy,
  previewTarget,
  compileStatus,
  error,
  onToggle,
  onSelect,
  onDecide,
  onAcceptAll,
  onRejectAll,
  onPreviewTarget,
  onFinish,
}: {
  status: AgentProposalStatus;
  currentAdded: number;
  currentDeleted: number;
  items: ReviewableHunk[];
  selectedId: string | null;
  expanded: boolean;
  busy: boolean;
  previewTarget: 'accepted' | 'proposal';
  compileStatus?: CompileJob['status'] | null;
  error: string;
  onToggle: () => void;
  onSelect: (item: ReviewableHunk) => void;
  onDecide: (itemId: string, decision: 'accepted' | 'rejected') => void;
  onAcceptAll: () => void;
  onRejectAll: () => void;
  onPreviewTarget: (target: 'accepted' | 'proposal') => void;
  onFinish: () => void;
}) {
  const reviewing = status === 'reviewing';
  const hasConflict = items.some((item) => item.decision === 'conflicted');
  const canAccept = !busy && reviewing && !hasConflict && items.length > 0;
  const canReject = canDiscardProposal(status, busy) && (!reviewing || items.length > 0);
  return (
    <div className="proposal-editor-dock" data-expanded={expanded ? 'true' : 'false'}>
      {expanded && (
        <div className="proposal-editor-dock-panel">
          <div className="proposal-editor-dock-context">
            <div className="proposal-preview-toggle" aria-label="PDF source">
              <button
                className={previewTarget === 'accepted' ? 'active' : ''}
                onClick={() => onPreviewTarget('accepted')}
              >
                Accepted
              </button>
              <button
                className={previewTarget === 'proposal' ? 'active' : ''}
                onClick={() => onPreviewTarget('proposal')}
              >
                Proposal
              </button>
            </div>
            {compileStatus && (
              <span className={compileStatus === 'failed' ? 'status-error' : 'status-ok'}>
                PDF {compileStatus}
              </span>
            )}
            {!reviewing && (
              <Button disabled={busy} onClick={onFinish}>
                <Snowflake size={14} /> Stop and review
              </Button>
            )}
          </div>
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
          <ul className="proposal-hunk-nav">
            {items.map((item) => (
              <li key={item.id}>
                <div className="proposal-hunk-nav-row">
                  <button
                    type="button"
                    className={selectedId === item.id ? 'active' : ''}
                    onClick={() => onSelect(item)}
                  >
                    <span>{item.path}</span>
                    <span>
                      {item.structural
                        ? item.operation.replace('_', ' ')
                        : `+${item.addedLines} −${item.deletedLines}`}
                    </span>
                  </button>
                  {item.structural && (
                    <span className="proposal-structural-actions">
                      <button
                        type="button"
                        aria-label={`Accept ${item.path}`}
                        disabled={busy || !reviewing || item.decision === 'conflicted'}
                        onClick={() => onDecide(item.id, 'accepted')}
                      >
                        <Check size={13} />
                      </button>
                      <button
                        type="button"
                        aria-label={`Reject ${item.path}`}
                        disabled={busy || !reviewing}
                        onClick={() => onDecide(item.id, 'rejected')}
                      >
                        <X size={13} />
                      </button>
                    </span>
                  )}
                </div>
              </li>
            ))}
            {items.length === 0 && <li className="hint">No pending changes</li>}
          </ul>
        </div>
      )}
      <div className="proposal-editor-dock-surface" aria-label="Proposal decisions">
        <IconButton
          className="proposal-editor-decision proposal-editor-reject"
          label={reviewing ? 'Reject all proposed changes' : 'Discard unfinished proposal'}
          disabled={!canReject}
          onClick={onRejectAll}
        >
          <X size={15} />
        </IconButton>
        <button
          type="button"
          className="proposal-editor-dock-toggle"
          aria-expanded={expanded}
          aria-label={expanded ? 'Collapse proposal details' : 'Expand proposal details'}
          title={expanded ? 'Collapse proposal details' : 'Expand proposal details'}
          onClick={onToggle}
        >
          {expanded ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
          <span className="proposal-count-add">+{currentAdded}</span>
          <span className="proposal-count-del">−{currentDeleted}</span>
        </button>
        <IconButton
          className="proposal-editor-decision proposal-editor-accept"
          label="Accept all proposed changes"
          disabled={!canAccept}
          onClick={onAcceptAll}
        >
          <Check size={15} />
        </IconButton>
      </div>
    </div>
  );
}
