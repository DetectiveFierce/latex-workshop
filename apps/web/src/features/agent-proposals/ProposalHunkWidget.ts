export function createProposalHunkWidget(input: {
  acceptEnabled: boolean;
  rejectEnabled: boolean;
  onAccept: () => void;
  onReject: () => void;
}): HTMLElement {
  const root = document.createElement('div');
  root.className = 'proposal-hunk-widget';
  const accept = document.createElement('button');
  accept.type = 'button';
  accept.className = 'proposal-hunk-accept';
  accept.textContent = '✓';
  accept.setAttribute('aria-label', 'Accept hunk');
  accept.disabled = !input.acceptEnabled;
  accept.addEventListener('mousedown', (event) => event.preventDefault());
  accept.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!accept.disabled) input.onAccept();
  });
  const reject = document.createElement('button');
  reject.type = 'button';
  reject.className = 'proposal-hunk-reject';
  reject.textContent = '✕';
  reject.setAttribute('aria-label', 'Reject hunk');
  reject.disabled = !input.rejectEnabled;
  reject.addEventListener('mousedown', (event) => event.preventDefault());
  reject.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!reject.disabled) input.onReject();
  });
  root.append(accept, reject);
  return root;
}
