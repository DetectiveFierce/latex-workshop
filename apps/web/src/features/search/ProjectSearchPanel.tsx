import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  FileSearch,
  LoaderCircle,
  Replace,
  ReplaceAll,
  X,
} from 'lucide-react';
import { IconButton } from '../../components/Button';
import { classNames } from '../../lib/utils';
import {
  MAX_PROJECT_SEARCH_RESULTS,
  type ProjectSearchOptions,
  type ProjectSearchResult,
  type ProjectSearchSource,
} from './projectSearch';

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

  const status = loading
    ? 'Loading…'
    : error
      ? 'Invalid expression'
      : resultCount
        ? `${activeResult + 1} of ${resultCount}${resultCount === MAX_PROJECT_SEARCH_RESULTS ? '+' : ''}`
        : query.trim()
          ? 'No results'
          : 'Search the current project';

  return (
    <div className={classNames('project-find-bar', replaceOpen && 'replace-open')} role="search">
      <div className="project-find-row">
        <IconButton
          className="project-find-toggle"
          label={replaceOpen ? 'Hide Replace in current project' : 'Replace in current project'}
          aria-expanded={replaceOpen}
          onClick={() => onReplaceOpen(!replaceOpen)}
        >
          {replaceOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </IconButton>
        <div className={classNames('project-find-input', error && 'invalid')}>
          {loading ? <LoaderCircle className="spin" size={15} /> : <FileSearch size={15} />}
          <input
            ref={inputRef}
            type="search"
            value={query}
            aria-label="Search the current project"
            aria-invalid={Boolean(error)}
            title={error ?? undefined}
            onChange={(event) => onQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') onClose();
              else if (event.key === 'Enter') {
                event.preventDefault();
                if (event.shiftKey) onPrevious();
                else onNext();
              }
            }}
            placeholder="Search the current project"
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
        <span className={classNames('project-find-count', error && 'error')} role="status">
          {status}
        </span>
        <IconButton label="Previous project result" disabled={!resultCount} onClick={onPrevious}>
          <ChevronUp size={15} />
        </IconButton>
        <IconButton label="Next project result" disabled={!resultCount} onClick={onNext}>
          <ChevronDown size={15} />
        </IconButton>
        <IconButton label="Close project search" onClick={onClose}>
          <X size={15} />
        </IconButton>
      </div>
      {replaceOpen && (
        <div className="project-find-row project-replace-row">
          <div className="project-find-spacer" />
          <div className="project-find-input">
            <Replace size={15} />
            <input
              value={replacement}
              aria-label="Replace in the current project"
              onChange={(event) => onReplacement(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') onClose();
                else if (event.key === 'Enter' && resultCount) {
                  event.preventDefault();
                  onReplace();
                }
              }}
              placeholder="Replace in the current project"
            />
          </div>
          <IconButton
            label="Replace selected project result"
            disabled={!resultCount || replacing}
            onClick={onReplace}
          >
            <Replace size={15} />
          </IconButton>
          <IconButton
            label={`Replace all ${resultCount} project results`}
            disabled={!resultCount || replacing}
            onClick={onReplaceAll}
          >
            {replacing ? <LoaderCircle className="spin" size={15} /> : <ReplaceAll size={15} />}
          </IconButton>
        </div>
      )}
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
      className={classNames('project-find-option', pressed && 'active', underlined && 'underlined')}
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
}: {
  query: string;
  results: ProjectSearchResult[];
  sources: ProjectSearchSource[];
  active: number;
  loading: boolean;
  failedFiles: number;
  onActive: (index: number) => void;
  onOpen: (result: ProjectSearchResult) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const rootRef = useRef<HTMLDivElement>(null);
  const sourceById = useMemo(
    () => new Map(sources.map((source) => [source.entryId, source])),
    [sources],
  );
  const groups = useMemo(() => groupResults(results), [results]);

  useEffect(() => {
    rootRef.current
      ?.querySelector<HTMLElement>(`[data-result-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (loading)
    return (
      <div className="project-results-empty">
        <LoaderCircle className="spin" size={26} />
        <p>Loading project source files…</p>
      </div>
    );
  if (!query.trim())
    return (
      <div className="project-results-empty">
        <FileSearch size={32} />
        <p>Search results will appear in this tab.</p>
      </div>
    );
  if (!results.length)
    return (
      <div className="project-results-empty">
        <FileSearch size={32} />
        <p>No matches found in {sources.length} source files.</p>
        {failedFiles > 0 && <small>{failedFiles} files could not be loaded.</small>}
      </div>
    );

  let globalIndex = 0;
  return (
    <div
      ref={rootRef}
      className="project-results"
      role="listbox"
      aria-label="Project search results"
    >
      <div className="project-results-heading">
        <strong>
          {results.length}
          {results.length === MAX_PROJECT_SEARCH_RESULTS ? '+' : ''} match
          {results.length === 1 ? '' : 'es'}
        </strong>
        <span>
          {groups.length} file{groups.length === 1 ? '' : 's'}
          {failedFiles > 0 && ` · ${failedFiles} unavailable`}
        </span>
      </div>
      {groups.map((group) => (
        <section className="project-result-group" key={group.entryId}>
          <header>
            <FileSearch size={14} />
            <strong>{group.path}</strong>
            <span>{group.results.length}</span>
          </header>
          {group.results.map((result) => {
            const index = globalIndex++;
            const key = resultKey(result);
            const isExpanded = expanded.has(key);
            return (
              <div
                key={key}
                data-result-index={index}
                className={classNames('project-result', active === index && 'active')}
                role="option"
                aria-selected={active === index}
              >
                <div
                  className="project-result-row"
                  tabIndex={0}
                  onClick={() => onActive(index)}
                  onDoubleClick={() => onOpen(result)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') onOpen(result);
                    else if (event.key === ' ') {
                      event.preventDefault();
                      setExpanded(toggleSet(expanded, key));
                    }
                  }}
                >
                  <IconButton
                    label={isExpanded ? 'Fold result context' : 'Unfold result context'}
                    aria-expanded={isExpanded}
                    onClick={(event) => {
                      event.stopPropagation();
                      setExpanded(toggleSet(expanded, key));
                    }}
                  >
                    {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </IconButton>
                  <span className="project-result-location">
                    {result.line}:{result.column}
                  </span>
                  <code>{compactPreview(result)}</code>
                </div>
                {isExpanded && (
                  <div className="project-result-context" onDoubleClick={() => onOpen(result)}>
                    {contextLines(sourceById.get(result.entryId), result).map((line) => (
                      <div
                        className={line.number === result.line ? 'match-line' : ''}
                        key={line.number}
                      >
                        <span>{line.number}</span>
                        <code>{line.text || ' '}</code>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}

function groupResults(results: ProjectSearchResult[]) {
  const groups = new Map<
    string,
    { entryId: string; path: string; results: ProjectSearchResult[] }
  >();
  for (const result of results) {
    const group = groups.get(result.entryId) ?? {
      entryId: result.entryId,
      path: result.path,
      results: [],
    };
    group.results.push(result);
    groups.set(result.entryId, group);
  }
  return [...groups.values()];
}

function resultKey(result: ProjectSearchResult) {
  return `${result.entryId}:${result.startOffset}:${result.endOffset}`;
}

function compactPreview(result: ProjectSearchResult) {
  const matchStart = result.column - 1;
  const left = Math.max(0, matchStart - 52);
  const right = Math.min(result.preview.length, matchStart + result.match.length + 72);
  return `${left ? '…' : ''}${result.preview.slice(left, right).trimEnd()}${right < result.preview.length ? '…' : ''}`;
}

function contextLines(source: ProjectSearchSource | undefined, result: ProjectSearchResult) {
  if (!source) return [{ number: result.line, text: result.preview }];
  const lines = source.content.split(/\r?\n/);
  const start = Math.max(0, result.line - 3);
  const end = Math.min(lines.length, result.line + 2);
  return lines.slice(start, end).map((text, index) => ({ number: start + index + 1, text }));
}

function toggleSet(values: Set<string>, key: string) {
  const next = new Set(values);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}
