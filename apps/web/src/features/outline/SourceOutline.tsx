import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Hash,
  Image,
  ListTree,
  LocateFixed,
  MinusSquare,
  Sigma,
  Table,
} from 'lucide-react';
import { IconButton } from '@latex-workshop/ui';
import { api } from '../../lib/api';
import {
  sourceIncludes,
  mergeIncludedOutline,
  numberOutline,
  symbolsToOutline,
  type OutlineNode,
  type SourceSymbol,
} from './outlineModel';
import './outline.css';

export type DocumentSymbolReader = (path: string) => Promise<SourceSymbol[]>;
type OutlineSource = { entryId: string; path: string; content?: string; version: number };
export function SourceOutline({
  projectId,
  sources,
  mainPath,
  readSymbols,
  ready,
  currentPath,
  cursorLine,
  undefinedReferences,
  onOpen,
}: {
  projectId: string;
  sources: OutlineSource[];
  mainPath: string | null;
  readSymbols: DocumentSymbolReader | null;
  ready: boolean;
  currentPath: string | null;
  cursorLine: number;
  undefinedReferences: number;
  onOpen: (node: OutlineNode) => void;
}) {
  const [nodes, setNodes] = useState<OutlineNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState<'all' | 'sections' | 'labels'>('all');
  const [follow, setFollow] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const activeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!ready || !readSymbols || !mainPath) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setLoading(true);
      setFailed(false);
      const run = async () => {
        const visited = new Set<string>();
        const byPath = new Map(sources.map((source) => [source.path, source]));
        const load = async (path: string): Promise<OutlineNode[]> => {
          if (cancelled || visited.has(path) || visited.size >= 256) return [];
          const source = byPath.get(path);
          if (!source) return [];
          visited.add(path);
          const content =
            source.content ??
            (
              await api<{ content: string }>(
                `/api/v1/projects/${projectId}/entries/${source.entryId}/content`,
              )
            ).content;
          const symbols = await readSymbols(path);
          const own = symbolsToOutline(path, content, symbols);
          const included = await Promise.all(
            sourceIncludes(path, content).map(async (include) => ({
              line: include.line,
              nodes: await load(include.path),
            })),
          );
          return mergeIncludedOutline(own, included);
        };
        try {
          const result = await load(mainPath);
          if (!cancelled) setNodes(numberOutline(result));
        } catch {
          if (!cancelled) setFailed(true);
        } finally {
          if (!cancelled) setLoading(false);
        }
      };
      void run();
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [mainPath, projectId, readSymbols, ready, sources]);
  const flat = useMemo(() => {
    const all: OutlineNode[] = [];
    const visit = (items: OutlineNode[]) => {
      for (const item of items) {
        all.push(item);
        visit(item.children);
      }
    };
    visit(nodes);
    return all;
  }, [nodes]);
  const active = flat
    .filter(
      (node) => node.path === currentPath && node.line <= cursorLine && node.endLine >= cursorLine,
    )
    .sort((a, b) => a.endLine - a.line - (b.endLine - b.line))[0];
  useEffect(() => {
    if (!follow || !active) return;
    setCollapsed((old) => {
      const next = new Set(old);
      const reveal = (items: OutlineNode[]): boolean =>
        items.some((node) => {
          const contains = node.id === active.id || reveal(node.children);
          if (contains) next.delete(node.id);
          return contains;
        });
      reveal(nodes);
      return next;
    });
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [active?.id, follow, nodes]);
  const counts = {
    sections: flat.filter((node) => node.category === 'section').length,
    labels: flat.filter((node) => node.label).length,
  };
  const render = (items: OutlineNode[], depth = 0): React.ReactNode =>
    items.map((node) => {
      const visible =
        filter === 'all' ||
        (filter === 'sections' ? node.category === 'section' : Boolean(node.label));
      const Icon =
        node.category === 'section'
          ? Hash
          : node.category === 'equation'
            ? Sigma
            : node.category === 'figure'
              ? Image
              : node.category === 'table'
                ? Table
                : node.category === 'theorem'
                  ? FileText
                  : Hash;
      const selected = active?.id === node.id;
      return (
        <div key={node.id}>
          {visible && (
            <div className="outline-entry" style={{ paddingLeft: depth * 16 }}>
              {node.children.length ? (
                <IconButton
                  compact
                  className="tb-compact"
                  label={`${collapsed.has(node.id) ? 'Expand' : 'Collapse'} ${node.name}`}
                  onClick={() =>
                    setCollapsed((old) => {
                      const next = new Set(old);
                      if (next.has(node.id)) next.delete(node.id);
                      else next.add(node.id);
                      return next;
                    })
                  }
                >
                  {collapsed.has(node.id) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                </IconButton>
              ) : (
                <span className="outline-spacer" />
              )}
              <button
                className="tr outline-row"
                aria-current={selected ? 'true' : undefined}
                title={`${node.path} : ${node.line}`}
                ref={selected ? activeRef : undefined}
                onClick={() => onOpen(node)}
              >
                {node.category === 'section' ? (
                  node.number && <span className="outline-number">{node.number}</span>
                ) : (
                  <Icon size={13} />
                )}
                <span className="outline-name">
                  {node.name}
                  {node.number && node.category !== 'section' ? ` ${node.number}` : ''}
                </span>
                {node.label && node.label !== node.name && <code>{node.label}</code>}
                {depth === 0 && <span className="outline-file">{node.path.split('/').pop()}</span>}
              </button>
            </div>
          )}
          {!collapsed.has(node.id) && render(node.children, depth + (visible ? 1 : 0))}
        </div>
      );
    });
  return (
    <section className="source-outline" aria-label="Source outline">
      <div className="outline-toolbar">
        <div className="seg seg-compact" role="group" aria-label="Outline scope">
          {(['all', 'sections', 'labels'] as const).map((value) => (
            <button
              className="tb"
              aria-pressed={filter === value}
              key={value}
              onClick={() => setFilter(value)}
            >
              {value === 'all' ? 'All' : value === 'sections' ? 'Sections' : 'Labels'}
            </button>
          ))}
        </div>
        <IconButton
          compact
          className="tb-compact"
          label="Follow cursor"
          aria-pressed={follow}
          onClick={() => setFollow((value) => !value)}
        >
          <LocateFixed size={14} />
        </IconButton>
        <IconButton
          compact
          className="tb-compact"
          label="Collapse all"
          onClick={() =>
            setCollapsed(
              new Set(flat.filter((node) => node.children.length).map((node) => node.id)),
            )
          }
        >
          <MinusSquare size={14} />
        </IconButton>
      </div>
      <div className="outline-tree">
        {loading && !nodes.length ? (
          <p className="outline-empty">Loading outline…</p>
        ) : failed ? (
          <p className="outline-empty">Outline unavailable</p>
        ) : !nodes.length ? (
          <p className="outline-empty">
            <ListTree size={16} /> {ready ? 'No source symbols' : 'Connecting to TexLab…'}
          </p>
        ) : (
          render(nodes)
        )}
      </div>
      <footer className="outline-footer">
        <span>
          {counts.sections} sections · {counts.labels} labels
        </span>
        {undefinedReferences > 0 && (
          <span className="outline-warning">
            {undefinedReferences} undefined {undefinedReferences === 1 ? 'ref' : 'refs'}
          </span>
        )}
      </footer>
    </section>
  );
}
