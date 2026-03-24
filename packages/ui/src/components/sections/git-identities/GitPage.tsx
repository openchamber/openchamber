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
import {
  RiAddLine,
  RiGitBranchLine,
  RiBriefcaseLine,
  RiHomeLine,
  RiGraduationCapLine,
  RiCodeLine,
  RiHeartLine,
  RiMore2Line,
  RiDeleteBinLine,
  RiDownloadLine,
  RiShieldKeyholeLine,
} from '@remixicon/react';
import { useGitIdentitiesStore, type GitIdentityProfile, type DiscoveredGitCredential } from '@/stores/useGitIdentitiesStore';
import { GitSettings } from '@/components/sections/openchamber/GitSettings';
import { GitHubSettings } from '@/components/sections/openchamber/GitHubSettings';
import { GitIdentityEditorDialog } from './GitIdentityEditorDialog';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { cn } from '@/lib/utils';
import { useLanguage } from '@/hooks/useLanguage';

const ICON_MAP: Record<string, React.ComponentType<{ className?: string; style?: React.CSSProperties }>> = {
  branch: RiGitBranchLine,
  briefcase: RiBriefcaseLine,
  house: RiHomeLine,
  graduation: RiGraduationCapLine,
  code: RiCodeLine,
  heart: RiHeartLine,
};

const COLOR_MAP: Record<string, string> = {
  keyword: 'var(--syntax-keyword)',
  error: 'var(--status-error)',
  string: 'var(--syntax-string)',
  function: 'var(--syntax-function)',
  type: 'var(--syntax-type)',
};

export const GitPage: React.FC = () => {
  const { t } = useLanguage();
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
  } = useGitIdentitiesStore();

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
      toast.error(t('gitPage.failedToUpdateDefaultIdentity'));
      return;
    }
    toast.success(next ? t('gitPage.defaultIdentityUpdated') : t('gitPage.defaultIdentityUnset'));
  };

  const handleConfirmDelete = async () => {
    if (!deleteDialogProfile) return;
    setIsDeletePending(true);
    const success = await deleteProfile(deleteDialogProfile.id);
    if (success) {
      toast.success(t('gitPage.profileDeleted', { name: deleteDialogProfile.name }));
      setDeleteDialogProfile(null);
    } else {
      toast.error(t('gitPage.failedToDeleteProfile'));
    }
    setIsDeletePending(false);
  };

  return (
    <>
      <ScrollableOverlay keyboardAvoid outerClassName="h-full" className="w-full bg-background">
        <div className="mx-auto w-full max-w-3xl space-y-6 p-3 sm:p-6 sm:pt-8">
          <GitHubSettings />

          {/* Identities Section */}
          <div className="border-t border-border/40 pt-6">
            <div className="mb-3 px-1 flex items-start justify-between gap-4">
              <div className="flex items-center gap-2">
                <h3 className="typography-ui-header font-semibold text-foreground">{t('gitPage.identitiesTitle')}</h3>
              </div>
              <Button size="sm" variant="outline" onClick={() => openEditor('new')}>
                <RiAddLine className="w-3.5 h-3.5 mr-1" /> {t('gitPage.newButton')}
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
                  <RiShieldKeyholeLine className="mx-auto mb-2 h-8 w-8 opacity-40" />
                  <p className="typography-ui-label">{t('gitPage.emptyTitle')}</p>
                  <p className="typography-meta mt-1 opacity-75">{t('gitPage.emptyDescription')}</p>
                </div>
              )}

              {/* Discovered credentials */}
              {unimportedCredentials.length > 0 && (
                <>
                  <div className="px-4 py-2 border-t border-[var(--surface-subtle)]">
                    <span className="typography-micro text-muted-foreground">
                      {t('gitPage.foundInGitCredentials')}
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
            <DialogTitle>{t('gitPage.deleteProfileTitle')}</DialogTitle>
            <DialogDescription>
              {t('gitPage.deleteProfileDescription', { name: deleteDialogProfile?.name ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteDialogProfile(null)} disabled={isDeletePending}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" variant="destructive" onClick={() => void handleConfirmDelete()} disabled={isDeletePending}>
              {t('common.delete')}
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
  const { t } = useLanguage();
  const IconComponent = ICON_MAP[profile.icon || 'branch'] || RiGitBranchLine;
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
        <IconComponent className="w-4 h-4 shrink-0" style={{ color: iconColor }} />
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="typography-ui-label text-foreground truncate">{profile.name}</span>
            <span className="typography-micro text-muted-foreground bg-muted px-1 rounded flex-shrink-0 leading-none pb-px border border-border/50">
              {authType}
            </span>
            {isDefault && (
              <span className="typography-micro text-primary bg-primary/12 px-1 rounded flex-shrink-0 leading-none pb-px border border-primary/25">
                {t('gitPage.defaultBadge')}
              </span>
            )}
            {isReadOnly && (
              <span className="typography-micro text-muted-foreground bg-muted px-1 rounded flex-shrink-0 leading-none pb-px border border-border/50">
                {t('gitPage.systemBadge')}
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
            <RiMore2Line className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-fit min-w-28">
          <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onToggleDefault(); }}>
            {isDefault ? t('gitPage.unsetDefault') : t('gitPage.setAsDefault')}
          </DropdownMenuItem>
          {!isReadOnly && onDelete && (
            <DropdownMenuItem
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
              className="text-destructive focus:text-destructive"
            >
              <RiDeleteBinLine className="h-4 w-4 mr-px" />
              {t('common.delete')}
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
  const { t } = useLanguage();
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
        <RiDownloadLine className="h-3 w-3" />
        {t('gitPage.importButton')}
      </Button>
    </div>
  );
};
