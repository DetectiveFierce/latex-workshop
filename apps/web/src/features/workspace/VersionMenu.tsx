import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useQuery } from '@tanstack/react-query';
import { History } from 'lucide-react';
import { IconButton } from '@latex-workshop/ui';
import type { Checkpoint } from '@latex-workshop/contracts';
import { api, queryKeys } from '../../lib/api';
import { formatRelative } from '../../lib/utils';

export function VersionMenu({ projectId, onOpen }: { projectId: string; onOpen: () => void }) {
  const query = useQuery({
    queryKey: queryKeys.checkpoints(projectId),
    queryFn: () => api<{ checkpoints: Checkpoint[] }>(`/api/v1/projects/${projectId}/checkpoints`),
    staleTime: 15_000,
  });
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <IconButton label="Version history">
          <History size={17} />
        </IconButton>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu" align="end" sideOffset={6}>
          <DropdownMenu.Label className="mhead">Recent checkpoints</DropdownMenu.Label>
          {query.data?.checkpoints.slice(0, 5).map((checkpoint) => (
            <DropdownMenu.Item
              className="mi version-menu-item"
              key={checkpoint.id}
              onSelect={onOpen}
            >
              <span
                className="dot"
                data-tone={checkpoint.reason === 'proposal' ? 'warn' : undefined}
              />
              <span>
                Revision {checkpoint.sourceRevision}
                <small>
                  {checkpoint.label ??
                    (checkpoint.reason === 'compile'
                      ? 'Compiled'
                      : checkpoint.reason === 'proposal'
                        ? 'Agent edit'
                        : checkpoint.reason)}
                </small>
              </span>
              <span className="end">{formatRelative(checkpoint.createdAt)}</span>
            </DropdownMenu.Item>
          ))}
          {!query.data?.checkpoints.length && (
            <p className="mhead">{query.isPending ? 'Loading…' : 'No checkpoints'}</p>
          )}
          <DropdownMenu.Separator className="msep" />
          <DropdownMenu.Item className="mi" onSelect={onOpen}>
            <History size={15} />
            Open version history
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
