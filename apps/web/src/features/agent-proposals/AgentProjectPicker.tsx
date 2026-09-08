import type { Project } from '@latex-workshop/contracts';
import { classNames } from '../../lib/utils';

export function AgentProjectPicker({
  projects,
  selected,
  allProjects,
  onChange,
  onAllProjectsChange,
  disabled = false,
  labelledBy,
}: {
  projects: Project[];
  selected: readonly string[];
  allProjects: boolean;
  onChange: (projectIds: string[]) => void;
  onAllProjectsChange: (allProjects: boolean) => void;
  disabled?: boolean;
  labelledBy?: string | undefined;
}) {
  const visibleSelected = allProjects ? projects.map((project) => project.id) : selected;
  return (
    <div className="agent-project-picker" role="group" aria-labelledby={labelledBy}>
      <button
        type="button"
        className={classNames('agent-project-option', allProjects && 'selected')}
        aria-pressed={allProjects}
        aria-label="All current and future projects"
        disabled={disabled}
        onClick={() => {
          const next = !allProjects;
          onAllProjectsChange(next);
          if (next) onChange(projects.map((project) => project.id));
        }}
      >
        <span
          className={classNames('agent-project-mark', allProjects && 'checked')}
          aria-hidden="true"
        />
        <span>All current and future projects</span>
      </button>
      {projects.length === 0 ? (
        <p className="hint">No projects yet.</p>
      ) : (
        projects.map((project) => {
          const on = visibleSelected.includes(project.id);
          return (
            <button
              key={project.id}
              type="button"
              className={classNames('agent-project-option', on && 'selected')}
              aria-pressed={on}
              aria-label={project.name}
              disabled={disabled}
              onClick={() => {
                if (allProjects) {
                  onAllProjectsChange(false);
                  onChange(projects.map((item) => item.id).filter((id) => id !== project.id));
                  return;
                }
                onChange(
                  on ? selected.filter((id) => id !== project.id) : [...selected, project.id],
                );
              }}
            >
              <span
                className={classNames('agent-project-mark', on && 'checked')}
                aria-hidden="true"
              />
              <span>{project.name}</span>
            </button>
          );
        })
      )}
    </div>
  );
}
