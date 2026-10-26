import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SettingsChipGroup, SETTINGS_FIELD_LABEL_CLASS, SETTINGS_HELPER_CLASS } from '@/components/sections/shared/SettingsSection';
import { Checkbox } from '@/components/ui/checkbox';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
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
import { useSourceControlDescriptorOf, useSourceControlProviders } from '@/lib/source-control/providers/registry';
import { ProviderIcon } from '@/components/sourceControl/ProviderIcon';
import type { GitIdentityTransport } from '@/lib/api/types';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';

/** Select value for an identity that answers to no connected account. */
const NO_ACCOUNT = '__none__';

/** Same key `buildManagedAccountOptions` gives the account's option. */
const accountOptionKey = (account: NonNullable<GitIdentityProfile['account']>): string =>
  JSON.stringify([account.provider, account.instance, account.accountId]);

/**
 * How an identity pushes and pulls. Only "Account" needs a connected account;
 * the others may still name one so it answers for issues and change requests.
 */
type AuthMethod = GitIdentityTransport;
const AUTH_METHODS = [
  { method: 'system', icon: 'computer', labelKey: 'settings.gitIdentities.editor.auth.system', hintKey: 'settings.gitIdentities.editor.auth.systemHint' },
  { method: 'account', icon: 'user-3', labelKey: 'settings.gitIdentities.editor.auth.account', hintKey: 'settings.gitIdentities.editor.auth.accountHint' },
  { method: 'ssh', icon: 'lock', labelKey: 'settings.gitIdentities.editor.auth.ssh', hintKey: 'settings.gitIdentities.editor.auth.sshHint' },
  { method: 'anonymous', icon: 'global', labelKey: 'settings.gitIdentities.editor.auth.anonymous', hintKey: 'settings.gitIdentities.editor.auth.anonymousHint' },
] as const satisfies ReadonlyArray<{ method: AuthMethod; icon: IconName; labelKey: string; hintKey: string }>;

const PROFILE_COLORS = [
  { key: 'keyword', labelKey: 'settings.gitIdentities.editor.color.green', cssVar: 'var(--syntax-keyword)' },
  { key: 'error', labelKey: 'settings.gitIdentities.editor.color.red', cssVar: 'var(--status-error)' },
  { key: 'string', labelKey: 'settings.gitIdentities.editor.color.cyan', cssVar: 'var(--syntax-string)' },
  { key: 'function', labelKey: 'settings.gitIdentities.editor.color.orange', cssVar: 'var(--syntax-function)' },
  { key: 'type', labelKey: 'settings.gitIdentities.editor.color.yellow', cssVar: 'var(--syntax-type)' },
] as const;

/** The built-in marks; each source-control provider adds its own after them, named by its literal label. */
const PROFILE_ICONS = [
  { key: 'branch', Icon: 'git-branch', labelKey: 'settings.gitIdentities.editor.icon.branch' },
  { key: 'briefcase', Icon: 'briefcase', labelKey: 'settings.gitIdentities.editor.icon.work' },
  { key: 'house', Icon: 'home', labelKey: 'settings.gitIdentities.editor.icon.personal' },
  { key: 'graduation', Icon: 'graduation-cap', labelKey: 'settings.gitIdentities.editor.icon.school' },
  { key: 'code', Icon: 'code', labelKey: 'settings.gitIdentities.editor.icon.code' },
] as const satisfies ReadonlyArray<{ key: string; Icon: IconName; labelKey: string }>;

/**
 * One form row: the label, with its hint, beside the control on a wide
 * dialog and above it on a narrow one. The label keeps a control's height so
 * it lines up with the first line of a control that grows below.
 */
