import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from "@/components/icon/Icon";
import { useGitIdentitiesStore, type GitIdentityProfile, type GitIdentityAuthType } from '@/stores/useGitIdentitiesStore';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';

const PROFILE_COLORS = [
  { key: 'keyword', label: 'Green', cssVar: 'var(--syntax-keyword)' },
  { key: 'error', label: 'Red', cssVar: 'var(--status-error)' },
  { key: 'string', label: 'Cyan', cssVar: 'var(--syntax-string)' },
  { key: 'function', label: 'Orange', cssVar: 'var(--syntax-function)' },
  { key: 'type', label: 'Yellow', cssVar: 'var(--syntax-type)' },
];

const PROFILE_ICONS = [
  { key: 'branch', Icon: 'git-branch', label: 'Branch' },
  { key: 'briefcase', Icon: 'briefcase', label: 'Work' },
  { key: 'house', Icon: 'home', label: 'Personal' },
  { key: 'graduation', Icon: 'graduation-cap', label: 'School' },
  { key: 'code', Icon: 'code', label: 'Code' },
];

interface GitIdentityEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Profile ID to edit, 'new' for creation, or null */
  profileId: string | null;
  /** Pre-fill data for importing a discovered credential */
  importData?: { host: string; username: string } | null;
}

export const GitIdentityEditorDialog: React.FC<GitIdentityEditorDialogProps> = ({
  open,
  onOpenChange,
  profileId,
  importData,
}) => {
  const { t } = useI18n();
  const getProfileById = useGitIdentitiesStore((s) => s.getProfileById);
  const createProfile = useGitIdentitiesStore((s) => s.createProfile);
  const updateProfile = useGitIdentitiesStore((s) => s.updateProfile);
  const deleteProfile = useGitIdentitiesStore((s) => s.deleteProfile);

  const selectedProfile = React.useMemo(() =>
    profileId && profileId !== 'new' && !importData ? getProfileById(profileId) : null,
    [profileId, getProfileById, importData]
  );
  const isNewProfile = profileId === 'new' || importData != null;
  const isGlobalProfile = profileId === 'global';

  const [name, setName] = React.useState('');
  const [userName, setUserName] = React.useState('');
  const [userEmail, setUserEmail] = React.useState('');
  const [authType, setAuthType] = React.useState<GitIdentityAuthType>('ssh');
  const [sshKey, setSshKey] = React.useState('');
  const [host, setHost] = React.useState('');
  const [color, setColor] = React.useState('keyword');
  const [icon, setIcon] = React.useState('branch');
  const [isSaving, setIsSaving] = React.useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = React.useState(false);
  const [isDeleting, setIsDeleting] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    if (importData) {
      const parts = importData.host.split('/');
      const displayName = parts.length >= 3 ? parts[parts.length - 1] : importData.host;
      setName(displayName);
      setUserName(importData.username);
      setUserEmail('');
      setAuthType('token');
      setSshKey('');
      setHost(importData.host);
      setColor('string');
      setIcon('code');
    } else if (isNewProfile) {
      setName('');
      setUserName('');
      setUserEmail('');
      setAuthType('ssh');
      setSshKey('');
      setHost('');
      setColor('keyword');
      setIcon('branch');
    } else if (selectedProfile) {
      setName(selectedProfile.name);
      setUserName(selectedProfile.userName);
      setUserEmail(selectedProfile.userEmail);
      setAuthType(selectedProfile.authType || 'ssh');
      setSshKey(selectedProfile.sshKey || '');
      setHost(selectedProfile.host || '');
      setColor(selectedProfile.color || 'keyword');
      setIcon(selectedProfile.icon || 'branch');
    } else if (isGlobalProfile) {
      const global = getProfileById('global');
      if (global) {
        setName(global.name);
        setUserName(global.userName);
        setUserEmail(global.userEmail);
        setAuthType(global.authType || 'ssh');
        setSshKey(global.sshKey || '');
        setHost(global.host || '');
        setColor(global.color || 'keyword');
        setIcon(global.icon || 'branch');
      }
    }
  }, [open, profileId, selectedProfile, isNewProfile, importData, isGlobalProfile, getProfileById]);

  const handleSave = async () => {
    if (!userName.trim() || !userEmail.trim()) {
      toast.error(t('settings.gitIdentities.editor.toast.userNameEmailRequired'));
      return;
    }
    if (authType === 'token' && !host.trim()) {
      toast.error(t('settings.gitIdentities.editor.toast.hostRequiredForToken'));
      return;
    }

    setIsSaving(true);
    try {
      const profileData: Omit<GitIdentityProfile, 'id'> & { id?: string } = {
        name: name.trim() || userName.trim(),
        userName: userName.trim(),
        userEmail: userEmail.trim(),
        authType,
        sshKey: authType === 'ssh' ? (sshKey.trim() || null) : null,
        host: authType === 'token' ? (host.trim() || null) : null,
        color,
        icon,
      };

      let success: boolean;
      if (isNewProfile) {
        success = await createProfile(profileData);
      } else if (profileId) {
        success = await updateProfile(profileId, profileData);
      } else {
        return;
      }

      if (success) {
        toast.success(isNewProfile ? t('settings.gitIdentities.editor.toast.profileCreated') : t('settings.gitIdentities.editor.toast.profileUpdated'));
        onOpenChange(false);
      } else {
        toast.error(isNewProfile ? t('settings.gitIdentities.editor.toast.createProfileFailed') : t('settings.gitIdentities.editor.toast.updateProfileFailed'));
      }
    } catch (error) {
      console.error('Error saving profile:', error);
      toast.error(t('settings.gitIdentities.editor.toast.saveUnexpectedError'));
    } finally {
      setIsSaving(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!profileId || isNewProfile) return;
    setIsDeleting(true);
    try {
      const success = await deleteProfile(profileId);
      if (success) {
        toast.success(t('settings.gitIdentities.editor.toast.profileDeleted'));
        setIsDeleteDialogOpen(false);
        onOpenChange(false);
      } else {
        toast.error(t('settings.gitIdentities.editor.toast.deleteProfileFailed'));
      }
    } catch (error) {
      console.error('Error deleting profile:', error);
      toast.error(t('settings.gitIdentities.editor.toast.deleteUnexpectedError'));
    } finally {
      setIsDeleting(false);
    }
  };

  const currentColorValue = React.useMemo(() => {
    const colorConfig = PROFILE_COLORS.find(c => c.key === color);
    return colorConfig?.cssVar || 'var(--syntax-keyword)';
  }, [color]);

  const title = importData
    ? t('settings.gitIdentities.editor.title.importCredential')
    : isNewProfile
    ? t('settings.gitIdentities.editor.title.newIdentity')
    : isGlobalProfile
    ? t('settings.gitIdentities.editor.title.globalIdentity')
    : (selectedProfile?.name || t('settings.gitIdentities.editor.title.editIdentity'));

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              {isGlobalProfile
                ? t('settings.gitIdentities.editor.description.globalReadOnly')
                : isNewProfile
                ? t('settings.gitIdentities.editor.description.newProfile')
                : t('settings.gitIdentities.editor.description.editProfile')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5 py-2">
            {/* Profile Display */}
            {!isGlobalProfile && (
              <div className="space-y-3">
                <div>
                  <label className="typography-ui-label text-foreground block mb-1.5">{t('settings.gitIdentities.editor.field.profileName')}</label>
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t('settings.gitIdentities.editor.field.profileNamePlaceholder')}
                    className="h-8"
                  />
                </div>

                <div className="flex items-center justify-between gap-4">
                  <span className="typography-ui-label text-foreground">{t('settings.gitIdentities.editor.field.color')}</span>
                  <div className="flex gap-1.5">
                    {PROFILE_COLORS.map((c) => (
                      <button
                        key={c.key}
                        type="button"
                        onClick={() => setColor(c.key)}
                        className={cn(
                          'w-6 h-6 rounded-md border-2 transition-all cursor-pointer',
                          color === c.key
                            ? 'border-foreground scale-110'
                            : 'border-transparent hover:border-border'
                        )}
                        style={{ backgroundColor: c.cssVar }}
                        title={c.label}
                      />
                    ))}
                  </div>
                </div>

                <div className="flex items-center justify-between gap-4">
                  <span className="typography-ui-label text-foreground">{t('settings.gitIdentities.editor.field.icon')}</span>
                  <div className="flex gap-1.5">
                    {PROFILE_ICONS.map((i) => {
                      const iconName = i.Icon;
                      return (
                        <button
                          key={i.key}
                          type="button"
                          onClick={() => setIcon(i.key)}
                          className={cn(
                            'w-7 h-7 rounded-md border-2 transition-all flex items-center justify-center cursor-pointer',
                            icon === i.key
                              ? 'border-[var(--interactive-border)] bg-[var(--surface-muted)]'
                              : 'border-transparent hover:border-[var(--interactive-border)] hover:bg-[var(--surface-muted)]/50'
                          )}
                          title={i.label}
                        >
                          <Icon name={iconName}
                            className="w-3.5 h-3.5"
                            style={{ color: icon === i.key ? currentColorValue : 'var(--surface-muted-foreground)' }}
                          />
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            {/* Separator */}
            {!isGlobalProfile && <div className="border-t border-border/40" />}

            {/* Git Author */}
            <div className="space-y-3">
              <div>
                <div className="flex items-center gap-1.5 mb-1.5">
                  <label className="typography-ui-label text-foreground">{t('settings.gitIdentities.editor.field.userName')}</label>
                  {!isGlobalProfile && <span className="text-[var(--status-error)] text-xs">*</span>}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Icon name="information" className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                    </TooltipTrigger>
                    <TooltipContent sideOffset={8} className="max-w-xs">
                      {t('settings.gitIdentities.editor.field.userNameTooltip')}
                    </TooltipContent>
                  </Tooltip>
                </div>
                <Input
                  value={userName}
                  onChange={(e) => setUserName(e.target.value)}
                  placeholder={t('settings.gitIdentities.editor.field.userNamePlaceholder')}
                  required={!isGlobalProfile}
                  readOnly={isGlobalProfile}
                  disabled={isGlobalProfile}
                  className="h-8"
                />
              </div>

              <div>
                <div className="flex items-center gap-1.5 mb-1.5">
                  <label className="typography-ui-label text-foreground">{t('settings.gitIdentities.editor.field.emailAddress')}</label>
                  {!isGlobalProfile && <span className="text-[var(--status-error)] text-xs">*</span>}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Icon name="information" className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                    </TooltipTrigger>
                    <TooltipContent sideOffset={8} className="max-w-xs">
                      {t('settings.gitIdentities.editor.field.emailAddressTooltip')}
                    </TooltipContent>
                  </Tooltip>
                </div>
                <Input
                  type="email"
                  value={userEmail}
                  onChange={(e) => setUserEmail(e.target.value)}
                  placeholder={t('settings.gitIdentities.editor.field.emailAddressPlaceholder')}
                  required={!isGlobalProfile}
                  readOnly={isGlobalProfile}
                  disabled={isGlobalProfile}
                  className="h-8"
                />
              </div>
            </div>

            {/* Authentication */}
            {!isGlobalProfile && (
              <>
                <div className="border-t border-border/40" />
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-4">
                    <span className="typography-ui-label text-foreground">{t('settings.gitIdentities.editor.field.authMethod')}</span>
                    <div className="flex items-center gap-1">
                      <Button size="sm"
                        type="button"
                        variant="chip"
                        aria-pressed={authType === 'ssh'}
                        onClick={() => setAuthType('ssh')}
                      >
                        <Icon name="lock-2" className="w-3.5 h-3.5 mr-1" /> SSH
                      </Button>
                      <Button size="sm"
                        type="button"
                        variant="chip"
                        aria-pressed={authType === 'token'}
                        onClick={() => setAuthType('token')}
                      >
                        <Icon name="key" className="w-3.5 h-3.5 mr-1" /> {t('settings.gitIdentities.editor.field.authToken')}
                      </Button>
                    </div>
                  </div>

                  {authType === 'ssh' && (
                    <div>
                      <div className="flex items-center gap-1.5 mb-1.5">
                        <label className="typography-ui-label text-foreground">{t('settings.gitIdentities.editor.field.sshKeyPath')}</label>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Icon name="information" className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                          </TooltipTrigger>
                          <TooltipContent sideOffset={8} className="max-w-xs">
                            {t('settings.gitIdentities.editor.field.sshKeyPathTooltip')}
                          </TooltipContent>
                        </Tooltip>
                      </div>
                      <Input
                        value={sshKey}
                        onChange={(e) => setSshKey(e.target.value)}
                        placeholder={t('settings.gitIdentities.editor.field.sshKeyPathPlaceholder')}
                        className="h-8 font-mono text-xs"
                      />
                    </div>
                  )}

                  {authType === 'token' && (
                    <div>
                      <div className="flex items-center gap-1.5 mb-1.5">
                        <label className="typography-ui-label text-foreground">{t('settings.gitIdentities.editor.field.host')}</label>
                        <span className="text-[var(--status-error)] text-xs">*</span>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Icon name="information" className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                          </TooltipTrigger>
                          <TooltipContent sideOffset={8} className="max-w-xs">
                            {t('settings.gitIdentities.editor.field.hostTooltip')}
                          </TooltipContent>
                        </Tooltip>
                      </div>
                      <Input
                        value={host}
                        onChange={(e) => setHost(e.target.value)}
                        placeholder={t('settings.gitIdentities.editor.field.hostPlaceholder')}
                        required
                        className="h-8 font-mono text-xs"
                      />
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          <DialogFooter className="gap-2">
            {!isGlobalProfile && !isNewProfile && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setIsDeleteDialogOpen(true)}
                className="text-[var(--status-error)] hover:text-[var(--status-error)] border-[var(--status-error)]/30 hover:bg-[var(--status-error)]/10 mr-auto"
              >
                <Icon name="delete-bin" className="w-3.5 h-3.5 mr-1" /> {t('settings.common.actions.delete')}
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} className="text-foreground hover:bg-interactive-hover hover:text-foreground">
              {isGlobalProfile ? t('settings.gitIdentities.editor.actions.close') : t('settings.common.actions.cancel')}
            </Button>
            {!isGlobalProfile && (
              <Button size="sm" onClick={handleSave} disabled={isSaving}>
                {isSaving ? t('settings.common.actions.saving') : isNewProfile ? t('settings.gitIdentities.editor.actions.create') : t('settings.gitIdentities.editor.actions.save')}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog
        open={isDeleteDialogOpen}
        onOpenChange={(o) => { if (!isDeleting) setIsDeleteDialogOpen(o); }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.gitIdentities.page.deleteDialog.title')}</DialogTitle>
            <DialogDescription>
              {t('settings.gitIdentities.page.deleteDialog.description', { name: selectedProfile?.name || name })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setIsDeleteDialogOpen(false)} disabled={isDeleting}>
              {t('settings.common.actions.cancel')}
            </Button>
            <Button size="sm" variant="destructive" onClick={() => void handleConfirmDelete()} disabled={isDeleting}>
              {t('settings.common.actions.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
