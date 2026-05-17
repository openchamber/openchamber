import React from 'react';
import { toast } from '@/components/ui';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useGitIdentitiesStore, type GitIdentityProfile, type DiscoveredGitCredential } from '@/stores/useGitIdentitiesStore';
import { useShallow } from 'zustand/react/shallow';
import { GitSettings } from '@/components/sections/openchamber/GitSettings';
import { GitHubSettings } from '@/components/sections/openchamber/GitHubSettings';
import { GitIdentityEditorDialog } from './GitIdentityEditorDialog';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Icon } from "@/components/icon/Icon";
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';

const ICON_MAP: Record<string, string> = {
  branch: 'git-branch',
  briefcase: 'briefcase',
  house: 'home',
  graduation: 'graduation-cap',
  code: 'code',
  heart: 'heart',
};

const COLOR_MAP: Record<string, string> = {
  keyword: 'var(--syntax-keyword)',
  error: 'var(--status-error)',
  string: 'var(--syntax-string)',
  function: 'var(--syntax-function)',
  type: 'var(--syntax-type)',
};

export const GitPage: React.FC = () => {
  const { t } = useI18n();
  const {
    profiles,
    globalIdentity,
    defaultGitIdentityId,
    deleteProfile,
    loadProfiles,
    loadGlobalIdentity,
    loadDiscoveredCredentials,
    loadDefaultGitIdentityId,
    setDefaultGitIdentityId,
    getUnimportedCredentials,
  } = useGitIdentitiesStore(useShallow((s) => ({
    profiles: s.profiles,
    globalIdentity: s.globalIdentity,
    defaultGitIdentityId: s.defaultGitIdentityId,
    deleteProfile: s.deleteProfile,
    loadProfiles: s.loadProfiles,
    loadGlobalIdentity: s.loadGlobalIdentity,
    loadDiscoveredCredentials: s.loadDiscoveredCredentials,
    loadDefaultGitIdentityId: s.loadDefaultGitIdentityId,
    setDefaultGitIdentityId: s.setDefaultGitIdentityId,
    getUnimportedCredentials: s.getUnimportedCredentials,
  })));

  const [editorOpen, setEditorOpen] = React.useState(false);
  const [editorProfileId, setEditorProfileId] = React.useState<string | null>(null);
  const [editorImportData, setEditorImportData] = React.useState<{ host: string; username: string } | null>(null);
  const [deleteDialogProfile, setDeleteDialogProfile] = React.useState<GitIdentityProfile | null>(null);
  const [isDeletePending, setIsDeletePending] = React.useState(false);

  React.useEffect(() => {
    loadProfiles();
    loadGlobalIdentity();
    loadDiscoveredCredentials();
    loadDefaultGitIdentityId();
  }, [loadProfiles, loadGlobalIdentity, loadDiscoveredCredentials, loadDefaultGitIdentityId]);

  const unimportedCredentials = getUnimportedCredentials();

  const openEditor = (id: string | null, importData?: { host: string; username: string } | null) => {
    setEditorProfileId(id);
    setEditorImportData(importData ?? null);
    setEditorOpen(true);
  };

  const handleToggleDefault = async (profileId: string) => {
    const next = defaultGitIdentityId === profileId ? null : profileId;
    const ok = await setDefaultGitIdentityId(next);
    if (!ok) {
      toast.error(t('settings.gitIdentities.page.toast.updateDefaultFailed'));
      return;
    }
    toast.success(next ? t('settings.gitIdentities.page.toast.defaultUpdated') : t('settings.gitIdentities.page.toast.defaultUnset'));
  };

  const handleConfirmDelete = async () => {
    if (!deleteDialogProfile) return;
    setIsDeletePending(true);
    const success = await deleteProfile(deleteDialogProfile.id);
    if (success) {
      toast.success(t('settings.gitIdentities.page.toast.profileDeleted', { name: deleteDialogProfile.name }));
      setDeleteDialogProfile(null);
    } else {
      toast.error(t('settings.gitIdentities.page.toast.deleteProfileFailed'));
    }
    setIsDeletePending(false);
  };

  return (
    <>
      <ScrollableOverlay outerClassName="h-full" className="w-full bg-background">
        <div className="mx-auto w-full max-w-3xl space-y-6 p-3 sm:p-6 sm:pt-8">
          <GitHubSettings />

          {/* Identities Section */}
          <div className="border-t border-border/40 pt-6">
            <div className="mb-3 px-1 flex items-start justify-between gap-4">
              <div className="flex items-center gap-2">
                <h3 className="typography-ui-header font-semibold text-foreground">{t('settings.gitIdentities.page.section.title')}</h3>
              </div>
              <Button size="sm" variant="outline" onClick={() => openEditor('new')}>
                <Icon name="add" className="w-3.5 h-3.5 mr-1" /> {t('settings.common.badge.new')}
              </Button>
            </div>

            <div className="rounded-lg bg-[var(--surface-elevated)]/70 overflow-hidden flex flex-col">
              {/* Global identity */}
              {globalIdentity && (
                <IdentityRow
                  profile={globalIdentity}
                  isDefault={defaultGitIdentityId === 'global'}
                  onEdit={() => openEditor('global')}
                  onToggleDefault={() => handleToggleDefault('global')}
                  isReadOnly
                  hasBorder={profiles.length > 0 || unimportedCredentials.length > 0}
                />
              )}

              {/* Custom profiles */}
              {profiles.map((profile, i) => (
                <IdentityRow
                  key={profile.id}
                  profile={profile}
                  isDefault={defaultGitIdentityId === profile.id}
                  onEdit={() => openEditor(profile.id)}
                  onToggleDefault={() => handleToggleDefault(profile.id)}
                  onDelete={() => setDeleteDialogProfile(profile)}
                  hasBorder={i < profiles.length - 1 || unimportedCredentials.length > 0}
                />
              ))}

              {/* Empty state */}
              {!globalIdentity && profiles.length === 0 && unimportedCredentials.length === 0 && (
                <div className="py-8 px-4 text-center text-muted-foreground">
                  <Icon name="shield-keyhole" className="mx-auto mb-2 h-8 w-8 opacity-40" />
                  <p className="typography-ui-label">{t('settings.gitIdentities.page.empty.title')}</p>
                  <p className="typography-meta mt-1 opacity-75">{t('settings.gitIdentities.page.empty.description')}</p>
                </div>
              )}

              {/* Discovered credentials */}
              {unimportedCredentials.length > 0 && (
                <>
                  <div className="px-4 py-2 border-t border-[var(--surface-subtle)]">
                    <span className="typography-micro text-muted-foreground">
                      {t('settings.gitIdentities.page.discoveredCredentials.title')}
                    </span>
                  </div>
                  {unimportedCredentials.map((cred, i) => (
                    <DiscoveredRow
                      key={`${cred.host}-${cred.username}`}
                      credential={cred}
                      onImport={() => openEditor('new', { host: cred.host, username: cred.username })}
                      hasBorder={i < unimportedCredentials.length - 1}
                    />
                  ))}
                </>
              )}
            </div>
          </div>

          <GitSettings />
        </div>
      </ScrollableOverlay>

      {/* Editor dialog */}
      <GitIdentityEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        profileId={editorProfileId}
        importData={editorImportData}
      />

      {/* Delete confirmation */}
      <Dialog
        open={deleteDialogProfile !== null}
        onOpenChange={(o) => { if (!isDeletePending) { if (!o) setDeleteDialogProfile(null); } }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.gitIdentities.page.deleteDialog.title')}</DialogTitle>
            <DialogDescription>
              {t('settings.gitIdentities.page.deleteDialog.description', { name: deleteDialogProfile?.name ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteDialogProfile(null)} disabled={isDeletePending}>
              {t('settings.common.actions.cancel')}
            </Button>
            <Button size="sm" variant="destructive" onClick={() => void handleConfirmDelete()} disabled={isDeletePending}>
              {t('settings.common.actions.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

// --- Identity row ---

interface IdentityRowProps {
  profile: GitIdentityProfile;
  isDefault: boolean;
  onEdit: () => void;
  onToggleDefault: () => void;
  onDelete?: () => void;
  isReadOnly?: boolean;
  hasBorder?: boolean;
}

const IdentityRow: React.FC<IdentityRowProps> = ({
  profile,
  isDefault,
  onEdit,
  onToggleDefault,
  onDelete,
  isReadOnly,
  hasBorder,
}) => {
  const { t } = useI18n();
  const iconName = ICON_MAP[profile.icon || 'branch'] || 'git-branch';
  const iconColor = COLOR_MAP[profile.color || ''];
  const authType = profile.authType || 'ssh';

  return (
    <div
      className={cn(
        'group flex items-center justify-between gap-3 px-4 py-2.5 transition-colors hover:bg-[var(--interactive-hover)]/30 cursor-pointer',
        hasBorder && 'border-b border-[var(--surface-subtle)]'
      )}
      onClick={onEdit}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onEdit(); }}
    >
      <div className="flex items-center gap-3 min-w-0">
        <Icon name={iconName} className="w-4 h-4 shrink-0" style={{ color: iconColor }} />
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="typography-ui-label text-foreground truncate">{profile.name}</span>
            <span className="typography-micro text-muted-foreground bg-muted px-1 rounded flex-shrink-0 leading-none pb-px border border-border/50">
              {authType}
            </span>
            {isDefault && (
              <span className="typography-micro text-primary bg-primary/12 px-1 rounded flex-shrink-0 leading-none pb-px border border-primary/25">
                {t('settings.gitIdentities.page.badge.default')}
              </span>
            )}
            {isReadOnly && (
              <span className="typography-micro text-muted-foreground bg-muted px-1 rounded flex-shrink-0 leading-none pb-px border border-border/50">
                {t('settings.agents.sidebar.badge.system')}
              </span>
            )}
          </div>
          <div className="typography-micro text-muted-foreground/60 truncate leading-tight">
            {authType === 'token' && profile.host ? profile.host : profile.userEmail}
          </div>
        </div>
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6 shrink-0 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100"
            onClick={(e) => e.stopPropagation()}
          >
            <Icon name="more-2" className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-fit min-w-28">
          <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onToggleDefault(); }}>
            {isDefault ? t('settings.gitIdentities.page.actions.unsetDefault') : t('settings.gitIdentities.page.actions.setAsDefault')}
          </DropdownMenuItem>
          {!isReadOnly && onDelete && (
            <DropdownMenuItem
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
              className="text-destructive focus:text-destructive"
            >
              <Icon name="delete-bin" className="h-4 w-4 mr-px" />
              {t('settings.common.actions.delete')}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};

// --- Discovered credential row ---

interface DiscoveredRowProps {
  credential: DiscoveredGitCredential;
  onImport: () => void;
  hasBorder?: boolean;
}

const DiscoveredRow: React.FC<DiscoveredRowProps> = ({ credential, onImport, hasBorder }) => {
  const { t } = useI18n();
  const parts = credential.host.split('/');
  const displayName = parts.length >= 3 ? parts[parts.length - 1] : credential.host;
  const isRepoSpecific = credential.host.includes('/');

  return (
    <div
      className={cn(
        'flex items-center justify-between gap-3 px-4 py-2.5 transition-colors hover:bg-[var(--interactive-hover)]/30',
        hasBorder && 'border-b border-[var(--surface-subtle)]'
      )}
    >
      <div className="min-w-0">
        <span className="typography-ui-label text-foreground truncate block">{displayName}</span>
        <span className="typography-micro text-muted-foreground/60 truncate block leading-tight">
          {isRepoSpecific ? credential.host : credential.username}
        </span>
      </div>
      <Button size="sm" variant="ghost" onClick={onImport} className="gap-1 shrink-0">
        <Icon name="download" className="h-3 w-3" />
        {t('settings.gitIdentities.page.actions.import')}
      </Button>
    </div>
  );
};