const EditorRow: React.FC<{ label: React.ReactNode; info?: React.ReactNode; children: React.ReactNode }> = ({ label, info, children }) => (
  <div className="flex flex-col gap-1.5 @md:flex-row @md:items-start @md:gap-4">
    <div className="flex shrink-0 items-center gap-1.5 @md:h-8 @md:w-32">
      <span className={SETTINGS_FIELD_LABEL_CLASS}>{label}</span>
      {info != null ? <SettingsInfoHint contentClassName="max-w-xs">{info}</SettingsInfoHint> : null}
    </div>
    <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
  </div>
);

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
  const [method, setMethod] = React.useState<AuthMethod>('system');
  const [sshCredentialId, setSshCredentialId] = React.useState('');
  const [isSaving, setIsSaving] = React.useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = React.useState(false);
  const [isDeleting, setIsDeleting] = React.useState(false);

  const { sourceControl } = useRuntimeAPIs();
  const providers = useSourceControlProviders();
  const descriptorOf = useSourceControlDescriptorOf();
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
    return buildManagedAccountOptions(identity, descriptorOf(identity.provider), entry.status.accounts, (account) => t(getManagedCredentialSourceLabelKey(account.source)));
  }), [authEntries, descriptorOf, identities, t]);
  const selectedAccount = accountOptions.find((option) => option.key === accountKey) ?? null;
  // A stored account the account list cannot show right now (status read
  // failed, provider offline) stays the identity's account: only choosing
  // another entry or "None" changes it, never a failed read.
  const storedAccount = selectedProfile?.account && accountKey === accountOptionKey(selectedProfile.account)
    ? selectedProfile.account
    : null;
  const accountReference = selectedAccount?.reference ?? storedAccount;
  const transport = method;

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
      setMethod('system');
      setSshCredentialId('');
    } else if (selectedProfile) {
      setName(selectedProfile.name);
      setUserName(selectedProfile.userName);
      setUserEmail(selectedProfile.userEmail);
      setSignCommits(selectedProfile.signCommits === true);
      setSigningKey(selectedProfile.signingKey || '');
      setColor(selectedProfile.color || 'keyword');
      setIcon(selectedProfile.icon || 'branch');
      setAccountKey(selectedProfile.account ? accountOptionKey(selectedProfile.account) : NO_ACCOUNT);
      setMethod(selectedProfile.transport ?? 'system');
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
    if (transport === 'account' && !accountReference) {
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
        account: accountReference,
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

  const currentColorValue = PROFILE_COLORS.find((c) => c.key === color)?.cssVar ?? 'var(--syntax-keyword)';
  // An icon key that names a provider (an identity made from a connected account) draws its mark.
  const iconChoices = [
    ...PROFILE_ICONS.map((entry) => ({ key: entry.key, label: t(entry.labelKey), mark: (className: string) => <Icon name={entry.Icon} className={className} /> })),
    ...providers.map((descriptor) => ({ key: descriptor.id, label: descriptor.label, mark: (className: string) => <ProviderIcon descriptor={descriptor} className={className} /> })),
  ];
  const currentIcon = iconChoices.find((entry) => entry.key === icon) ?? iconChoices[0];
  const methodHint = t(AUTH_METHODS.find((entry) => entry.method === method)?.hintKey ?? 'settings.gitIdentities.editor.auth.systemHint');

  const title = isNewProfile
    ? t('settings.gitIdentities.editor.title.newIdentity')
    : isGlobalProfile
    ? t('settings.gitIdentities.editor.title.globalIdentity')
    : (selectedProfile?.name || t('settings.gitIdentities.editor.title.editIdentity'));

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {isGlobalProfile && (
              <DialogDescription>{t('settings.gitIdentities.editor.description.globalReadOnly')}</DialogDescription>
            )}
          </DialogHeader>

          <div className="@container flex flex-col gap-6">
            {/* The profile's own label: its icon, painted in its colour, and its name. */}
            {!isGlobalProfile && (
              <div className="flex items-center gap-2">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="shrink-0"
                      aria-label={t('settings.gitIdentities.editor.appearance.aria')}
                      title={t('settings.gitIdentities.editor.appearance.aria')}
                    >
                      <span className="inline-flex" style={{ color: currentColorValue }}>{currentIcon.mark('size-4')}</span>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-64 p-3">
                    <div className="space-y-3">
                      <div className="space-y-2">
                        <div className={SETTINGS_FIELD_LABEL_CLASS}>{t('settings.gitIdentities.editor.field.color')}</div>
                        <div className="flex items-center gap-2.5">
                          {PROFILE_COLORS.map((c) => (
                            <button
                              key={c.key}
                              type="button"
                              onClick={() => setColor(c.key)}
                              aria-pressed={color === c.key}
                              aria-label={t(c.labelKey)}
                              title={t(c.labelKey)}
                              className={cn(
                                'size-6 shrink-0 rounded-full transition-shadow',
                                color === c.key && 'ring-2 ring-foreground ring-offset-2 ring-offset-background',
                              )}
                              style={{ backgroundColor: c.cssVar }}
                            />
                          ))}
                        </div>
                      </div>
                      <div className="space-y-2">
                        <div className={SETTINGS_FIELD_LABEL_CLASS}>{t('settings.gitIdentities.editor.field.icon')}</div>
                        <div className="grid grid-cols-7 gap-1">
                          {iconChoices.map((entry) => {
                            const selected = icon === entry.key;
                            return (
                              <button
                                key={entry.key}
                                type="button"
                                onClick={() => setIcon(entry.key)}
                                aria-pressed={selected}
                                aria-label={entry.label}
                                title={entry.label}
                                className={cn(
                                  'inline-flex size-8 items-center justify-center rounded-md',
                                  selected ? 'bg-interactive-selection' : 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground',
                                )}
                              >
                                <span className="inline-flex" style={selected ? { color: currentColorValue } : undefined}>{entry.mark('size-4')}</span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  </DropdownMenuContent>
                </DropdownMenu>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t('settings.gitIdentities.editor.field.profileNamePlaceholder')}
                  aria-label={t('settings.gitIdentities.editor.field.profileName')}
                  className="min-w-0 flex-1"
                />
              </div>
            )}

            <div className="flex flex-col gap-3">
              <EditorRow label={t('settings.gitIdentities.editor.field.userName')} info={t('settings.gitIdentities.editor.field.userNameTooltip')}>
                <Input
                  value={userName}
                  onChange={(e) => setUserName(e.target.value)}
                  placeholder={t('settings.gitIdentities.editor.field.userNamePlaceholder')}
                  aria-label={t('settings.gitIdentities.editor.field.userName')}
                  required={!isGlobalProfile}
                  readOnly={isGlobalProfile}
                  disabled={isGlobalProfile}
                  className="min-w-0 flex-1"
                />
              </EditorRow>
              <EditorRow label={t('settings.gitIdentities.editor.field.emailAddress')} info={t('settings.gitIdentities.editor.field.emailAddressTooltip')}>
                <Input
                  type="email"
                  value={userEmail}
                  onChange={(e) => setUserEmail(e.target.value)}
                  placeholder={t('settings.gitIdentities.editor.field.emailAddressPlaceholder')}
                  aria-label={t('settings.gitIdentities.editor.field.emailAddress')}
                  required={!isGlobalProfile}
                  readOnly={isGlobalProfile}
                  disabled={isGlobalProfile}
                  className="min-w-0 flex-1"
                />
              </EditorRow>
              {/* Commit signing is independent of transport authentication. The key
                  field stays laid out while signing is off, so the toggle moves nothing. */}
              {!isGlobalProfile && (
                <EditorRow label={t('settings.gitIdentities.editor.section.commitSigning')}>
                  <Checkbox
                    checked={signCommits}
                    onChange={setSignCommits}
                    ariaLabel={t('settings.gitIdentities.editor.field.signCommits')}
                  />
                  <Input
                    value={signingKey}
                    onChange={(e) => setSigningKey(e.target.value)}
                    placeholder={t('settings.gitIdentities.editor.field.signingKeyPlaceholder')}
                    aria-label={t('settings.gitIdentities.editor.field.signingKey')}
                    disabled={!signCommits}
                    className="min-w-0 flex-1 font-mono text-xs"
                  />
                </EditorRow>
              )}
            </div>

            {/* An identity is an account, a transport and a signature: the
                three answers a repository needs, given once and named. */}
            {!isGlobalProfile && (
              <div className="flex flex-col gap-3">
                <EditorRow label={t('settings.gitIdentities.editor.field.account')}>
                  <Select value={accountKey} onValueChange={setAccountKey}>
                    <SelectTrigger className="min-w-0 max-w-full" aria-label={t('settings.gitIdentities.editor.field.account')}>
                      <SelectValue>{selectedAccount?.label ?? storedAccount?.instance ?? t('settings.gitIdentities.editor.field.accountNone')}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {accountOptions.map((option) => (
                        <SelectItem key={option.key} value={option.key}>{option.label}</SelectItem>
                      ))}
                      <SelectItem value={NO_ACCOUNT}>{t('settings.gitIdentities.editor.field.accountNone')}</SelectItem>
                    </SelectContent>
                  </Select>
                </EditorRow>

                <EditorRow label={t('settings.gitIdentities.editor.auth.label')} info={methodHint}>
                  <SettingsChipGroup
                    value={method}
                    aria-label={t('settings.gitIdentities.editor.auth.label')}
                    onChange={(next) => {
                      setMethod(next);
                      if (next !== 'ssh') setSshCredentialId('');
                    }}
                    options={AUTH_METHODS.map((entry) => ({
                      value: entry.method,
                      label: <><Icon name={entry.icon} className="size-3.5" />{t(entry.labelKey)}</>,
                      tooltip: t(entry.hintKey),
                    }))}
                  />
                </EditorRow>

                {/* Laid out for every method and live only for SSH, so switching
                    methods keeps the dialog's height. The picker mounts with SSH
                    because mounting reads the saved keys. */}
                <EditorRow label={t('settings.gitIdentities.editor.field.sshKey')} info={t('settings.sourceControl.ssh.hostSetup')}>
                  {transport === 'ssh' ? (
                    <ManagedSshCredentials selection={{ value: sshCredentialId, onChange: setSshCredentialId }} />
                  ) : (
                    // Same shape as the picker, its status line included, so
                    // picking SSH swaps content without adding a line.
                    <div className="flex min-w-0 flex-1 flex-col gap-2">
                      <Select value="" disabled>
                        <SelectTrigger className="min-w-0 max-w-full" aria-label={t('settings.gitIdentities.editor.field.sshKey')}>
                          <SelectValue placeholder={t('settings.sourceControl.ssh.title')} />
                        </SelectTrigger>
                        <SelectContent />
                      </Select>
                      <p aria-hidden="true" className={`${SETTINGS_HELPER_CLASS} min-h-[1lh]`} />
                    </div>
                  )}
                </EditorRow>
              </div>
            )}
          </div>

          <DialogFooter className="sm:justify-between">
            {!isGlobalProfile && !isNewProfile ? (
              <Button type="button" variant="ghost" size="sm" className="text-[var(--status-error)]" onClick={() => setIsDeleteDialogOpen(true)}>
                {t('settings.common.actions.delete')}
              </Button>
            ) : <span />}
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                {isGlobalProfile ? t('settings.gitIdentities.editor.actions.close') : t('settings.common.actions.cancel')}
              </Button>
              {!isGlobalProfile && (
                <Button type="button" size="sm" onClick={handleSave} disabled={isSaving}>
                  {isSaving ? t('settings.common.actions.saving') : isNewProfile ? t('settings.gitIdentities.editor.actions.create') : t('settings.gitIdentities.editor.actions.save')}
                </Button>
              )}
            </div>
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
