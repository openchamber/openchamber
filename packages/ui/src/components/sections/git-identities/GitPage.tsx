import { isCompleteIdentity } from '@/lib/api/git-identity';
import { identityAccountConnected, identityDisplayName } from '@/lib/source-control/identity';
import { isSignatureOnlyIdentity } from '@/lib/source-control/applyIdentity';
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
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { useGitIdentitiesStore, type GitIdentityProfile } from '@/stores/useGitIdentitiesStore';
import { useConnectedAccountIds, useSourceControlAuthStore } from '@/stores/useSourceControlAuthStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useShallow } from 'zustand/react/shallow';
import { GitSettings } from '@/components/sections/openchamber/GitSettings';
import { GitIdentityEditorDialog } from './GitIdentityEditorDialog';
import { Icon } from "@/components/icon/Icon";
import type { IconName } from "@/components/icon/icons";
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';

const ICON_MAP: Record<string, IconName> = {
  branch: 'git-branch',
  briefcase: 'briefcase',
  house: 'home',
  graduation: 'graduation-cap',
  code: 'code',
  heart: 'heart',
  github: 'github',
  gitlab: 'gitlab-fill',
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
  const { sourceControl } = useRuntimeAPIs();
  const refreshIdentityAccounts = useSourceControlAuthStore((state) => state.refreshIdentityAccounts);
  const {
    profiles,
    globalIdentity,
    defaultGitIdentityId,
    deleteProfile,
    loadProfiles,
    loadGlobalIdentity,
    loadDefaultGitIdentityId,
    setDefaultGitIdentityId,
  } = useGitIdentitiesStore(useShallow((s) => ({
    profiles: s.profiles,
    globalIdentity: s.globalIdentity,
    defaultGitIdentityId: s.defaultGitIdentityId,
    deleteProfile: s.deleteProfile,
    loadProfiles: s.loadProfiles,
    loadGlobalIdentity: s.loadGlobalIdentity,
    loadDefaultGitIdentityId: s.loadDefaultGitIdentityId,
    setDefaultGitIdentityId: s.setDefaultGitIdentityId,
  })));
  // An identity whose account was disconnected has to say so, so the accounts
  // of the instances these identities name are read when the page opens.
  React.useEffect(() => {
    void refreshIdentityAccounts(sourceControl, profiles.map((profile) => profile.account));
  }, [refreshIdentityAccounts, sourceControl, profiles]);

  const [editorOpen, setEditorOpen] = React.useState(false);
  const [editorProfileId, setEditorProfileId] = React.useState<string | null>(null);
  const [deleteDialogProfile, setDeleteDialogProfile] = React.useState<GitIdentityProfile | null>(null);
  const [isDeletePending, setIsDeletePending] = React.useState(false);

  React.useEffect(() => {
    loadProfiles();
    loadGlobalIdentity();
    loadDefaultGitIdentityId();
  }, [loadProfiles, loadGlobalIdentity, loadDefaultGitIdentityId]);

  const openEditor = (id: string | null) => {
    setEditorProfileId(id);
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
      <SettingsPageLayout
        title={t('settings.page.git.title')}
        showSaveStatus
        className="px-4 @xl:px-6 @3xl:px-12"
      >
        <SettingsSection
          title={t('settings.gitIdentities.page.section.title')}
          headerAction={(
            <Button size="sm" variant="outline" onClick={() => openEditor('new')}>
              <Icon name="add" className="w-3.5 h-3.5 mr-1" /> {t('settings.common.badge.new')}
            </Button>
          )}
          settingsItem="git.identities"
        >
          <div className="rounded-lg bg-[var(--surface-elevated)]/70 overflow-hidden flex flex-col">
            {/* Global identity */}
            {globalIdentity && (
              <IdentityRow
                profile={globalIdentity}
                isDefault={defaultGitIdentityId === 'global'}
                onEdit={() => openEditor('global')}
                onToggleDefault={() => handleToggleDefault('global')}
                isReadOnly
                hasBorder={profiles.length > 0}
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
                hasBorder={i < profiles.length - 1}
              />
            ))}

            {/* Empty state */}
            {!globalIdentity && profiles.length === 0 && (
              <div className="py-8 px-4 text-center text-muted-foreground">
                <Icon name="shield-keyhole" className="mx-auto mb-2 h-8 w-8 opacity-40" />
                <p className="typography-ui-label">{t('settings.gitIdentities.page.empty.title')}</p>
                <p className="typography-meta mt-1 opacity-75">{t('settings.gitIdentities.page.empty.description')}</p>
              </div>
            )}
          </div>
        </SettingsSection>

        <GitSettings />
      </SettingsPageLayout>

      {/* Editor dialog */}
      <GitIdentityEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        profileId={editorProfileId}
      />

      {/* Delete confirmation */}
      <Dialog
        open={deleteDialogProfile !== null}
        onOpenChange={(open) => {
          if (!open && !isDeletePending) setDeleteDialogProfile(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.gitIdentities.page.deleteDialog.title')}</DialogTitle>
            <DialogDescription>
              {t('settings.gitIdentities.page.deleteDialog.description', { name: deleteDialogProfile?.name ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={() => setDeleteDialogProfile(null)} disabled={isDeletePending}>
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
  const connectedAccountIds = useConnectedAccountIds();
  const [contextMenuOpen, setContextMenuOpen] = React.useState(false);
  const iconName = ICON_MAP[profile.icon || 'branch'] || 'git-branch';
  // What this identity is, when it is not a complete one: a signature kept
  // from an older release, or one whose account was disconnected.
  const noteKey = isSignatureOnlyIdentity(profile)
    ? 'settings.gitIdentities.page.signatureOnly' as const
    : !isCompleteIdentity(profile)
      ? 'settings.gitIdentities.page.incomplete' as const
      : !identityAccountConnected(profile, connectedAccountIds)
        ? 'settings.gitIdentities.page.accountGone' as const
        : null;
  const noteIsWarning = noteKey !== null && noteKey !== 'settings.gitIdentities.page.signatureOnly';
  const iconColor = COLOR_MAP[profile.color || ''];

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.currentTarget !== e.target) return;
    if (e.key !== 'Enter' && e.key !== ' ') return;

    e.preventDefault();
    onEdit();
  };

  const renderMenuItems = (Item: React.ElementType) => (
    <>
      <Item onClick={(e: React.MouseEvent) => { e.stopPropagation(); onToggleDefault(); }}>
        {isDefault ? t('settings.gitIdentities.page.actions.unsetDefault') : t('settings.gitIdentities.page.actions.setAsDefault')}
      </Item>
      {!isReadOnly && onDelete && (
        <Item
          onClick={(e: React.MouseEvent) => { e.stopPropagation(); onDelete(); }}
          className="text-destructive focus:text-destructive"
        >
          <Icon name="delete-bin" className="h-4 w-4 mr-px" />
          {t('settings.common.actions.delete')}
        </Item>
      )}
    </>
  );

  return (
    <ContextMenu open={contextMenuOpen} onOpenChange={setContextMenuOpen}>
      <ContextMenuTrigger
        render={
          <div
            className={cn(
              'group flex items-center justify-between gap-3 px-4 py-2.5 transition-colors hover:bg-[var(--interactive-hover)]/30 cursor-pointer',
              hasBorder && 'border-b border-[var(--surface-subtle)]'
            )}
            onClick={onEdit}
            role="button"
            tabIndex={0}
            onKeyDown={handleKeyDown}
            onContextMenu={(event) => {
              event.preventDefault();
              setContextMenuOpen(true);
            }}
          />
        }
      >
      <div className="flex items-center gap-3 min-w-0">
        <Icon name={iconName} className="w-4 h-4 shrink-0" style={{ color: iconColor }} />
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="typography-ui-label text-foreground truncate">{identityDisplayName(profile, t)}</span>
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
            {!isReadOnly && noteKey
              ? <span className={noteIsWarning ? 'text-[var(--status-warning)]' : undefined}>{t(noteKey)}</span>
              : profile.userEmail}
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
          {renderMenuItems(DropdownMenuItem)}
        </DropdownMenuContent>
      </DropdownMenu>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-fit min-w-28">
        {renderMenuItems(ContextMenuItem)}
      </ContextMenuContent>
    </ContextMenu>
  );
};
