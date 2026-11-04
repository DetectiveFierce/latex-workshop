import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  File,
  FileSearch,
  Filter,
  LoaderCircle,
  MinusSquare,
  RefreshCw,
  Replace,
  ReplaceAll,
  X,
} from 'lucide-react';
import { IconButton } from '@latex-workshop/ui';
import { classNames } from '../../lib/utils';
import {
  MAX_PROJECT_SEARCH_RESULTS,
  type ProjectSearchOptions,
  type ProjectSearchResult,
  type ProjectSearchSource,
} from './projectSearch';
import '../../styles/workshop-panels.css';

export function ProjectSearchBar({
  query,
  replacement,
  replaceOpen,
  options,
  resultCount,
  activeResult,
  loading,
  error,
  replacing,
  onQuery,
  onReplacement,
  onReplaceOpen,
  onOptions,
  onPrevious,
  onNext,
  onReplace,
  onReplaceAll,
  onClose,
}: {
  query: string;
  replacement: string;
  replaceOpen: boolean;
  options: ProjectSearchOptions;
  resultCount: number;
  activeResult: number;
  loading: boolean;
  error: string | null;
  replacing: boolean;
  onQuery: (value: string) => void;
  onReplacement: (value: string) => void;
  onReplaceOpen: (open: boolean) => void;
  onOptions: (options: ProjectSearchOptions) => void;
  onPrevious: () => void;
  onNext: () => void;
  onReplace: () => void;
  onReplaceAll: () => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  return (
    <div className="project-find-bar" role="search">
      <div className="project-find-row">
        <IconButton
          className="tb-xs"
          compact
          label={replaceOpen ? 'Hide replace' : 'Show replace'}
          aria-expanded={replaceOpen}
          onClick={() => onReplaceOpen(!replaceOpen)}
        >
          {replaceOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </IconButton>
        <div className={classNames('project-find-input', error && 'invalid')}>
          <input
            ref={inputRef}
            value={query}
            aria-label="Search the current project"
            aria-invalid={Boolean(error)}
            title={error ?? undefined}
            onChange={(event) => onQuery(event.target.value)}
            placeholder="Search"
            onKeyDown={(event) => {
              if (event.key === 'Escape') onClose();
              if (event.key === 'Enter') {
                event.preventDefault();
                if (event.shiftKey) onPrevious();
                else onNext();
              }
            }}
          />
          <SearchOption
            label="Match case"
            text="Aa"
            pressed={options.caseSensitive}
            onClick={() => onOptions({ ...options, caseSensitive: !options.caseSensitive })}
          />
          <SearchOption
            label="Match whole word"
            text="ab"
            underlined
            pressed={options.wholeWord}
            onClick={() => onOptions({ ...options, wholeWord: !options.wholeWord })}
          />
          <SearchOption
            label="Use regular expression"
            text=".*"
            pressed={options.useRegex}
            onClick={() => onOptions({ ...options, useRegex: !options.useRegex })}
          />
        </div>
      </div>
      {replaceOpen && (
        <div className="project-find-row project-replace-row">
          <span className="project-find-spacer" />
          <div className="project-find-input">
            <input
              value={replacement}
              aria-label="Replace in the current project"
              placeholder="Replace"
              onChange={(event) => onReplacement(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') onClose();
                if (event.key === 'Enter' && resultCount) {
                  event.preventDefault();
                  onReplace();
                }
              }}
            />
            <IconButton
              className="tb-xs"
              compact
              label="Replace selected project result"
              disabled={!resultCount || replacing}
              onClick={onReplace}
            >
              <Replace size={14} />
            </IconButton>
            <IconButton
              className="tb-xs"
              compact
              label={`Replace all ${resultCount} project results`}
              disabled={!resultCount || replacing}
              onClick={onReplaceAll}
            >
              {replacing ? <LoaderCircle size={14} className="spin" /> : <ReplaceAll size={14} />}
            </IconButton>
          </div>
        </div>
      )}
      <div className="sr-only" role="status">
        {loading
          ? 'Searching'
          : error
            ? 'Invalid expression'
            : resultCount
              ? `${activeResult + 1} of ${resultCount}${resultCount === MAX_PROJECT_SEARCH_RESULTS ? '+' : ''}`
              : query
                ? 'No results'
                : ''}
      </div>
    </div>
  );
}
function SearchOption({
  label,
  text,
  pressed,
  underlined = false,
  onClick,
}: {
  label: string;
  text: string;
  pressed: boolean;
  underlined?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={classNames('sx-opt', underlined && 'search-whole-word')}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
    >
      {text}
    </button>
  );
}
export function ProjectSearchResults({
  query,
  results,
  sources,
  active,
  loading,
  failedFiles,
  onActive,
  onOpen,
  onReplace,
  onRefresh,
  onClear,
}: {
  query: string;
  results: ProjectSearchResult[];
  sources: ProjectSearchSource[];
  active: number;
  loading: boolean;
  failedFiles: number;
  onActive: (index: number) => void;
  onOpen: (result: ProjectSearchResult) => void;
  onReplace?: (result: ProjectSearchResult) => void;
  onRefresh?: () => void;
  onClear?: () => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [filterOpen, setFilterOpen] = useState(false);
  const [include, setInclude] = useState('');
  const [exclude, setExclude] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setDismissed(new Set());
  }, [query, results]);
  useEffect(() => {
    rootRef.current
      ?.querySelector<HTMLElement>(`[data-result-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  const groups = useMemo(() => {
    const values = new Map<
      string,
      { entryId: string; path: string; results: { result: ProjectSearchResult; index: number }[] }
    >();
    results.forEach((result, index) => {
      if (dismissed.has(resultKey(result)) || !matchesPath(result.path, include, exclude)) return;
      const group = values.get(result.entryId) ?? {
        entryId: result.entryId,
        path: result.path,
        results: [],
      };
      group.results.push({ result, index });
      values.set(result.entryId, group);
    });
    return [...values.values()];
  }, [results, dismissed, include, exclude]);
  const count = groups.reduce((sum, group) => sum + group.results.length, 0);
  return (
    <div ref={rootRef} className="project-results" aria-label="Project search results">
      <div className="project-results-heading">
        <span>
          <strong>{count}</strong> results in <strong>{groups.length}</strong> files
        </span>
        <span className="spacer" />
        <IconButton
          className="tb-xs"
          compact
          label="Filter files"
          aria-expanded={filterOpen}
          onClick={() => setFilterOpen((value) => !value)}
        >
          <Filter size={13} />
        </IconButton>
        <IconButton
          className="tb-xs"
          compact
          label="Refresh search"
          onClick={() => {
            setDismissed(new Set());
            onRefresh?.();
          }}
        >
          <RefreshCw size={13} />
        </IconButton>
        <IconButton
          className="tb-xs"
          compact
          label="Collapse all results"
          onClick={() => setCollapsed(new Set(groups.map((group) => group.entryId)))}
        >
          <MinusSquare size={13} />
        </IconButton>
        <IconButton
          className="tb-xs"
          compact
          label="Clear search"
          onClick={() => {
            setDismissed(new Set(results.map(resultKey)));
            onClear?.();
          }}
        >
          <X size={13} />
        </IconButton>
      </div>
      {filterOpen && (
        <div className="project-search-filters">
          <input
            className="fld fld-compact"
            aria-label="Files to include"
            placeholder="Files to include, e.g. sections/*.tex"
            value={include}
            onChange={(event) => setInclude(event.target.value)}
          />
          <input
            className="fld fld-compact"
            aria-label="Files to exclude"
            placeholder="Files to exclude"
            value={exclude}
            onChange={(event) => setExclude(event.target.value)}
          />
        </div>
      )}
      {loading ? (
        <div className="project-results-empty">
          <LoaderCircle size={20} className="spin" />
          <p>Searching</p>
        </div>
      ) : !query.trim() ? (
        <div className="project-results-empty">
          <FileSearch size={24} />
          <p>Search in project</p>
        </div>
      ) : !count ? (
        <p className="hint">No results in {sources.length} files</p>
      ) : (
        groups.map((group) => {
          const slash = group.path.lastIndexOf('/');
          const filename = group.path.slice(slash + 1);
          const folder = slash < 0 ? '' : group.path.slice(0, slash);
          return (
            <section className="project-result-group" key={group.entryId}>
              <button
                className="project-result-file"
                aria-expanded={!collapsed.has(group.entryId)}
                onClick={() => setCollapsed((values) => toggleSet(values, group.entryId))}
              >
                {collapsed.has(group.entryId) ? (
                  <ChevronRight size={13} />
                ) : (
                  <ChevronDown size={13} />
                )}
                <File size={14} />
                <strong>{filename}</strong>
                <span className="project-result-folder">{folder}</span>
                <span className="cnt">{group.results.length}</span>
              </button>
              {!collapsed.has(group.entryId) && (
                <div className="project-result-matches">
                  {group.results.map(({ result, index }) => (
                    <div
                      className={classNames('project-result', active === index && 'active')}
                      key={resultKey(result)}
                      data-result-index={index}
                    >
                      <button
                        className="project-result-row"
                        onClick={() => {
                          onActive(index);
                          onOpen(result);
                        }}
                        title={`${result.path} : ${result.line}`}
                      >
                        <span className="project-result-location tnum">{result.line}</span>
                        <code>{preview(result)}</code>
                      </button>
                      <div className="project-result-actions">
                        {onReplace && (
                          <IconButton
                            className="tb-xs"
                            compact
                            label="Replace this match"
                            onClick={() => onReplace(result)}
                          >
                            <Replace size={12} />
                          </IconButton>
                        )}
                        <IconButton
                          className="tb-xs"
                          compact
                          label="Dismiss this match"
                          onClick={() =>
                            setDismissed((values) => new Set([...values, resultKey(result)]))
                          }
                        >
                          <X size={12} />
                        </IconButton>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          );
        })
      )}
      {failedFiles > 0 && <p className="hint">{failedFiles} files unavailable</p>}
    </div>
  );
}
function resultKey(result: ProjectSearchResult) {
  return `${result.entryId}:${result.startOffset}:${result.endOffset}`;
}
function preview(result: ProjectSearchResult) {
  const start = Math.max(0, result.column - 1);
  const left = Math.max(0, start - 12);
  const right = Math.min(result.preview.length, start + Math.max(1, result.match.length) + 72);
  return (
    <>
      {left > 0 && '…'}
      {result.preview.slice(left, start)}
      <mark className="mark">{result.preview.slice(start, start + result.match.length)}</mark>
      {result.preview.slice(start + result.match.length, right)}
      {right < result.preview.length && '…'}
    </>
  );
}
function toggleSet(values: Set<string>, key: string) {
  const next = new Set(values);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}
function matchesPath(path: string, include: string, exclude: string) {
  const matches = (pattern: string) => {
    const escaped = pattern
      .trim()
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replaceAll('*', '.*');
    return new RegExp(escaped, 'i').test(path);
  };
  return (
    (!include.trim() || include.split(',').some(matches)) &&
    (!exclude.trim() || !exclude.split(',').some(matches))
  );
}
