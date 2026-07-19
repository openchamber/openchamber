import React from 'react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { useSnippetsStore } from '@/stores/useSnippetsStore';
import { useShallow } from 'zustand/react/shallow';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { cn } from '@/lib/utils';
import type { Snippet } from '@/types/snippet';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { SETTINGS_PANEL_TITLE_CLASS } from '@/components/sections/shared/SettingsSection';

interface SnippetsSidebarProps {
  onItemSelect?: () => void;
}

export const SnippetsSidebar: React.FC<SnippetsSidebarProps> = ({ onItemSelect }) => {
  const { t } = useI18n();
  const [confirmDeleteSnippet, setConfirmDeleteSnippet] = React.useState<Snippet | null>(null);
  const [openMenuName, setOpenMenuName] = React.useState<string | null>(null);
  const [rightClickMenuName, setRightClickMenuName] = React.useState<string | null>(null);
  const { selectedSnippetName, snippets, setSelectedSnippet, setSnippetDraft, deleteSnippet, loadSnippets } = useSnippetsStore(useShallow((s) => ({
    selectedSnippetName: s.selectedSnippetName,
    snippets: s.snippets,
    setSelectedSnippet: s.setSelectedSnippet,
    setSnippetDraft: s.setSnippetDraft,
    deleteSnippet: s.deleteSnippet,
    loadSnippets: s.loadSnippets,
  })));

  React.useEffect(() => {
    loadSnippets();
  }, [loadSnippets]);

  const handleCreateNew = async () => {
    const existing = new Set(snippets.map((snippet) => snippet.name));
    let name = 'new-snippet';
    let counter = 1;
    while (existing.has(name)) {
      name = `new-snippet-${counter++}`;
    }
    setSnippetDraft({ name, scope: 'global' });
    setSelectedSnippet(name);
    onItemSelect?.();
  };

  const handleDelete = async () => {
    if (!confirmDeleteSnippet) return;
    const success = await deleteSnippet(confirmDeleteSnippet.name);
    if (success) {
      toast.success(t('settings.snippets.sidebar.toast.deleted'));
      setConfirmDeleteSnippet(null);
    } else {
      toast.error(t('settings.snippets.sidebar.toast.deleteFailed'));
    }
  };

  const sortedSnippets = React.useMemo(() => [...snippets].sort((a, b) => a.name.localeCompare(b.name)), [snippets]);

  return (
    <div className={cn('flex h-full flex-col', 'bg-background')}>
      <div className="border-b px-3 pt-4 pb-3">
        <h2 className={`${SETTINGS_PANEL_TITLE_CLASS} mb-3`}>{t('settings.snippets.sidebar.title')}</h2>
        <div className="flex items-center justify-between gap-2">
          <span className="typography-meta text-muted-foreground">{t('settings.snippets.sidebar.total', { count: snippets.length })}</span>
          <Button size="sm" data-settings-item="snippets.create" variant="ghost" className="h-7 w-7 px-0 -my-1 text-muted-foreground" onClick={handleCreateNew} aria-label={t('settings.snippets.sidebar.actions.create')}>
            <Icon name="add" className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <ScrollableOverlay outerClassName="flex-1 min-h-0" className="space-y-1 px-3 py-2">
        {sortedSnippets.map((snippet) => (
          <ContextMenu key={`${snippet.source}:${snippet.filePath}`} open={rightClickMenuName === snippet.name} onOpenChange={(open) => setRightClickMenuName(open ? snippet.name : null)}>
            <ContextMenuTrigger render={<div className={cn('group relative flex items-center rounded-md px-1.5 py-1 transition-all duration-200 select-none', selectedSnippetName === snippet.name ? 'bg-interactive-selection' : 'hover:bg-interactive-hover')} onContextMenu={(event) => { event.preventDefault(); setRightClickMenuName(snippet.name); }} />}>
            <button onClick={() => { setSelectedSnippet(snippet.name); onItemSelect?.(); }} className="flex min-w-0 flex-1 flex-col gap-0 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50">
              <div className="flex items-center gap-2">
                <span className="typography-ui-label font-normal truncate text-foreground">#{snippet.name}</span>
                <span className="typography-micro text-muted-foreground bg-muted px-1 rounded flex-shrink-0 leading-none pb-px border border-border/50">{t(`snippets.source.${snippet.source}`)}</span>
              </div>
              <div className="typography-micro text-muted-foreground/60 truncate leading-tight">
                {snippet.description || snippet.content.replace(/\s+/g, ' ').substring(0, 80)}
              </div>
            </button>
            <DropdownMenu open={openMenuName === snippet.name} onOpenChange={(open) => { if (open) setRightClickMenuName(null); setOpenMenuName(open ? snippet.name : null); }}>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="ghost" className="h-6 w-6 px-0 flex-shrink-0 -mr-1 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100" aria-label={t('settings.snippets.sidebar.actions.more', { name: snippet.name })}>
                  <Icon name="more-2" className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-fit min-w-20">
                <DropdownMenuItem onClick={(e) => { e.stopPropagation(); setConfirmDeleteSnippet(snippet); }} className="text-destructive focus:text-destructive">
                  <Icon name="delete-bin" className="h-4 w-4 mr-px" />
                  {t('settings.common.actions.delete')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            </ContextMenuTrigger>
            <ContextMenuContent className="w-fit min-w-20">
              <ContextMenuItem onClick={(e) => { e.stopPropagation(); setConfirmDeleteSnippet(snippet); }} className="text-destructive focus:text-destructive">
                <Icon name="delete-bin" className="h-4 w-4 mr-px" />
                {t('settings.common.actions.delete')}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        ))}
      </ScrollableOverlay>

      <Dialog open={confirmDeleteSnippet !== null} onOpenChange={(open) => { if (!open) setConfirmDeleteSnippet(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.snippets.sidebar.dialog.deleteTitle')}</DialogTitle>
            <DialogDescription>{t('settings.snippets.sidebar.dialog.deleteDescription', { name: confirmDeleteSnippet?.name ?? '' })}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={() => setConfirmDeleteSnippet(null)}>{t('settings.common.actions.cancel')}</Button>
            <Button size="sm" onClick={handleDelete}>{t('settings.common.actions.delete')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
