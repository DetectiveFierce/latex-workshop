import { useEffect, useMemo, useState } from 'react';
import { FileSearch, LoaderCircle } from 'lucide-react';
import { Dialog } from '../../components/Dialog';
import {
  MAX_PROJECT_SEARCH_RESULTS,
  searchProjectSources,
  type ProjectSearchResult,
  type ProjectSearchSource,
} from './projectSearch';

export function ProjectSearchDialog({
  open,
  onOpenChange,
  query,
  onQuery,
  sources,
  loading,
  failedFiles,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  query: string;
  onQuery: (query: string) => void;
  sources: ProjectSearchSource[];
  loading: boolean;
  failedFiles: number;
  onSelect: (result: ProjectSearchResult) => void;
}) {
  const [active, setActive] = useState(0);
  const results = useMemo(() => searchProjectSources(sources, query), [query, sources]);
  const hasQuery = Boolean(query.trim());
  useEffect(() => setActive(0), [open, query]);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Search project"
      description="Find text across every source file in this project."
      wide
    >
      <div className="project-search">
        <label className="searchbox">
          {loading ? <LoaderCircle className="spin" size={16} /> : <FileSearch size={16} />}
          <span className="sr-only">Search project source files</span>
          <input
            autoFocus
            className="input"
            type="search"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActive((value) => Math.min(results.length - 1, value + 1));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActive((value) => Math.max(0, value - 1));
              } else if (event.key === 'Enter' && results[active]) {
                event.preventDefault();
                onSelect(results[active]);
              }
            }}
            placeholder="Search source files…"
          />
        </label>
        <div className="project-search-summary" role="status">
          {loading
            ? 'Loading source files…'
            : hasQuery
              ? `${results.length}${results.length === MAX_PROJECT_SEARCH_RESULTS ? '+' : ''} result${results.length === 1 ? '' : 's'} in ${sources.length} file${sources.length === 1 ? '' : 's'}`
              : `${sources.length} source file${sources.length === 1 ? '' : 's'} ready`}
          {failedFiles > 0 && ` · ${failedFiles} file${failedFiles === 1 ? '' : 's'} unavailable`}
        </div>
        <div className="project-search-results" role="listbox" aria-label="Project search results">
          {results.map((result, index) => (
            <button
              key={`${result.entryId}:${result.line}:${result.column}`}
              type="button"
              role="option"
              aria-selected={index === active}
              className={index === active ? 'active' : ''}
              onMouseEnter={() => setActive(index)}
              onClick={() => onSelect(result)}
            >
              <span className="project-search-location">
                <strong>{result.path}</strong>
                <span>
                  {result.line}:{result.column}
                </span>
              </span>
              <code>{result.preview}</code>
            </button>
          ))}
          {!loading && hasQuery && !results.length && <p className="hint">No matches found.</p>}
          {!hasQuery && <p className="hint">Type a word or phrase to search.</p>}
        </div>
      </div>
    </Dialog>
  );
}
