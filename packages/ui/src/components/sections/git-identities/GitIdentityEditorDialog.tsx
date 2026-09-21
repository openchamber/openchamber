import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SettingsCheckboxRow, SETTINGS_FIELD_LABEL_CLASS, SETTINGS_HELPER_CLASS } from '@/components/sections/shared/SettingsSection';
import { SettingsInfoHint } from '@/components/sections/shared/SettingsInfoHint';
import { toast } from '@/components/ui';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Icon } from "@/components/icon/Icon";
import type { IconName } from "@/components/icon/icons";
import { useGitIdentitiesStore, type GitIdentityProfile } from '@/stores/useGitIdentitiesStore';
import { ManagedSshCredentials } from '@/components/sections/openchamber/ManagedSshCredentials';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { getSourceControlAuthKey, useSourceControlAuthStore } from '@/stores/useSourceControlAuthStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { buildManagedAccountOptions, getManagedCredentialSourceLabelKey } from '@/lib/source-control/identity';
import type { GitIdentityTransport } from '@/lib/api/types';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';

/** Select value for an identity that answers to no connected account. */
const NO_ACCOUNT = '__none__';

/**
 * How an identity authenticates. OAuth and Token are both the account's own
 * credential; the chip decides which of the connected credentials may be picked.
 */
type AuthMethod = 'oauth' | 'token' | 'ssh' | 'anonymous';
const AUTH_METHODS = [
  { method: 'oauth', icon: 'user-3', labelKey: 'settings.gitIdentities.editor.auth.oauth', hintKey: 'settings.gitIdentities.editor.auth.oauthHint' },
  { method: 'token', icon: 'shield', labelKey: 'settings.gitIdentities.editor.auth.token', hintKey: 'settings.gitIdentities.editor.auth.tokenHint' },
  { method: 'ssh', icon: 'lock', labelKey: 'settings.gitIdentities.editor.auth.ssh', hintKey: null },
  { method: 'anonymous', icon: 'global', labelKey: 'settings.gitIdentities.editor.auth.anonymous', hintKey: 'settings.gitIdentities.editor.auth.anonymousHint' },
] as const satisfies ReadonlyArray<{ method: AuthMethod; icon: IconName; labelKey: string; hintKey: string | null }>;
const transportOf = (method: AuthMethod): GitIdentityTransport =>
  method === 'ssh' ? 'ssh' : method === 'anonymous' ? 'anonymous' : 'account';
/** The credential source a method admits; null admits every account. */
const sourceOf = (method: AuthMethod): 'oauth' | 'pat' | null =>
  method === 'oauth' ? 'oauth' : method === 'token' ? 'pat' : null;

const PROFILE_COLORS = [
  { key: 'keyword', label: 'Green', cssVar: 'var(--syntax-keyword)' },
  { key: 'error', label: 'Red', cssVar: 'var(--status-error)' },
  { key: 'string', label: 'Cyan', cssVar: 'var(--syntax-string)' },
  { key: 'function', label: 'Orange', cssVar: 'var(--syntax-function)' },
  { key: 'type', label: 'Yellow', cssVar: 'var(--syntax-type)' },
];

const PROFILE_ICONS: Array<{ key: string; Icon: IconName; label: string }> = [
  { key: 'branch', Icon: 'git-branch', label: 'Branch' },
  { key: 'briefcase', Icon: 'briefcase', label: 'Work' },
  { key: 'house', Icon: 'home', label: 'Personal' },
  { key: 'graduation', Icon: 'graduation-cap', label: 'School' },
  { key: 'code', Icon: 'code', label: 'Code' },
  { key: 'github', Icon: 'github', label: 'GitHub' },
  { key: 'gitlab', Icon: 'gitlab-fill', label: 'GitLab' },
];

interface GitIdentityEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Profile ID to edit, 'new' for creation, or null */
  profileId: string | null;
}

