import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui';
import { isMobileDeviceViaCSS } from '@/lib/device';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { RiAddLine, RiMore2Line, RiDeleteBinLine, RiFileCopyLine, RiEditLine, RiFileTextLine } from '@remixicon/react';
import { usePromptTemplatesStore } from '@/stores/usePromptTemplatesStore';
import { useShallow } from 'zustand/react/shallow';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import type { PromptTemplate } from '@/types/prompt-template';

interface PromptTemplatesSidebarProps {
  onItemSelect?: () => void;
}

export const PromptTemplatesSidebar: React.FC<PromptTemplatesSidebarProps> = ({ onItemSelect }) => {
  const { t } = useI18n();
  const [confirmDeleteTemplate, setConfirmDeleteTemplate] = React.useState<PromptTemplate | null>(null);
  const [isDeletePending, setIsDeletePending] = React.useState(false);
  const [openMenuId, setOpenMenuId] = React.useState<string | null>(null);
  const [renameDialogTemplate, setRenameDialogTemplate] = React.useState<PromptTemplate | null>(null);
  const [renameNewName, setRenameNewName] = React.useState('');

  const {
    selectedTemplateId,
    templates,
    setSelectedTemplate,
    deleteTemplate,
    updateTemplate,
    loadTemplates,
  } = usePromptTemplatesStore(useShallow((s) => ({
    selectedTemplateId: s.selectedTemplateId,
    templates: s.templates,
    setSelectedTemplate: s.setSelectedTemplate,
    deleteTemplate: s.deleteTemplate,
    updateTemplate: s.updateTemplate,
    loadTemplates: s.loadTemplates,
  })));

  React.useEffect(() => {
    loadTemplates();
  }, [loadTemplates]);

  const handleCreateNew = async () => {
    const baseName = 'new-template';
    let newName = baseName;
    let counter = 1;
    const existingIds = new Set(templates.map((t) => t.id));
    while (existingIds.has(newName.replace(/\s+/g, '-').toLowerCase())) {
      newName = `${baseName}-${counter}`;
      counter++;
    }

    const slug = newName.replace(/\s+/g, '-').toLowerCase();
    const success = await usePromptTemplatesStore.getState().createTemplate(slug, newName, '');
    if (!success) {
      toast.error(t('settings.promptTemplates.page.toast.createFailed'));
      return;
    }
    usePromptTemplatesStore.getState().setSelectedTemplate(slug);
    onItemSelect?.();
  };

  const handleDelete = async () => {
    if (!confirmDeleteTemplate) return;
    setIsDeletePending(true);
    const success = await deleteTemplate(confirmDeleteTemplate.id);
    if (success) {
      toast.success(t('settings.promptTemplates.sidebar.toast.deleted', { name: confirmDeleteTemplate.name }));
      setConfirmDeleteTemplate(null);
    } else {
      toast.error(t('settings.promptTemplates.sidebar.toast.deleteFailed'));
    }
    setIsDeletePending(false);
  };

  const handleDuplicate = async (template: PromptTemplate) => {
    let copyName = `${template.name} Copy`;
    let copyId = `${template.id}-copy`;
    let counter = 1;
    const existingIds = new Set(templates.map((t) => t.id));
    while (existingIds.has(copyId)) {
      copyName = `${template.name} Copy ${counter}`;
      copyId = `${template.id}-copy-${counter}`;
      counter++;
    }
    const success = await usePromptTemplatesStore.getState().createTemplate(copyId, copyName, template.body);
    if (!success) {
      toast.error(t('settings.promptTemplates.page.toast.createFailed'));
      return;
    }
    setSelectedTemplate(copyId);
    onItemSelect?.();
  };

  const handleOpenRename = (template: PromptTemplate) => {
    setRenameNewName(template.name);
    setRenameDialogTemplate(template);
  };

  const handleRename = async () => {
    if (!renameDialogTemplate) return;
    const trimmed = renameNewName.trim();
    if (!trimmed) {
      toast.error(t('settings.promptTemplates.sidebar.toast.nameRequired'));
      return;
    }
    if (trimmed === renameDialogTemplate.name) {
      setRenameDialogTemplate(null);
      return;
    }
    const success = await updateTemplate(renameDialogTemplate.id, { name: trimmed });
    if (success) {
      toast.success(t('settings.promptTemplates.sidebar.toast.renamed'));
    } else {
      toast.error(t('settings.promptTemplates.sidebar.toast.renameFailed'));
    }
    setRenameDialogTemplate(null);
  };

  const sortedTemplates = React.useMemo(
    () => [...templates].sort((a, b) => a.name.localeCompare(b.name)),
    [templates],
  );

  return (
    <div className={cn('flex h-full flex-col', 'bg-background')}>
      <div className="border-b px-3 pt-4 pb-3">
        <h2 className="text-base font-semibold text-foreground mb-3">{t('settings.promptTemplates.sidebar.title')}</h2>
        <div className="flex items-center justify-between gap-2">
          <span className="typography-meta text-muted-foreground">{t('settings.promptTemplates.sidebar.total', { count: templates.length })}</span>
          <Button size="sm" variant="ghost" className="h-7 w-7 px-0 -my-1 text-muted-foreground" onClick={handleCreateNew}>
            <RiAddLine className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <ScrollableOverlay outerClassName="flex-1 min-h-0" className="space-y-1 px-3 py-2">
        {sortedTemplates.length === 0 ? (
          <div className="py-12 px-4 text-center text-muted-foreground">
            <RiFileTextLine className="mx-auto mb-3 h-10 w-10 opacity-50" />
            <p className="typography-ui-label font-medium">{t('settings.promptTemplates.sidebar.empty.title')}</p>
            <p className="typography-meta mt-1 opacity-75">{t('settings.promptTemplates.sidebar.empty.description')}</p>
          </div>
        ) : (
          sortedTemplates.map((template) => (
            <TemplateListItem
              key={template.id}
              template={template}
              isSelected={selectedTemplateId === template.id}
              onSelect={() => {
                setSelectedTemplate(template.id);
                onItemSelect?.();
              }}
              onDelete={() => setConfirmDeleteTemplate(template)}
              onRename={() => handleOpenRename(template)}
              onDuplicate={() => handleDuplicate(template)}
              isMenuOpen={openMenuId === template.id}
              onMenuOpenChange={(open) => setOpenMenuId(open ? template.id : null)}
            />
          ))
        )}
      </ScrollableOverlay>

      <Dialog
        open={confirmDeleteTemplate !== null}
        onOpenChange={(open) => { if (!open && !isDeletePending) setConfirmDeleteTemplate(null); }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.promptTemplates.sidebar.dialog.deleteTitle')}</DialogTitle>
            <DialogDescription>
              {t('settings.promptTemplates.sidebar.dialog.deleteDescription', { name: confirmDeleteTemplate?.name ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={() => setConfirmDeleteTemplate(null)} disabled={isDeletePending}>
              {t('settings.common.actions.cancel')}
            </Button>
            <Button size="sm" onClick={handleDelete} disabled={isDeletePending}>
              {t('settings.common.actions.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={renameDialogTemplate !== null} onOpenChange={(open) => !open && setRenameDialogTemplate(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('settings.promptTemplates.sidebar.renameDialog.title')}</DialogTitle>
            <DialogDescription>
              {t('settings.promptTemplates.sidebar.renameDialog.description', { name: renameDialogTemplate?.name ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <Input
            value={renameNewName}
            onChange={(e) => setRenameNewName(e.target.value)}
            placeholder={t('settings.promptTemplates.sidebar.renameDialog.placeholder')}
            className="text-foreground placeholder:text-muted-foreground"
            onKeyDown={(e) => { if (e.key === 'Enter') handleRename(); }}
          />
          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={() => setRenameDialogTemplate(null)}>
              {t('settings.common.actions.cancel')}
            </Button>
            <Button size="sm" onClick={handleRename}>
              {t('settings.common.actions.rename')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

interface TemplateListItemProps {
  template: PromptTemplate;
  isSelected: boolean;
  onSelect: () => void;
  onDelete?: () => void;
  onRename?: () => void;
  onDuplicate: () => void;
  isMenuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
}

const TemplateListItem: React.FC<TemplateListItemProps> = ({
  template,
  isSelected,
  onSelect,
  onDelete,
  onRename,
  onDuplicate,
  isMenuOpen,
  onMenuOpenChange,
}) => {
  const { t } = useI18n();
  const isMobile = isMobileDeviceViaCSS();
  return (
    <div
      className={cn(
        'group relative flex items-center rounded-md px-1.5 py-1 transition-all duration-200 select-none',
        isSelected ? 'bg-interactive-selection' : 'hover:bg-interactive-hover',
      )}
      onContextMenu={!isMobile ? (e) => { e.preventDefault(); onMenuOpenChange(true); } : undefined}
    >
      <div className="flex min-w-0 flex-1 items-center">
        <button
          onClick={onSelect}
          className="flex min-w-0 flex-1 flex-col gap-0 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
          tabIndex={0}
        >
          <div className="flex items-center gap-2">
            <span className="typography-ui-label font-normal truncate text-foreground">
              {template.name}
            </span>
            {template.isDefault && (
              <span className="typography-micro text-muted-foreground bg-muted px-1 rounded flex-shrink-0 leading-none pb-px border border-border/50">
                {t('settings.promptTemplates.sidebar.badge.default')}
              </span>
            )}
          </div>
          {template.body && (
            <div className="typography-micro text-muted-foreground/60 truncate leading-tight">
              {template.body.substring(0, 80)}
            </div>
          )}
        </button>

        {!template.isDefault && (
          <DropdownMenu open={isMenuOpen} onOpenChange={onMenuOpenChange}>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" className="h-6 w-6 px-0 flex-shrink-0 -mr-1 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100">
                <RiMore2Line className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-fit min-w-20">
              {onRename && (
                <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onRename(); }}>
                  <RiEditLine className="h-4 w-4 mr-px" />
                  {t('settings.common.actions.rename')}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onDuplicate(); }}>
                <RiFileCopyLine className="h-4 w-4 mr-px" />
                {t('settings.common.actions.duplicate')}
              </DropdownMenuItem>
              {onDelete && (
                <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onDelete(); }} className="text-destructive focus:text-destructive">
                  <RiDeleteBinLine className="h-4 w-4 mr-px" />
                  {t('settings.common.actions.delete')}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  );
};
