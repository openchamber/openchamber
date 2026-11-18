import React from 'react';
import { ProjectIcon } from '@/components/layout/SessionProjectIcon';
import type { ProjectEntry } from '@/lib/api/types';
import { cn, formatDirectoryName } from '@/lib/utils';
import { useDirectoryStore } from '@/stores/useDirectoryStore';

/** A project's icon and name on one line, as the project rail and the pickers of these pages show them. */
export function ProjectLabel({ project }: { project: ProjectEntry }) {
  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <ProjectIcon project={project} />
      <span className="truncate oc-ui-start-align" dir="auto">
        {project.label?.trim() || formatDirectoryName(project.path, homeDirectory || undefined)}
      </span>
    </span>
  );
}

/**
 * A full page over the chat area for a feature that works per project. The
 * projects are listed at the start and the chosen one's content sits beside
 * them. The scheduled tasks and suggested tasks pages share it, so their
 * project lists look and behave the same.
 *
 * Each page sorts `projects` once with `useProjectsInSidebarOrder` and passes
 * them in, because its phone picker lists the same projects and the hook reads
 * sessions when the sidebar sorts by Recent.
 */
export function ProjectRailPage({ label, projects, selectedId, onSelect, leadingScope, trailing, emptyText, toolbar, children }: {
  /** Names the project list for assistive technology. */
  label: string;
  projects: readonly ProjectEntry[];
  selectedId: string;
  onSelect: (id: string) => void;
  /** A scope listed ahead of the projects, such as Chats. */
  leadingScope?: { id: string; label: React.ReactNode };
  /** The end of a project's row, such as a count. */
  trailing?: (project: ProjectEntry) => React.ReactNode;
  /** Shown when there is nothing to list. */
  emptyText: string;
  /** A row of actions above the content. */
  toolbar?: React.ReactNode;
  children: React.ReactNode;
}) {
  const row = (id: string, content: React.ReactNode, end?: React.ReactNode) => (
    <button
      key={id}
      type="button"
      onClick={() => onSelect(id)}
      aria-current={id === selectedId ? 'page' : undefined}
      className={cn(
        'flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-start typography-ui-label focus-visible:outline-none',
        id === selectedId
          ? 'bg-interactive-selection text-foreground'
          : 'text-muted-foreground hover:bg-interactive-hover/50 hover:text-foreground focus-visible:bg-interactive-hover/50 focus-visible:text-foreground',
      )}
    >
      <span className="flex min-w-0 flex-1">{content}</span>
      {end}
    </button>
  );

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-background">
      <div className="flex min-h-0 flex-1">
        <nav aria-label={label} className="flex w-60 flex-shrink-0 flex-col border-e border-border/50">
          <div className="flex-1 space-y-0.5 overflow-y-auto p-2">
            {!leadingScope && projects.length === 0 ? (
              <div className="px-2 py-2 typography-meta text-muted-foreground">{emptyText}</div>
            ) : null}
            {leadingScope ? row(leadingScope.id, leadingScope.label) : null}
            {projects.map((project) => row(project.id, <ProjectLabel project={project} />, trailing?.(project)))}
          </div>
        </nav>
        {/* Pages have no close button: you leave by picking a session, a
            draft, or another surface in the sidebar. */}
        <div className="flex min-w-0 flex-1 flex-col">
          {toolbar ? <div className="flex items-center px-6 pt-3">{toolbar}</div> : null}
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
            <div className="mx-auto w-full max-w-3xl">{children}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
