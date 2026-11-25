import React from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { getSafeStorage } from '@/stores/utils/safeStorage';
import { useTaskRepositories } from '@/hooks/useTaskRepositories';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { MultiRepoTaskError, createMultiRepoTask } from '@/lib/multiRepoTasks';
import { z } from 'zod';

const FOLDERS_STORAGE_KEY = 'openchamber.multiRepoTask.folders';
const DEFAULT_FOLDERS = { reposDir: '~/Projects/repos', tasksDir: '~/Projects/tasks', branchPrefix: '' };
const storedFoldersSchema = z.object({ reposDir: z.string(), tasksDir: z.string(), branchPrefix: z.string().default('') });

const readFolders = () => {
  const raw = getSafeStorage().getItem(FOLDERS_STORAGE_KEY);
  if (!raw) return DEFAULT_FOLDERS;
  const stored = storedFoldersSchema.safeParse(JSON.parse(raw));
  return stored.success ? stored.data : DEFAULT_FOLDERS;
};

export const MultiRepoTaskPane: React.FC<{
  isMobile: boolean;
  onProjectAdded: (projectId: string, projectPath: string) => void;
}> = ({ isMobile, onProjectAdded }) => {
  const { t } = useI18n();
  const addProject = useProjectsStore((state) => state.addProject);
  const [folders, setFolders] = React.useState(readFolders);
  const [name, setName] = React.useState('');
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(new Set());
  const listing = useTaskRepositories(folders.reposDir);
  const [isCreating, setIsCreating] = React.useState(false);

  const repositories = listing.status === 'loaded' ? listing.repositories : [];
  const chosen = repositories.filter((repo) => selected.has(repo));
  const canCreate = !isCreating && name.trim().length > 0 && chosen.length > 0 && folders.tasksDir.trim().length > 0;

  const toggle = (repo: string, on: boolean) => setSelected((current) => {
    const next = new Set(current);
    if (on) next.add(repo); else next.delete(repo);
    return next;
  });

  const create = async () => {
    if (!canCreate) return;
    setIsCreating(true);
    try {
      const task = await createMultiRepoTask({ ...folders, name: name.trim(), repositories: chosen });
      getSafeStorage().setItem(FOLDERS_STORAGE_KEY, JSON.stringify(folders));
      const project = await addProject(task.path);
      if (!project) {
        toast.error(t('directoryExplorerDialog.toast.failedToAddProject'), { description: task.path });
        return;
      }
      onProjectAdded(project.id, project.path);
    } catch (cause) {
      toast.error(t('multiRepoTask.toast.createFailed'), {
        description: cause instanceof MultiRepoTaskError && cause.problems.length > 0
          ? `${cause.message}\n${cause.problems.join('\n')}`
          : cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setIsCreating(false);
    }
  };

  const field = (label: string, input: React.ReactNode) => (
    <label className="flex flex-col gap-1">
      <span className="typography-meta text-muted-foreground">{label}</span>
      {input}
    </label>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <form
        className={cn('flex shrink-0 flex-col gap-2.5 pb-3', isMobile ? 'px-0' : 'px-4 pt-4')}
        onSubmit={(event) => { event.preventDefault(); void create(); }}
      >
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-2">
          {field(t('multiRepoTask.field.branchPrefix'), (
            <Input value={folders.branchPrefix} onChange={(event) => setFolders((current) => ({ ...current, branchPrefix: event.target.value }))}
              placeholder={t('multiRepoTask.field.branchPrefixPlaceholder')} autoComplete="off" spellCheck={false} />
          ))}
          {field(t('multiRepoTask.field.name'), (
            <Input autoFocus={!isMobile} value={name} onChange={(event) => setName(event.target.value)}
              placeholder={t('multiRepoTask.field.namePlaceholder')} autoComplete="off" spellCheck={false} />
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2">
          {field(t('multiRepoTask.field.reposDir'), (
            <Input value={folders.reposDir} onChange={(event) => setFolders((current) => ({ ...current, reposDir: event.target.value }))} spellCheck={false} />
          ))}
          {field(t('multiRepoTask.field.tasksDir'), (
            <Input value={folders.tasksDir} onChange={(event) => setFolders((current) => ({ ...current, tasksDir: event.target.value }))} spellCheck={false} />
          ))}
        </div>
      </form>
      <div className={cn('px-2.5 pb-1 typography-meta text-muted-foreground', !isMobile && 'ms-2')}>
        {t('multiRepoTask.repositories.caption')}
      </div>
      <ScrollableOverlay outerClassName="min-h-0 flex-1" className={cn('pb-1', !isMobile && 'px-2')}>
        {listing.status === 'loading' ? null
          : listing.status === 'failed' ? <p className="px-2.5 py-2 typography-meta text-destructive">{listing.message}</p>
          : repositories.length === 0 ? <p className="px-2.5 py-2 typography-meta text-muted-foreground">{t('multiRepoTask.repositories.empty')}</p>
          : repositories.map((repo) => (
            <label key={repo} className="flex h-8 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 typography-ui-label hover:bg-interactive-hover">
              <Checkbox checked={selected.has(repo)} onChange={(on) => toggle(repo, on)} ariaLabel={repo} />
              <span className="min-w-0 truncate">{repo}</span>
            </label>
          ))}
      </ScrollableOverlay>
      <div className={cn('flex shrink-0 items-center gap-2 py-2.5', !isMobile && 'pe-3 ps-4')}>
        <div className="min-w-0 flex-1 truncate typography-micro text-muted-foreground">
          {chosen.length > 0 ? t('multiRepoTask.footer.selected', { count: chosen.length }) : null}
        </div>
        <Button size="sm" disabled={!canCreate} onClick={() => void create()} className={isMobile ? 'min-w-0 flex-1' : undefined}>
          {isCreating ? t('multiRepoTask.actions.creating') : t('multiRepoTask.actions.create')}
        </Button>
      </div>
    </div>
  );
};
