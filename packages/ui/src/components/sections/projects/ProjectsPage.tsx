import React from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { cn } from '@/lib/utils';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { PROJECT_COLORS, PROJECT_ICONS, PROJECT_COLOR_MAP as COLOR_MAP } from '@/lib/projectMeta';
import { RiCloseLine } from '@remixicon/react';
import { WorktreeSectionContent } from '@/components/sections/openchamber/WorktreeSectionContent';

export const ProjectsPage: React.FC = () => {
  const projects = useProjectsStore((state) => state.projects);
  const updateProjectMeta = useProjectsStore((state) => state.updateProjectMeta);
  const selectedId = useUIStore((state) => state.settingsProjectsSelectedId);
  const setSelectedId = useUIStore((state) => state.setSettingsProjectsSelectedId);

  const selectedProject = React.useMemo(() => {
    if (!selectedId) return null;
    return projects.find((p) => p.id === selectedId) ?? null;
  }, [projects, selectedId]);

  React.useEffect(() => {
    if (projects.length === 0) {
      setSelectedId(null);
      return;
    }
    if (selectedId && projects.some((p) => p.id === selectedId)) {
      return;
    }
    setSelectedId(projects[0].id);
  }, [projects, selectedId, setSelectedId]);

  const [name, setName] = React.useState('');
  const [icon, setIcon] = React.useState<string | null>(null);
  const [color, setColor] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!selectedProject) {
      setName('');
      setIcon(null);
      setColor(null);
      return;
    }
    setName(selectedProject.label ?? '');
    setIcon(selectedProject.icon ?? null);
    setColor(selectedProject.color ?? null);
  }, [selectedProject]);

  const hasChanges = Boolean(selectedProject) && (
    name.trim() !== (selectedProject?.label ?? '').trim()
    || icon !== (selectedProject?.icon ?? null)
    || color !== (selectedProject?.color ?? null)
  );

  const handleSave = React.useCallback(() => {
    if (!selectedProject) return;
    updateProjectMeta(selectedProject.id, { label: name.trim(), icon, color });
  }, [color, icon, name, selectedProject, updateProjectMeta]);

  if (!selectedProject) {
    return (
      <ScrollableOverlay keyboardAvoid outerClassName="h-full" className="w-full">
        <div className="mx-auto w-full max-w-4xl p-3 sm:p-6 sm:pt-8">
          <p className="typography-meta text-muted-foreground">No projects available.</p>
        </div>
      </ScrollableOverlay>
    );
  }

  const currentColorVar = color ? (COLOR_MAP[color] ?? null) : null;

  return (
    <ScrollableOverlay keyboardAvoid outerClassName="h-full" className="w-full bg-background">
      <div className="mx-auto w-full max-w-4xl p-3 sm:p-6 sm:pt-8">
        
        {/* Top Header & Actions */}
        <div className="mb-8 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h2 className="typography-ui-header font-semibold text-foreground truncate">
              {selectedProject.label ?? 'Project Settings'}
            </h2>
            <p className="typography-meta text-muted-foreground truncate" title={selectedProject.path}>
              {selectedProject.path}
            </p>
          </div>
        </div>

        {/* Identity Group */}
        <div className="mb-8">
          <div className="mb-3 px-1">
            <h3 className="typography-ui-header font-semibold text-foreground">
              Identity
            </h3>
            <p className="typography-meta text-muted-foreground mt-0.5">
              Customize how this project appears in your workspace.
            </p>
          </div>
          
          <div className="rounded-lg bg-[var(--surface-elevated)]/70 overflow-hidden flex flex-col">
            
            {/* Name */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 px-4 py-3">
              <div className="flex min-w-0 flex-col sm:w-1/3 shrink-0">
                <span className="typography-ui-label text-foreground">Project Name</span>
              </div>
              <div className="flex-1 sm:max-w-sm flex justify-end">
                <Input 
                  value={name} 
                  onChange={(e) => setName(e.target.value)} 
                  placeholder="Project name" 
                  className="w-full sm:max-w-[240px]" 
                />
              </div>
            </div>

            {/* Color */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 px-4 py-3">
              <div className="flex min-w-0 flex-col sm:w-1/3 shrink-0">
                <span className="typography-ui-label text-foreground">Accent Color</span>
              </div>
              <div className="flex gap-2 flex-wrap flex-1 justify-start sm:justify-end">
                <button
                  type="button"
                  onClick={() => setColor(null)}
                  className={cn(
                    'w-7 h-7 rounded-md border-2 transition-all flex items-center justify-center',
                    color === null ? 'border-foreground scale-110' : 'border-transparent hover:border-border hover:bg-[var(--surface-muted)]'
                  )}
                  title="None"
                >
                  <RiCloseLine className="w-4 h-4 text-muted-foreground" />
                </button>
                {PROJECT_COLORS.map((c) => (
                  <button
                    key={c.key}
                    type="button"
                    onClick={() => setColor(c.key)}
                    className={cn(
                      'w-7 h-7 rounded-md border-2 transition-all',
                      color === c.key ? 'border-foreground scale-110' : 'border-transparent hover:scale-105'
                    )}
                    style={{ backgroundColor: c.cssVar }}
                    title={c.label}
                  />
                ))}
              </div>
            </div>

            {/* Icon */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 px-4 py-3">
              <div className="flex min-w-0 flex-col sm:w-1/3 shrink-0">
                <span className="typography-ui-label text-foreground">Project Icon</span>
              </div>
              <div className="flex gap-2 flex-wrap flex-1 justify-start sm:justify-end">
                <button
                  type="button"
                  onClick={() => setIcon(null)}
                  className={cn(
                    'w-8 h-8 rounded-md border-2 transition-all flex items-center justify-center',
                    icon === null ? 'border-foreground scale-110 bg-[var(--surface-muted)]' : 'border-transparent hover:border-border hover:bg-[var(--surface-muted)]'
                  )}
                  title="None"
                >
                  <RiCloseLine className="w-5 h-5 text-muted-foreground" />
                </button>
                {PROJECT_ICONS.map((i) => {
                  const IconComponent = i.Icon;
                  return (
                    <button
                      key={i.key}
                      type="button"
                      onClick={() => setIcon(i.key)}
                      className={cn(
                        'w-8 h-8 rounded-md border-2 transition-all flex items-center justify-center',
                        icon === i.key ? 'border-foreground scale-110 bg-[var(--surface-muted)]' : 'border-transparent hover:scale-105 hover:bg-[var(--surface-muted)]'
                      )}
                      title={i.label}
                    >
                      <IconComponent className="w-4 h-4" style={currentColorVar && icon === i.key ? { color: currentColorVar } : undefined} />
                    </button>
                  );
                })}
              </div>
            </div>

          </div>
          
          <div className="mt-4 flex justify-end">
            <Button onClick={handleSave} disabled={!hasChanges || name.trim().length === 0} size="sm">
              Save Changes
            </Button>
          </div>
        </div>

        {/* Worktree Group */}
        <div className="mb-8">
          <div className="mb-3 px-1">
            <h3 className="typography-ui-header font-semibold text-foreground">
              Worktree
            </h3>
            <p className="typography-meta text-muted-foreground mt-0.5">
              Setup commands and existing worktrees for this project.
            </p>
          </div>
          <div className="rounded-lg bg-[var(--surface-elevated)]/70 p-4">
            <WorktreeSectionContent projectRef={{ id: selectedProject.id, path: selectedProject.path }} />
          </div>
        </div>

      </div>
    </ScrollableOverlay>
  );
};
