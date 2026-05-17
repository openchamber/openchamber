import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui';
import { useSkillsStore, type SkillConfig, type SkillScope, type SupportingFile, type PendingFile } from '@/stores/useSkillsStore';
import { useShallow } from 'zustand/react/shallow';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Icon } from "@/components/icon/Icon";
import { SkillsCatalogPage } from './catalog/SkillsCatalogPage';
import {
  SKILL_LOCATION_OPTIONS,
  locationPartsFrom,
  locationValueFrom,
  type SkillLocationValue,
} from './skillLocations';
import { useI18n } from '@/lib/i18n';

export interface SkillsPageProps {
  view?: 'installed' | 'catalog';
}

const SkillsCatalogStandalone: React.FC = () => (
  <SkillsCatalogPage mode="external" onModeChange={() => {}} showModeTabs={false} />
);

const SkillsInstalledPage: React.FC = () => {
  const { t } = useI18n();
  const {
    selectedSkillName,
    getSkillByName,
    getSkillDetail,
    createSkill,
    updateSkill,
    skills,
    skillDraft,
    setSkillDraft,
    setSelectedSkill,
  } = useSkillsStore(useShallow((s) => ({
    selectedSkillName: s.selectedSkillName,
    getSkillByName: s.getSkillByName,
    getSkillDetail: s.getSkillDetail,
    createSkill: s.createSkill,
    updateSkill: s.updateSkill,
    skills: s.skills,
    skillDraft: s.skillDraft,
    setSkillDraft: s.setSkillDraft,
    setSelectedSkill: s.setSelectedSkill,
  })));

  const selectedSkill = selectedSkillName ? getSkillByName(selectedSkillName) : null;
  const isNewSkill = Boolean(skillDraft && skillDraft.name === selectedSkillName && !selectedSkill);
  const hasStaleSelection = Boolean(selectedSkillName && !selectedSkill && !skillDraft);

  React.useEffect(() => {
    if (!hasStaleSelection) {
      return;
    }

    setSelectedSkill(null);
  }, [hasStaleSelection, setSelectedSkill]);

  const [draftName, setDraftName] = React.useState('');
  const [draftScope, setDraftScope] = React.useState<SkillScope>('user');
  const [draftSource, setDraftSource] = React.useState<'opencode' | 'agents'>('opencode');
  const [description, setDescription] = React.useState('');
  const [instructions, setInstructions] = React.useState('');
  const [supportingFiles, setSupportingFiles] = React.useState<SupportingFile[]>([]);
  const [pendingFiles, setPendingFiles] = React.useState<PendingFile[]>([]);
  const [isSaving, setIsSaving] = React.useState(false);
  const [isLoading, setIsLoading] = React.useState(false);
  
  const [originalDescription, setOriginalDescription] = React.useState('');
  const [originalInstructions, setOriginalInstructions] = React.useState('');
  
  const [isFileDialogOpen, setIsFileDialogOpen] = React.useState(false);
  const [newFileName, setNewFileName] = React.useState('');
  const [newFileContent, setNewFileContent] = React.useState('');
  const [editingFilePath, setEditingFilePath] = React.useState<string | null>(null);
  const [isLoadingFile, setIsLoadingFile] = React.useState(false);
  const [originalFileContent, setOriginalFileContent] = React.useState('');
  const [deleteFilePath, setDeleteFilePath] = React.useState<string | null>(null);
  const [isDeletingFile, setIsDeletingFile] = React.useState(false);
  
  const hasSkillChanges = isNewSkill 
    ? (draftName.trim() !== '' || description.trim() !== '' || instructions.trim() !== '' || pendingFiles.length > 0)
    : (description !== originalDescription || instructions !== originalInstructions);
  
  const hasFileChanges = editingFilePath 
    ? newFileContent !== originalFileContent
    : newFileName.trim() !== '';

  const locationLabelText = React.useCallback((value: SkillLocationValue) => {
    switch (value) {
      case 'project-opencode':
        return t('settings.skills.location.option.projectOpencode.label');
      case 'user-agents':
        return t('settings.skills.location.option.userAgents.label');
      case 'project-agents':
        return t('settings.skills.location.option.projectAgents.label');
      default:
        return t('settings.skills.location.option.userOpencode.label');
    }
  }, [t]);

  const locationDescriptionText = React.useCallback((value: SkillLocationValue) => {
    switch (value) {
      case 'project-opencode':
        return t('settings.skills.location.option.projectOpencode.description');
      case 'user-agents':
        return t('settings.skills.location.option.userAgents.description');
      case 'project-agents':
        return t('settings.skills.location.option.projectAgents.description');
      default:
        return t('settings.skills.location.option.userOpencode.description');
    }
  }, [t]);

  React.useEffect(() => {
    const loadSkillDetails = async () => {
      if (isNewSkill && skillDraft) {
        setDraftName(skillDraft.name || '');
        setDraftScope(skillDraft.scope || 'user');
        setDraftSource(skillDraft.source === 'agents' ? 'agents' : 'opencode');
        setDescription(skillDraft.description || '');
        setInstructions(skillDraft.instructions || '');
        setOriginalDescription('');
        setOriginalInstructions('');
        setSupportingFiles([]);
        setPendingFiles(skillDraft.pendingFiles || []);
      } else if (selectedSkillName && selectedSkill) {
        setIsLoading(true);
        try {
          const detail = await getSkillDetail(selectedSkillName);
          if (detail) {
            const md = detail.sources.md;
            setDescription(md.description || '');
            setInstructions(md.instructions || '');
            setOriginalDescription(md.description || '');
            setOriginalInstructions(md.instructions || '');
            setSupportingFiles(md.supportingFiles || []);
          }
        } catch (error) {
          console.error('Failed to load skill details:', error);
        } finally {
          setIsLoading(false);
        }
      }
    };

    loadSkillDetails();
  }, [selectedSkill, isNewSkill, selectedSkillName, skills, skillDraft, getSkillDetail]);

  const handleSave = async () => {
    const skillName = isNewSkill ? draftName.trim().replace(/\s+/g, '-').toLowerCase() : selectedSkillName?.trim();

    if (!skillName) {
      toast.error(t('settings.skills.page.toast.skillNameRequired'));
      return;
    }

    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(skillName) || skillName.length > 64) {
      toast.error(t('settings.skills.page.toast.invalidSkillName'));
      return;
    }

    if (!description.trim()) {
      toast.error(t('settings.skills.page.toast.descriptionRequired'));
      return;
    }

    if (isNewSkill && skills.some((s) => s.name === skillName)) {
      toast.error(t('settings.skills.page.toast.skillExists'));
      return;
    }

    setIsSaving(true);

    try {
      const config: SkillConfig = {
        name: skillName,
        description: description.trim(),
        instructions: instructions.trim() || undefined,
        scope: isNewSkill ? draftScope : undefined,
        source: isNewSkill ? draftSource : undefined,
        supportingFiles: isNewSkill && pendingFiles.length > 0 ? pendingFiles : undefined,
      };

      let success: boolean;
      if (isNewSkill) {
        success = await createSkill(config);
        if (success) {
          setSkillDraft(null);
          setPendingFiles([]);
          setSelectedSkill(skillName);
        }
      } else {
        success = await updateSkill(skillName, config);
        if (success) {
          setOriginalDescription(description.trim());
          setOriginalInstructions(instructions.trim());
        }
      }

      if (success) {
        toast.success(isNewSkill ? t('settings.skills.page.toast.skillCreated') : t('settings.skills.page.toast.skillUpdated'));
      } else {
        toast.error(isNewSkill ? t('settings.skills.page.toast.createSkillFailed') : t('settings.skills.page.toast.updateSkillFailed'));
      }
    } catch (error) {
      console.error('Error saving skill:', error);
      toast.error(t('settings.skills.page.toast.saveUnexpectedError'));
    } finally {
      setIsSaving(false);
    }
  };

  const handleAddFile = () => {
    setEditingFilePath(null);
    setNewFileName('');
    setNewFileContent('');
    setOriginalFileContent('');
    setIsFileDialogOpen(true);
  };

  const handleEditFile = async (filePath: string) => {
    setEditingFilePath(filePath);
    setNewFileName(filePath);
    
    if (isNewSkill) {
      const pendingFile = pendingFiles.find(f => f.path === filePath);
      const content = pendingFile?.content || '';
      setNewFileContent(content);
      setOriginalFileContent(content);
      setIsFileDialogOpen(true);
      return;
    }
    
    if (!selectedSkillName) return;
    
    setIsLoadingFile(true);
    setIsFileDialogOpen(true);
    
    try {
      const { readSupportingFile } = useSkillsStore.getState();
      const content = await readSupportingFile(selectedSkillName, filePath);
      setNewFileContent(content || '');
      setOriginalFileContent(content || '');
    } catch {
      toast.error(t('settings.skills.page.toast.loadFileContentFailed'));
      setNewFileContent('');
      setOriginalFileContent('');
    } finally {
      setIsLoadingFile(false);
    }
  };

  const handleSaveFile = async () => {
    if (!newFileName.trim()) {
      toast.error(t('settings.skills.page.toast.fileNameRequired'));
      return;
    }

    const filePath = newFileName.trim();
    const isEditing = editingFilePath !== null;

    if (isNewSkill) {
      if (isEditing) {
        setPendingFiles(prev => prev.map(f => 
          f.path === editingFilePath ? { path: filePath, content: newFileContent } : f
        ));
        toast.success(t('settings.skills.page.toast.fileUpdated', { path: filePath }));
      } else {
        if (pendingFiles.some(f => f.path === filePath)) {
          toast.error(t('settings.skills.page.toast.fileExists'));
          return;
        }
        setPendingFiles(prev => [...prev, { path: filePath, content: newFileContent }]);
        toast.success(t('settings.skills.page.toast.fileAdded', { path: filePath }));
      }
      setIsFileDialogOpen(false);
      setEditingFilePath(null);
      return;
    }

    if (!selectedSkillName) {
      toast.error(t('settings.skills.page.toast.noSkillSelected'));
      return;
    }

    const { writeSupportingFile } = useSkillsStore.getState();
    const success = await writeSupportingFile(selectedSkillName, filePath, newFileContent);
    
    if (success) {
      toast.success(isEditing ? t('settings.skills.page.toast.fileUpdated', { path: filePath }) : t('settings.skills.page.toast.fileCreated', { path: filePath }));
      setIsFileDialogOpen(false);
      setEditingFilePath(null);
      const detail = await getSkillDetail(selectedSkillName);
      if (detail) {
        setSupportingFiles(detail.sources.md.supportingFiles || []);
      }
    } else {
      toast.error(isEditing ? t('settings.skills.page.toast.updateFileFailed') : t('settings.skills.page.toast.createFileFailed'));
    }
  };

  const handleDeleteFile = (filePath: string) => {
    if (isNewSkill) {
      setPendingFiles(prev => prev.filter(f => f.path !== filePath));
      toast.success(t('settings.skills.page.toast.fileRemoved', { path: filePath }));
      return;
    }

    if (!selectedSkillName) {
      return;
    }

    setDeleteFilePath(filePath);
  };

  const handleConfirmDeleteFile = async () => {
    if (!deleteFilePath || !selectedSkillName) {
      return;
    }

    setIsDeletingFile(true);
    const { deleteSupportingFile } = useSkillsStore.getState();
    const success = await deleteSupportingFile(selectedSkillName, deleteFilePath);

    if (success) {
      toast.success(t('settings.skills.page.toast.fileDeleted', { path: deleteFilePath }));
      const detail = await getSkillDetail(selectedSkillName);
      if (detail) {
        setSupportingFiles(detail.sources.md.supportingFiles || []);
      }
      setDeleteFilePath(null);
    } else {
      toast.error(t('settings.skills.page.toast.deleteFileFailed'));
    }

    setIsDeletingFile(false);
  };

  if ((!selectedSkillName && !skillDraft) || hasStaleSelection) {
    return (
      <div className="flex h-full items-center justify-center px-4">
        <div className="text-center text-muted-foreground">
          <Icon name="book-open" className="mx-auto mb-3 h-10 w-10 sm:h-12 sm:w-12 opacity-50" />
          <p className="typography-body">{t('settings.skills.page.empty.title')}</p>
          <p className="typography-meta mt-1 opacity-75">{t('settings.skills.page.empty.description')}</p>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center px-4">
        <div className="text-center text-muted-foreground">
          <p className="typography-body">{t('settings.skills.page.loading.details')}</p>
        </div>
      </div>
    );
  }

  return (
    <ScrollableOverlay outerClassName="h-full" className="w-full">
      <div className="mx-auto w-full max-w-3xl p-3 sm:p-6 sm:pt-8">

        {/* Header */}
        <div className="mb-4">
          <div className="min-w-0">
            <h2 className="typography-ui-header font-semibold text-foreground truncate flex items-center gap-2">
              {isNewSkill ? t('settings.skills.page.title.newSkill') : selectedSkillName}
              {selectedSkill?.source === 'claude' && (
                <span className="typography-micro font-normal bg-[var(--surface-muted)] text-muted-foreground px-1.5 py-0.5 rounded">
                  {t('settings.skills.page.badge.claudeCompatible')}
                </span>
              )}
            </h2>
            <p className="typography-meta text-muted-foreground truncate">
              {selectedSkill
                ? t('settings.skills.page.subtitle.skillLocation', {
                    location: locationLabelText(locationValueFrom(selectedSkill.scope, selectedSkill.source)),
                  })
                : t('settings.skills.page.subtitle.newSkill')}
            </p>
          </div>
        </div>

        {/* Basic Information */}
        <div className="mb-8">
          <div className="mb-1 px-1">
            <h3 className="typography-ui-header font-medium text-foreground">
              {t('settings.skills.page.section.basicInformation')}
            </h3>
          </div>

          <section className="px-2 pb-2 pt-0 space-y-0">

            {isNewSkill && (
              <div className="py-1.5">
                <span className="typography-ui-label text-foreground">{t('settings.skills.page.field.skillNameLocation')}</span>
                <span className="typography-meta text-muted-foreground ml-2">{t('settings.skills.page.field.skillNameHint')}</span>
                <div className="flex items-center gap-2 mt-1.5">
                  <Input
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value.toLowerCase().replace(/\s+/g, '-'))}
                    placeholder={t('settings.skills.page.field.skillNamePlaceholder')}
                    className="h-7 w-40 px-2"
                  />
                  <Select
                    value={locationValueFrom(draftScope, draftSource)}
                    onValueChange={(v) => {
                      const next = locationPartsFrom(v as SkillLocationValue);
                      setDraftScope(next.scope);
                      setDraftSource(next.source === 'agents' ? 'agents' : 'opencode');
                    }}
                  >
                    <SelectTrigger className="w-fit gap-1.5">
                      {draftScope === 'user' ? (
                        <Icon name="user-3" className="h-3.5 w-3.5" />
                      ) : (
                        <Icon name="folder" className="h-3.5 w-3.5" />
                      )}
                      {draftSource === 'agents' ? <Icon name="robot-2" className="h-3.5 w-3.5" /> : null}
                      <span>{locationLabelText(locationValueFrom(draftScope, draftSource))}</span>
                    </SelectTrigger>
                    <SelectContent align="start">
                      {SKILL_LOCATION_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          <div className="flex flex-col gap-0.5">
                            <div className="flex items-center gap-2">
                              {option.scope === 'user' ? <Icon name="user-3" className="h-3.5 w-3.5" /> : <Icon name="folder" className="h-3.5 w-3.5" />}
                              {option.source === 'agents' ? <Icon name="robot-2" className="h-3.5 w-3.5" /> : null}
                              <span>{locationLabelText(option.value)}</span>
                            </div>
                            <span className="typography-micro text-muted-foreground ml-6">{locationDescriptionText(option.value)}</span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}

            <div className="py-1.5">
              <span className="typography-ui-label text-foreground">{t('settings.common.field.description')} <span className="text-[var(--status-error)]">*</span></span>
              <span className="typography-meta text-muted-foreground ml-2">{t('settings.skills.page.field.descriptionHint')}</span>
              <div className="mt-1.5">
                <Textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={t('settings.skills.page.field.descriptionPlaceholder')}
                  rows={2}
                  className="w-full resize-none min-h-[60px] max-h-32 bg-transparent"
                />
              </div>
            </div>

          </section>
        </div>

        {/* Instructions */}
        <div className="mb-8">
          <div className="mb-1 px-1">
            <h3 className="typography-ui-header font-medium text-foreground">
              {t('settings.skills.page.section.instructions')}
            </h3>
          </div>

          <section className="px-2 pb-2 pt-0">
            <Textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder={t('settings.skills.page.field.instructionsPlaceholder')}
              className="min-h-[220px] max-h-[60vh] font-mono typography-meta"
            />
          </section>
        </div>

        {/* Supporting Files */}
        <div className="mb-2">
          <div className="mb-1 px-1 flex items-center gap-2">
            <h3 className="typography-ui-header font-medium text-foreground">
              {t('settings.skills.page.section.supportingFiles')}
            </h3>
            <Button variant="outline" size="xs" className="!font-normal gap-1" onClick={handleAddFile}>
              <Icon name="add" className="h-3.5 w-3.5" /> {t('settings.skills.page.actions.addFile')}
            </Button>
          </div>

          <section className="px-2 pb-2 pt-0">
            {(() => {
              const filesToShow = isNewSkill ? pendingFiles : supportingFiles;

              if (filesToShow.length === 0) {
                return (
                  <p className="typography-meta text-muted-foreground py-1.5">
                    {t('settings.skills.page.supportingFiles.empty')}
                  </p>
                );
              }

              return (
                <div className="divide-y divide-[var(--surface-subtle)]">
                  {filesToShow.map((file) => (
                    <div
                      key={file.path}
                      className="flex items-center gap-2 py-1.5 cursor-pointer group"
                      onClick={() => handleEditFile(file.path)}
                    >
                      <Icon name="file" className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                      <span className="typography-ui-label text-foreground truncate">{file.path}</span>
                      {isNewSkill && (
                        <span className="typography-micro text-[var(--status-warning)] bg-[var(--status-warning)]/10 px-1.5 py-0.5 rounded flex-shrink-0">
                          {t('settings.skills.page.badge.pending')}
                        </span>
                      )}
                      <Button size="sm"
                        variant="ghost"
                        className="h-5 w-5 px-0 flex-shrink-0 text-muted-foreground hover:text-[var(--status-error)] opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteFile(file.path);
                        }}
                      >
                        <Icon name="delete-bin" className="h-3 w-3" />
                      </Button>
                    </div>
                  ))}
                </div>
              );
            })()}
          </section>
        </div>

        {/* Save action */}
        <div className="px-2 py-1">
          <Button
            onClick={handleSave}
            disabled={isSaving || !hasSkillChanges}
            size="xs"
            className="!font-normal"
          >
            {isSaving ? t('settings.common.actions.saving') : isNewSkill ? t('settings.skills.page.actions.createSkill') : t('settings.common.actions.saveChanges')}
          </Button>
        </div>

      </div>

      {/* Add/Edit File Dialog */}
      <Dialog
        open={deleteFilePath !== null}
        onOpenChange={(open) => {
          if (!open && !isDeletingFile) {
            setDeleteFilePath(null);
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.skills.page.deleteFileDialog.title')}</DialogTitle>
            <DialogDescription>
              {t('settings.skills.page.deleteFileDialog.description', { path: deleteFilePath ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setDeleteFilePath(null)}
              disabled={isDeletingFile}
            >
              {t('settings.common.actions.cancel')}
            </Button>
            <Button size="sm" variant="destructive" onClick={handleConfirmDeleteFile} disabled={isDeletingFile}>
              {t('settings.common.actions.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isFileDialogOpen} onOpenChange={(open) => {
        setIsFileDialogOpen(open);
        if (!open) setEditingFilePath(null);
      }}>
        <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col">
          <DialogHeader className="flex-shrink-0">
            <DialogTitle>{editingFilePath ? t('settings.skills.page.fileDialog.titleEdit') : t('settings.skills.page.fileDialog.titleAdd')}</DialogTitle>
            <DialogDescription>
              {editingFilePath ? t('settings.skills.page.fileDialog.descriptionEdit') : t('settings.skills.page.fileDialog.descriptionAdd')}
            </DialogDescription>
          </DialogHeader>
          {isLoadingFile ? (
            <div className="flex-1 flex items-center justify-center py-8">
              <span className="typography-meta text-muted-foreground">{t('settings.skills.page.loading.fileContent')}</span>
            </div>
          ) : (
            <div className="space-y-4 flex-1 min-h-0 flex flex-col pt-2">
              <div className="space-y-2 flex-shrink-0">
                <label className="typography-ui-label font-medium text-foreground">
                  {t('settings.skills.page.fileDialog.field.filePath')}
                </label>
                <Input
                  value={newFileName}
                  onChange={(e) => setNewFileName(e.target.value)}
                  placeholder={t('settings.skills.page.fileDialog.field.filePathPlaceholder')}
                  className="text-foreground placeholder:text-muted-foreground focus-visible:ring-[var(--primary-base)]"
                  disabled={editingFilePath !== null}
                />
                {!editingFilePath && (
                  <p className="typography-micro text-muted-foreground">
                    {t('settings.skills.page.fileDialog.field.filePathHint')}
                  </p>
                )}
              </div>
              <div className="space-y-2 flex-1 min-h-0 flex flex-col">
                <label className="typography-ui-label font-medium text-foreground flex-shrink-0">
                  {t('settings.skills.page.fileDialog.field.content')}
                </label>
                <Textarea
                  value={newFileContent}
                  onChange={(e) => setNewFileContent(e.target.value)}
                  placeholder={t('settings.skills.page.fileDialog.field.contentPlaceholder')}
                  outerClassName="h-[45vh] min-h-[250px] max-h-[55vh]"
                  className="h-full min-h-0 font-mono typography-meta"
                />
              </div>
            </div>
          )}
          <DialogFooter className="mt-4">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setIsFileDialogOpen(false);
                setEditingFilePath(null);
              }}
            >
              {t('settings.common.actions.cancel')}
            </Button>
            <Button size="sm" onClick={handleSaveFile} disabled={isLoadingFile || !hasFileChanges}>
              {editingFilePath ? t('settings.common.actions.saveChanges') : t('settings.skills.page.actions.createFile')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ScrollableOverlay>
  );
};

export const SkillsPage: React.FC<SkillsPageProps> = ({ view = 'installed' }) => {
  return view === 'catalog' ? <SkillsCatalogStandalone /> : <SkillsInstalledPage />;
};