export const GitIdentityEditorDialog: React.FC<GitIdentityEditorDialogProps> = ({
  open,
  onOpenChange,
  profileId,
}) => {
  const { t } = useI18n();
  const getProfileById = useGitIdentitiesStore((s) => s.getProfileById);
  const createProfile = useGitIdentitiesStore((s) => s.createProfile);
  const updateProfile = useGitIdentitiesStore((s) => s.updateProfile);
  const deleteProfile = useGitIdentitiesStore((s) => s.deleteProfile);

  const selectedProfile = React.useMemo(() =>
    profileId && profileId !== 'new' ? getProfileById(profileId) : null,
    [profileId, getProfileById]
  );
  const isNewProfile = profileId === 'new';
  const isGlobalProfile = profileId === 'global';

  const [name, setName] = React.useState('');
  const [userName, setUserName] = React.useState('');
  const [userEmail, setUserEmail] = React.useState('');
  const [signCommits, setSignCommits] = React.useState(false);
  const [signingKey, setSigningKey] = React.useState('');
  const [color, setColor] = React.useState('keyword');
  const [icon, setIcon] = React.useState('branch');
  const [accountKey, setAccountKey] = React.useState(NO_ACCOUNT);
  const [method, setMethod] = React.useState<AuthMethod>('oauth');
  const [sshCredentialId, setSshCredentialId] = React.useState('');
  const [isSaving, setIsSaving] = React.useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = React.useState(false);
  const [isDeleting, setIsDeleting] = React.useState(false);

  const { sourceControl } = useRuntimeAPIs();
  const identities = useSourceControlAuthStore((state) => state.identities);
  const authEntries = useSourceControlAuthStore((state) => state.entries);
  const refreshAccounts = useSourceControlAuthStore((state) => state.refreshAll);
  React.useEffect(() => {
    if (open && !isGlobalProfile) void refreshAccounts(sourceControl);
  }, [open, isGlobalProfile, refreshAccounts, sourceControl]);

  // Every connected account, whichever provider or instance it belongs to: an
  // identity picks one, and the transport picks up its credential from there.
  const accountOptions = React.useMemo(() => identities.flatMap((identity) => {
    const entry = authEntries[getSourceControlAuthKey(identity)];
    if (!entry?.hasChecked || entry.status?.status !== 'connected') return [];
    return buildManagedAccountOptions(identity, entry.status.accounts, (account) => t(getManagedCredentialSourceLabelKey(account.source)));
  }), [authEntries, identities, t]);
  const selectedAccount = accountOptions.find((option) => option.key === accountKey) ?? null;
  const transport = transportOf(method);
  // An identity loaded as "the account's credential" shows the chip its account
  // actually is, once the connected accounts have arrived.
  React.useEffect(() => {
    if (transport !== 'account' || !selectedAccount) return;
    if (selectedAccount.source === 'pat' && method !== 'token') setMethod('token');
    if (selectedAccount.source === 'oauth' && method !== 'oauth') setMethod('oauth');
  }, [method, selectedAccount, transport]);
  const offeredAccounts = accountOptions.filter((option) => {
    const source = sourceOf(method);
    return source === null || option.source === source;
  });

  React.useEffect(() => {
    if (!open) return;
    if (isNewProfile) {
      setName('');
      setUserName('');
      setUserEmail('');
      setSignCommits(false);
      setSigningKey('');
      setColor('keyword');
      setIcon('branch');
      setAccountKey(NO_ACCOUNT);
      setMethod('oauth');
      setSshCredentialId('');
    } else if (selectedProfile) {
      setName(selectedProfile.name);
      setUserName(selectedProfile.userName);
      setUserEmail(selectedProfile.userEmail);
      setSignCommits(selectedProfile.signCommits === true);
      setSigningKey(selectedProfile.signingKey || '');
      setColor(selectedProfile.color || 'keyword');
      setIcon(selectedProfile.icon || 'branch');
      setAccountKey(selectedProfile.account
        ? JSON.stringify([selectedProfile.account.provider, selectedProfile.account.instance, selectedProfile.account.accountId])
        : NO_ACCOUNT);
      // OAuth or Token is read off the account once the accounts are known.
      setMethod(selectedProfile.transport === 'ssh' ? 'ssh' : selectedProfile.transport === 'anonymous' ? 'anonymous' : 'oauth');
      setSshCredentialId(selectedProfile.sshCredentialId ?? '');
    } else if (isGlobalProfile) {
      const global = getProfileById('global');
      if (global) {
        setName(global.name);
        setUserName(global.userName);
        setUserEmail(global.userEmail);
        setSignCommits(false);
        setSigningKey('');
        setColor(global.color || 'keyword');
        setIcon(global.icon || 'branch');
      }
    }
  }, [open, profileId, selectedProfile, isNewProfile, isGlobalProfile, getProfileById]);

  const handleSave = async () => {
    if (!userName.trim() || !userEmail.trim()) {
      toast.error(t('settings.gitIdentities.editor.toast.userNameEmailRequired'));
      return;
    }
    if (signCommits && !signingKey.trim()) {
      toast.error(t('settings.gitIdentities.editor.toast.signingKeyRequired'));
      return;
    }
    // An identity without an account is not one, whichever way it authenticates.
    if (!selectedAccount) {
      toast.error(t('settings.gitIdentities.editor.toast.accountRequired'));
      return;
    }
    if (transport === 'ssh' && !sshCredentialId.trim()) {
      toast.error(t('settings.gitIdentities.editor.toast.sshKeyRequired'));
      return;
    }

    setIsSaving(true);
    try {
      // The server owns any private migration fields; editors send only the public author DTO.
      const profileData: Omit<GitIdentityProfile, 'id'> & { id?: string } = {
        name: name.trim() || userName.trim(),
        userName: userName.trim(),
        userEmail: userEmail.trim(),
        account: selectedAccount?.reference ?? null,
        transport,
        signCommits,
        signingKey: signingKey.trim() || null,
        color,
        icon,
      };
      // Only an SSH transport names a managed key, so the field is absent
      // rather than empty when another transport is chosen.
      if (transport === 'ssh') profileData.sshCredentialId = sshCredentialId.trim();

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

  const title = isNewProfile
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
                  <label className={`${SETTINGS_FIELD_LABEL_CLASS} block mb-1.5`}>{t('settings.gitIdentities.editor.field.profileName')}</label>
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
                  <label className={SETTINGS_FIELD_LABEL_CLASS}>{t('settings.gitIdentities.editor.field.userName')}</label>
                  {!isGlobalProfile && <span className="text-[var(--status-error)] text-xs">*</span>}
                  <SettingsInfoHint contentClassName="max-w-xs">
                    {t('settings.gitIdentities.editor.field.userNameTooltip')}
                  </SettingsInfoHint>
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
                  <label className={SETTINGS_FIELD_LABEL_CLASS}>{t('settings.gitIdentities.editor.field.emailAddress')}</label>
                  {!isGlobalProfile && <span className="text-[var(--status-error)] text-xs">*</span>}
                  <SettingsInfoHint contentClassName="max-w-xs">
                    {t('settings.gitIdentities.editor.field.emailAddressTooltip')}
                  </SettingsInfoHint>
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

            {/* An identity is an account, a transport and a signature: the
                three answers a repository needs, given once and named. */}
            {!isGlobalProfile && (
              <>
                <div className="border-t border-border/40" />
                <div className="space-y-3">

                  <div>
                    <label className={`${SETTINGS_FIELD_LABEL_CLASS} block mb-1.5`}>
                      {t('settings.gitIdentities.editor.field.account')}
                    </label>
                    <Select
                      value={accountKey}
                      onValueChange={setAccountKey}
                    >
                      <SelectTrigger className="w-full" aria-label={t('settings.gitIdentities.editor.field.account')}>
                        <SelectValue>{selectedAccount?.label ?? t('settings.gitIdentities.editor.field.accountNone')}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {offeredAccounts.map((option) => (
                          <SelectItem key={option.key} value={option.key}>{option.label}</SelectItem>
                        ))}
                        <SelectItem value={NO_ACCOUNT}>{t('settings.gitIdentities.editor.field.accountNone')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <label className={`${SETTINGS_FIELD_LABEL_CLASS} block mb-1.5`}>{t('settings.gitIdentities.editor.auth.label')}</label>
                    <div className="flex flex-wrap items-center gap-1">
                      {AUTH_METHODS.map((entry) => (
                        <Button key={entry.method} size="sm" type="button" variant="chip"
                          aria-pressed={method === entry.method}
                          onClick={() => {
                            setMethod(entry.method);
                            if (entry.method !== 'ssh') setSshCredentialId('');
                            // A credential of the other kind cannot stay chosen under this chip.
                            const source = sourceOf(entry.method);
                            if (source && selectedAccount && selectedAccount.source !== source) setAccountKey(NO_ACCOUNT);
                          }}
                        >
                          <Icon name={entry.icon} className="w-3.5 h-3.5 mr-1" /> {t(entry.labelKey)}
                        </Button>
                      ))}
                    </div>
                  </div>

                  {transport === 'ssh' ? (
                    <ManagedSshCredentials selection={{ value: sshCredentialId, onChange: setSshCredentialId }} />
                  ) : (
                    <p className={SETTINGS_HELPER_CLASS}>{t(AUTH_METHODS.find((entry) => entry.method === method)?.hintKey ?? 'settings.gitIdentities.editor.auth.oauthHint')}</p>
                  )}
                </div>
              </>
            )}

            {/* Commit signing is independent of transport authentication. */}
            {!isGlobalProfile && (
              <>
                <div className="border-t border-border/40" />
                <div className="space-y-3">
                  <SettingsCheckboxRow
                    checked={signCommits}
                    onChange={setSignCommits}
                    label={t('settings.gitIdentities.editor.field.signCommits')}
                    info={t('settings.gitIdentities.editor.section.commitSigning')}
                    ariaLabel={t('settings.gitIdentities.editor.field.signCommits')}
                  />

                  <div>
                    <div className="flex items-center gap-1.5 mb-1.5">
                      <label className={SETTINGS_FIELD_LABEL_CLASS}>
                        {t('settings.gitIdentities.editor.field.signingKey')}
                      </label>
                    </div>
                    <Input
                      value={signingKey}
                      onChange={(e) => setSigningKey(e.target.value)}
                      placeholder={t('settings.gitIdentities.editor.field.signingKeyPlaceholder')}
                      disabled={!signCommits}
                      className="h-8 font-mono text-xs"
                    />
                  </div>
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
            <Button size="sm" variant="ghost" onClick={() => setIsDeleteDialogOpen(false)} disabled={isDeleting}>
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
