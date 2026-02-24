import React from 'react';
import { ButtonSmall } from '@/components/ui/button-small';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui';
import { useSkillsStore, type SkillConfig, type SkillScope, type SupportingFile, type PendingFile } from '@/stores/useSkillsStore';
import { RiAddLine, RiBookOpenLine, RiDeleteBinLine, RiFileLine, RiFolderLine, RiRobot2Line, RiUser3Line } from '@remixicon/react';
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
import { ButtonLarge } from '@/components/ui/button-large';
import { SkillsCatalogPage } from './catalog/SkillsCatalogPage';
import {
  SKILL_LOCATION_OPTIONS,
  locationLabel,
  locationPartsFrom,
  locationValueFrom,
  type SkillLocationValue,
} from './skillLocations';

export interface SkillsPageProps {
  view?: 'installed' | 'catalog';
}

const SkillsCatalogStandalone: React.FC = () => (
  <SkillsCatalogPage mode="external" onModeChange={() => {}} showModeTabs={false} />
);

const SkillsInstalledPage: React.FC = () => {
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
  } = useSkillsStore();

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
      toast.error('Skill name is required');
      return;
    }

    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(skillName) || skillName.length > 64) {
      toast.error('Skill name must be 1-64 lowercase alphanumeric characters with hyphens, cannot start or end with hyphen');
      return;
    }

    if (!description.trim()) {
      toast.error('Description is required');
      return;
    }

    if (isNewSkill && skills.some((s) => s.name === skillName)) {
      toast.error('A skill with this name already exists');
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
        toast.success(isNewSkill ? 'Skill created successfully' : 'Skill updated successfully');
      } else {
        toast.error(isNewSkill ? 'Failed to create skill' : 'Failed to update skill');
      }
    } catch (error) {
      console.error('Error saving skill:', error);
      toast.error('An error occurred while saving');
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
      toast.error('Failed to load file content');
      setNewFileContent('');
      setOriginalFileContent('');
    } finally {
      setIsLoadingFile(false);
    }
  };

  const handleSaveFile = async () => {
    if (!newFileName.trim()) {
      toast.error('File name is required');
      return;
    }

    const filePath = newFileName.trim();
    const isEditing = editingFilePath !== null;

    if (isNewSkill) {
      if (isEditing) {
        setPendingFiles(prev => prev.map(f => 
          f.path === editingFilePath ? { path: filePath, content: newFileContent } : f
        ));
        toast.success(`File "${filePath}" updated`);
      } else {
        if (pendingFiles.some(f => f.path === filePath)) {
          toast.error('A file with this name already exists');
          return;
        }
        setPendingFiles(prev => [...prev, { path: filePath, content: newFileContent }]);
        toast.success(`File "${filePath}" added`);
      }
      setIsFileDialogOpen(false);
      setEditingFilePath(null);
      return;
    }

    if (!selectedSkillName) {
      toast.error('No skill selected');
      return;
    }

    const { writeSupportingFile } = useSkillsStore.getState();
    const success = await writeSupportingFile(selectedSkillName, filePath, newFileContent);
    
    if (success) {
      toast.success(isEditing ? `File "${filePath}" updated` : `File "${filePath}" created`);
      setIsFileDialogOpen(false);
      setEditingFilePath(null);
      const detail = await getSkillDetail(selectedSkillName);
      if (detail) {
        setSupportingFiles(detail.sources.md.supportingFiles || []);
      }
    } else {
      toast.error(isEditing ? 'Failed to update file' : 'Failed to create file');
    }
  };

  const handleDeleteFile = (filePath: string) => {
    if (isNewSkill) {
      setPendingFiles(prev => prev.filter(f => f.path !== filePath));
      toast.success(`File "${filePath}" removed`);
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
      toast.success(`File "${deleteFilePath}" deleted`);
      const detail = await getSkillDetail(selectedSkillName);
      if (detail) {
        setSupportingFiles(detail.sources.md.supportingFiles || []);
      }
      setDeleteFilePath(null);
    } else {
      toast.error('Failed to delete file');
    }

    setIsDeletingFile(false);
  };

  if ((!selectedSkillName && !skillDraft) || hasStaleSelection) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-muted-foreground">
          <RiBookOpenLine className="mx-auto mb-3 h-12 w-12 opacity-50" />
          <p className="typography-body">Select a skill from the sidebar</p>
          <p className="typography-meta mt-1 opacity-75">or create a new one</p>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-muted-foreground">
          <p className="typography-body">Loading skill details...</p>
        </div>
      </div>
    );
  }

  return (
    <ScrollableOverlay keyboardAvoid outerClassName="h-full" className="w-full">
      <div className="mx-auto w-full max-w-3xl p-3 sm:p-6 sm:pt-8">

        {/* Header */}
        <div className="mb-4">
          <div className="min-w-0">
            <h2 className="typography-ui-header font-semibold text-foreground truncate flex items-center gap-2">
              {isNewSkill ? 'New Skill' : selectedSkillName}
              {selectedSkill?.source === 'claude' && (
                <span className="typography-micro font-normal bg-[var(--surface-muted)] text-muted-foreground px-1.5 py-0.5 rounded">
                  Claude-compatible
                </span>
              )}
            </h2>
            <p className="typography-meta text-muted-foreground truncate">
              {selectedSkill ? `${locationLabel(selectedSkill.scope, selectedSkill.source)} skill` : 'Configure a new skill'}
            </p>
          </div>
        </div>

        {/* Basic Information */}
        <div className="mb-8">
          <div className="mb-1 px-1">
            <h3 className="typography-ui-header font-medium text-foreground">
              Basic Information
            </h3>
          </div>

          <section className="px-2 pb-2 pt-0 space-y-0">

            {isNewSkill && (
              <div className="py-1.5">
                <span className="typography-ui-label text-foreground">Skill Name & Location</span>
                <span className="typography-meta text-muted-foreground ml-2">Lowercase, numbers, hyphens</span>
                <div className="flex items-center gap-2 mt-1.5">
                  <Input
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value.toLowerCase().replace(/\s+/g, '-'))}
                    placeholder="skill-name"
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
                        <RiUser3Line className="h-3.5 w-3.5" />
                      ) : (
                        <RiFolderLine className="h-3.5 w-3.5" />
                      )}
                      {draftSource === 'agents' ? <RiRobot2Line className="h-3.5 w-3.5" /> : null}
                      <span>{locationLabel(draftScope, draftSource)}</span>
                    </SelectTrigger>
                    <SelectContent align="start">
                      {SKILL_LOCATION_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          <div className="flex flex-col gap-0.5">
                            <div className="flex items-center gap-2">
                              {option.scope === 'user' ? <RiUser3Line className="h-3.5 w-3.5" /> : <RiFolderLine className="h-3.5 w-3.5" />}
                              {option.source === 'agents' ? <RiRobot2Line className="h-3.5 w-3.5" /> : null}
                              <span>{option.label}</span>
                            </div>
                            <span className="typography-micro text-muted-foreground ml-6">{option.description}</span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}

            <div className="py-1.5">
              <span className="typography-ui-label text-foreground">Description <span className="text-[var(--status-error)]">*</span></span>
              <span className="typography-meta text-muted-foreground ml-2">The agent uses this to decide when to load the skill</span>
              <div className="mt-1.5">
                <Textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Brief description of what this skill does..."
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
              Instructions
            </h3>
          </div>

          <section className="px-2 pb-2 pt-0">
            <Textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="Step-by-step instructions, guidelines, or reference content..."
              className="min-h-[220px] max-h-[60vh] font-mono typography-meta"
            />
          </section>
        </div>

        {/* Supporting Files */}
        <div className="mb-2">
          <div className="mb-1 px-1 flex items-center gap-2">
            <h3 className="typography-ui-header font-medium text-foreground">
              Supporting Files
            </h3>
            <ButtonSmall variant="outline" size="xs" className="!font-normal gap-1" onClick={handleAddFile}>
              <RiAddLine className="h-3.5 w-3.5" /> Add File
            </ButtonSmall>
          </div>

          <section className="px-2 pb-2 pt-0">
            {(() => {
              const filesToShow = isNewSkill ? pendingFiles : supportingFiles;

              if (filesToShow.length === 0) {
                return (
                  <p className="typography-meta text-muted-foreground py-1.5">
                    No supporting files. Use "Add File" to include reference materials.
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
                      <RiFileLine className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                      <span className="typography-ui-label text-foreground truncate">{file.path}</span>
                      {isNewSkill && (
                        <span className="typography-micro text-[var(--status-warning)] bg-[var(--status-warning)]/10 px-1.5 py-0.5 rounded flex-shrink-0">
                          pending
                        </span>
                      )}
                      <ButtonSmall
                        variant="ghost"
                        className="h-5 w-5 px-0 flex-shrink-0 text-muted-foreground hover:text-[var(--status-error)] opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteFile(file.path);
                        }}
                      >
                        <RiDeleteBinLine className="h-3 w-3" />
                      </ButtonSmall>
                    </div>
                  ))}
                </div>
              );
            })()}
          </section>
        </div>

        {/* Save action */}
        <div className="px-2 py-1">
          <ButtonSmall
            onClick={handleSave}
            disabled={isSaving || !hasSkillChanges}
            size="xs"
            className="!font-normal"
          >
            {isSaving ? 'Saving...' : isNewSkill ? 'Create Skill' : 'Save Changes'}
          </ButtonSmall>
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
            <DialogTitle>Delete Supporting File</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{deleteFilePath}"?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <ButtonLarge
              variant="ghost"
              onClick={() => setDeleteFilePath(null)}
              disabled={isDeletingFile}
            >
              Cancel
            </ButtonLarge>
            <ButtonLarge onClick={handleConfirmDeleteFile} disabled={isDeletingFile} className="bg-[var(--status-error)] hover:bg-[var(--status-error)]/90 text-white border-0">
              Delete
            </ButtonLarge>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isFileDialogOpen} onOpenChange={(open) => {
        setIsFileDialogOpen(open);
        if (!open) setEditingFilePath(null);
      }}>
        <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col" keyboardAvoid>
          <DialogHeader className="flex-shrink-0">
            <DialogTitle>{editingFilePath ? 'Edit Supporting File' : 'Add Supporting File'}</DialogTitle>
            <DialogDescription>
              {editingFilePath ? 'Modify the file content' : 'Create a new file in the skill directory'}
            </DialogDescription>
          </DialogHeader>
          {isLoadingFile ? (
            <div className="flex-1 flex items-center justify-center py-8">
              <span className="typography-meta text-muted-foreground">Loading file content...</span>
            </div>
          ) : (
            <div className="space-y-4 flex-1 min-h-0 flex flex-col pt-2">
              <div className="space-y-2 flex-shrink-0">
                <label className="typography-ui-label font-medium text-foreground">
                  File Path
                </label>
                <Input
                  value={newFileName}
                  onChange={(e) => setNewFileName(e.target.value)}
                  placeholder="example.md or docs/reference.txt"
                  className="text-foreground placeholder:text-muted-foreground focus-visible:ring-[var(--primary-base)]"
                  disabled={editingFilePath !== null}
                />
                {!editingFilePath && (
                  <p className="typography-micro text-muted-foreground">
                    Relative path within the skill directory. Subdirectories will be created automatically.
                  </p>
                )}
              </div>
              <div className="space-y-2 flex-1 min-h-0 flex flex-col">
                <label className="typography-ui-label font-medium text-foreground flex-shrink-0">
                  Content
                </label>
                <Textarea
                  value={newFileContent}
                  onChange={(e) => setNewFileContent(e.target.value)}
                  placeholder="File content..."
                  outerClassName="h-[45vh] min-h-[250px] max-h-[55vh]"
                  className="h-full min-h-0 font-mono typography-meta"
                />
              </div>
            </div>
          )}
          <DialogFooter className="mt-4">
            <ButtonLarge
              variant="ghost"
              onClick={() => {
                setIsFileDialogOpen(false);
                setEditingFilePath(null);
              }}
            >
              Cancel
            </ButtonLarge>
            <ButtonLarge onClick={handleSaveFile} disabled={isLoadingFile || !hasFileChanges}>
              {editingFilePath ? 'Save Changes' : 'Create File'}
            </ButtonLarge>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ScrollableOverlay>
  );
};

export const SkillsPage: React.FC<SkillsPageProps> = ({ view = 'installed' }) => {
  return view === 'catalog' ? <SkillsCatalogStandalone /> : <SkillsInstalledPage />;
};
