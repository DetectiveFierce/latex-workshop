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
  buildOutline,
  includeCandidates,
  localPackagePaths,
  numberOutline,
  preambleOf,
  rawIncludes,
  scanOutline,
  type OutlineNode,
} from './outlineModel';
import { collectMacros, emptyMacroTable } from './latexMacros';
import './outline.css';

type OutlineSource = { entryId: string; path: string; content?: string; version: number };
const MAX_FILES = 256;

export function SourceOutline({
  projectId,
  sources,
  mainPath,
  currentPath,
  cursorLine,
  undefinedReferences,
  onOpen,
}: {
  projectId: string;
  sources: OutlineSource[];
  mainPath: string | null;
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
    if (!mainPath) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setLoading(true);
      setFailed(false);
      const run = async () => {
        const byPath = new Map(sources.map((source) => [source.path, source]));
        const cache = new Map<string, Promise<string>>();
        const read = (path: string) => {
          const source = byPath.get(path);
          if (!source) return null;
          const cached = cache.get(path);
          if (cached) return cached;
          const content =
            source.content !== undefined
              ? Promise.resolve(source.content)
              : api<{ content: string }>(
                  `/api/v1/projects/${projectId}/entries/${source.entryId}/content`,
                ).then((body) => body.content);
          cache.set(path, content);
          return content;
        };
        const locate = (from: string, target: string) =>
          includeCandidates(mainPath, from, target).find((path) => byPath.has(path));
        const macros = emptyMacroTable();
        const defined = new Set<string>();
        // Dependencies load first so a document's own \renewcommand wins, as it would in TeX.
        const define = async (path: string): Promise<void> => {
          const pending = read(path);
          if (cancelled || !pending || defined.has(path) || defined.size >= MAX_FILES) return;
          defined.add(path);
          const content = await pending;
          const preamble = preambleOf(content);
          const targets = [
            ...rawIncludes(preamble).map(({ target }) => locate(path, target)),
            ...localPackagePaths(preamble).map((target) => locate(path, target)),
          ];
          for (const target of targets) if (target) await define(target);
          collectMacros(preamble, macros);
        };
        await define(mainPath);
        const visited = new Set<string>();
        const walk = async (path: string): Promise<OutlineNode[]> => {
          const pending = read(path);
          if (cancelled || !pending || visited.has(path) || visited.size >= MAX_FILES) return [];
          visited.add(path);
          const content = await pending;
          if (path !== mainPath) await define(path);
          const flat: OutlineNode[] = [];
          for (const event of scanOutline(path, content, macros)) {
            if (event.type === 'node') flat.push(event.node);
            else {
              const target = locate(path, event.target);
              if (target) flat.push(...(await walk(target)));
            }
          }
          return flat;
        };
        try {
          const flat = await walk(mainPath);
          if (!cancelled) setNodes(numberOutline(buildOutline(flat)));
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
  }, [mainPath, projectId, sources]);
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
                title={`${node.name}${node.detail ? ` ${node.detail}` : ''} · ${node.path} : ${node.line}`}
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
                  {node.detail && <span className="outline-detail"> {node.detail}</span>}
                </span>
                {node.label && <code>{node.label}</code>}
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
            <ListTree size={16} /> No sections or labels yet
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
