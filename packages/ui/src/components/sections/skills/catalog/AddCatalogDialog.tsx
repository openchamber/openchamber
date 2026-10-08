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
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select';
import { Icon } from "@/components/icon/Icon";
import { SettingsInfoHint } from '@/components/sections/shared/SettingsInfoHint';

import { isVSCodeRuntime } from '@/lib/desktop';
import { loadDesktopSettings, updateDesktopSettings } from '@/lib/persistence';
import type { SkillCatalogConfig } from '@/lib/desktop';
import { useSkillsCatalogStore } from '@/stores/useSkillsCatalogStore';
import { useGitIdentitiesStore } from '@/stores/useGitIdentitiesStore';
import { useI18n } from '@/lib/i18n';
import { identityTransport, type GitIdentityProfile } from '@/lib/api/git-identity';
import { GLOBAL_IDENTITY_ID } from '@/lib/source-control/identity';

const generateCatalogId = () => `custom:${Date.now()}-${Math.random().toString(16).slice(2)}`;

const guessLabelFromSource = (value: string) => {
  const trimmed = value.trim();
  const urlFormat = trimmed.startsWith("https://")
    ? "https"
    : trimmed.startsWith("git@")
      ? "ssh"
      : "shorthand";

  if (urlFormat === 'ssh') {
    return `${trimmed.split(":")[1].replace(/\.git$/i, '')}`;
  }
  if (urlFormat === 'https') {
    return trimmed.split('/').slice(3).filter(Boolean).join('/').replace(/\.git$/i, '');
  }
  const shorthand = trimmed.match(/^([^/\s]+)\/([^/\s]+)(?:\/.+)?$/);
  if (shorthand) {
    return `${shorthand[1]}/${shorthand[2].replace(/\.git$/i, '')}`;
  }
  return trimmed;
};

// Only identities that bring their own credential change how a catalog is
// cloned; every other one clones exactly like the default Git setup.
const signsInOnItsOwn = (profile: GitIdentityProfile): boolean => (
  (profile.transport === 'account' && Boolean(profile.account))
  || (profile.transport === 'ssh' && Boolean(profile.sshCredentialId))
);

interface AddCatalogDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  catalogId?: string | null;
}

export const AddCatalogDialog: React.FC<AddCatalogDialogProps> = ({ open, onOpenChange, catalogId = null }) => {
  const { t } = useI18n();
  const scanRepo = useSkillsCatalogStore((s) => s.scanRepo);
  const loadCatalog = useSkillsCatalogStore((s) => s.loadCatalog);
  const loadSource = useSkillsCatalogStore((s) => s.loadSource);
  const setSelectedSource = useSkillsCatalogStore((s) => s.setSelectedSource);
  const isScanning = useSkillsCatalogStore((s) => s.isScanning);
  const gitIdentityProfiles = useGitIdentitiesStore((s) => s.profiles);
  const loadGitIdentityProfiles = useGitIdentitiesStore((s) => s.loadProfiles);

  const [label, setLabel] = React.useState('');
  const [source, setSource] = React.useState('');
  const [subpath, setSubpath] = React.useState('');

  // `null` until the current list is known: a failed load must never be
  // treated as "no catalogs", or adding one would overwrite the others.
  const [existingCatalogs, setExistingCatalogs] = React.useState<SkillCatalogConfig[] | null>(null);

  const [scanCount, setScanCount] = React.useState<number | null>(null);
  const [scanOk, setScanOk] = React.useState(false);

  const [gitIdentityId, setGitIdentityId] = React.useState<string | null>(null);
  const scanRequestIdRef = React.useRef(0);
  const identityLoadRequestIdRef = React.useRef(0);

  const invalidateScan = React.useCallback(() => {
    scanRequestIdRef.current += 1;
    setScanOk(false);
    setScanCount(null);
  }, []);

  React.useEffect(() => {
    if (!open) return;

    const identityLoadRequestId = ++identityLoadRequestIdRef.current;
    scanRequestIdRef.current += 1;
    setLabel('');
    setSource('');
    setSubpath('');
    setScanCount(null);
    setScanOk(false);
    setGitIdentityId(null);
    void loadGitIdentityProfiles();

    setExistingCatalogs(null);
    void (async () => {
      const settings = await loadDesktopSettings();
      if (identityLoadRequestIdRef.current !== identityLoadRequestId) return;
      const catalogs = settings ? settings.skillCatalogs ?? [] : null;
      setExistingCatalogs(catalogs);
      if (!catalogs || !catalogId) return;

      const catalog = catalogs.find((entry) => entry.id === catalogId);
      if (!catalog) return;
      setLabel(catalog.label);
      setSource(catalog.source);
      setSubpath(catalog.subpath ?? '');
      setGitIdentityId(catalog.gitIdentityId ?? null);
      setScanOk(false);
    })();
    return () => {
      identityLoadRequestIdRef.current += 1;
      scanRequestIdRef.current += 1;
    };
  }, [open, catalogId, loadGitIdentityProfiles]);

  const availableIdentities = React.useMemo(
    () => gitIdentityProfiles.filter(signsInOnItsOwn),
    [gitIdentityProfiles],
  );
  // A catalog saved with the System identity or a System-transport identity
  // is cloned by the default Git setup, so the picker shows it as that.
  const selectedIdentityValue = !gitIdentityId
    || gitIdentityId === GLOBAL_IDENTITY_ID
    || gitIdentityProfiles.some((profile) => profile.id === gitIdentityId && identityTransport(profile) === 'system')
    ? 'none'
    : gitIdentityId;
  const selectedIdentity = gitIdentityProfiles.find((identity) => identity.id === selectedIdentityValue);

  const isDuplicate = React.useMemo(() => {
    const normalizedSource = source.trim();
    const normalizedSubpath = subpath.trim();

    return (existingCatalogs ?? []).some((c) => {
      if (c.id === catalogId) return false;
      const s = (c.source || '').trim();
      const sp = (c.subpath || '').trim();
      return s === normalizedSource && sp === normalizedSubpath;
    });
  }, [catalogId, existingCatalogs, source, subpath]);

  const handleScan = async () => {
    const trimmedSource = source.trim();
    if (!trimmedSource) {
      toast.error(t('settings.skills.catalog.add.toast.repositoryRequired'));
      return;
    }

    if (!label.trim()) {
      setLabel(guessLabelFromSource(trimmedSource));
    }

    setScanOk(false);
    setScanCount(null);
    const requestId = scanRequestIdRef.current + 1;
    scanRequestIdRef.current = requestId;

    const result = await scanRepo({
      source: trimmedSource,
      subpath: subpath.trim() || undefined,
      gitIdentityId: gitIdentityId || undefined,
    });

    if (scanRequestIdRef.current !== requestId) {
      return;
    }

    if (!result.ok) {
      if (result.error?.kind === 'authRequired') {
        if (isVSCodeRuntime()) {
          toast.error(t('settings.skills.catalog.shared.toast.privateRepoNotSupportedVsCode'));
          return;
        }

        toast.error(t('settings.skills.catalog.add.toast.authenticationRequiredScan'));
        return;
      }

      toast.error(result.error?.message || t('settings.skills.catalog.add.toast.scanFailed'));
      return;
    }

    const count = result.items?.length || 0;
    setScanCount(count);
    if (count === 0) {
      toast.error(t('settings.skills.catalog.add.toast.noSkillsFound'));
      setScanOk(false);
      return;
    }

    setScanOk(true);
    toast.success(t('settings.skills.catalog.shared.toast.foundSkills', { count }));
  };

  const handleAdd = async () => {
    const trimmedLabel = label.trim();
    const trimmedSource = source.trim();
    const trimmedSubpath = subpath.trim();

    if (!trimmedLabel) {
      toast.error(t('settings.skills.catalog.add.toast.catalogNameRequired'));
      return;
    }

    if (!trimmedSource) {
      toast.error(t('settings.skills.catalog.add.toast.repositoryRequired'));
      return;
    }

    const original = existingCatalogs?.find((catalog) => catalog.id === catalogId);
    const sourceChanged = !catalogId || !original || original.source !== trimmedSource
      || (original.subpath ?? '') !== trimmedSubpath || (original.gitIdentityId ?? null) !== gitIdentityId;
    if (sourceChanged && !scanOk) {
      toast.error(t('settings.skills.catalog.add.toast.scanBeforeAdd'));
      return;
    }

    if (isDuplicate) {
      toast.error(t('settings.skills.catalog.add.toast.catalogAlreadyExists'));
      return;
    }

    const next: SkillCatalogConfig = {
      id: catalogId ?? generateCatalogId(),
      label: trimmedLabel,
      source: trimmedSource,
    };
    if (trimmedSubpath) next.subpath = trimmedSubpath;
    if (gitIdentityId) next.gitIdentityId = gitIdentityId;

    if (existingCatalogs === null) {
      toast.error(t('settings.skills.catalog.add.toast.saveFailed'));
      return;
    }
    if (catalogId && !original) {
      toast.error(t('settings.skills.catalog.add.toast.saveFailed'));
      return;
    }
    const updated = catalogId
      ? existingCatalogs.map((catalog) => catalog.id === catalogId ? next : catalog)
      : [...existingCatalogs, next];

    try {
      const saved = await updateDesktopSettings({ skillCatalogs: updated });
      if (!saved.ok) {
        throw new Error(t('settings.skills.catalog.add.toast.saveFailed'));
      }
      setExistingCatalogs(updated);
      if (await loadCatalog({ refresh: true })) await loadSource(next.id, { refresh: true });
      setSelectedSource(next.id);
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('settings.skills.catalog.add.toast.saveFailed'));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{catalogId ? t('settings.skills.catalog.edit.title') : t('settings.skills.catalog.add.title')}</DialogTitle>
          <DialogDescription>
            {t('settings.skills.catalog.add.descriptionPrefix')}
            {' '}
            <code className="font-mono">SKILL.md</code>
            {t('settings.skills.catalog.add.descriptionSuffix')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <label className="typography-ui-label text-foreground">{t('settings.skills.catalog.add.field.catalogName')}</label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t('settings.skills.catalog.add.field.catalogNamePlaceholder')} />
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-1">
              <label className="typography-ui-label text-foreground">{t('settings.skills.catalog.add.field.repository')}</label>
              <SettingsInfoHint>{t('settings.skills.catalog.add.field.repositoryHint')}</SettingsInfoHint>
            </div>
            <Input
              value={source}
              onChange={(e) => {
                setSource(e.target.value);
                invalidateScan();
              }}
              placeholder={t('settings.skills.catalog.shared.field.repositoryPlaceholder')}
            />
          </div>

          <div className="space-y-2">
            <label className="typography-ui-label text-foreground">{t('settings.skills.catalog.add.field.optionalSubpath')}</label>
            <Input
              value={subpath}
              onChange={(e) => {
                setSubpath(e.target.value);
                invalidateScan();
              }}
              placeholder={t('settings.skills.catalog.shared.field.subpathPlaceholder')}
            />
          </div>

          {(availableIdentities.length > 0 || selectedIdentityValue !== 'none') && !isVSCodeRuntime() ? (
            <div className="space-y-2">
              <div className="flex items-center gap-1">
                <span className="typography-ui-label text-foreground">{t('settings.skills.catalog.shared.auth.description')}</span>
                <SettingsInfoHint>{t('settings.skills.catalog.shared.auth.footerHint')}</SettingsInfoHint>
              </div>
              <Select
                value={selectedIdentityValue}
                onValueChange={(v) => {
                  setGitIdentityId(v === 'none' ? null : v);
                  invalidateScan();
                }}
              >
                <SelectTrigger className="w-fit" aria-label={t('settings.skills.catalog.shared.auth.description')}>
                  <span>
                    {selectedIdentityValue === 'none'
                      ? t('settings.skills.catalog.shared.auth.default')
                      : selectedIdentity?.name ?? selectedIdentityValue}
                  </span>
                </SelectTrigger>
                <SelectContent align="start" className="max-w-80" portalToBody>
                  <SelectItem value="none">
                    <Icon name="terminal-box" className="size-4" />
                    <span className="flex min-w-0 flex-col">
                      <span className="typography-ui-label text-foreground">{t('settings.skills.catalog.shared.auth.default')}</span>
                      <span className="typography-meta text-muted-foreground whitespace-normal">{t('settings.skills.catalog.shared.auth.defaultHint')}</span>
                    </span>
                  </SelectItem>
                  {selectedIdentityValue !== 'none' && !availableIdentities.some((identity) => identity.id === selectedIdentityValue) && (
                    <SelectItem value={selectedIdentityValue} disabled>{selectedIdentity?.name ?? selectedIdentityValue}</SelectItem>
                  )}
                  {availableIdentities.map((identity) => (
                    <SelectItem key={identity.id} value={identity.id}>
                      <Icon name={identity.transport === 'ssh' ? 'key' : identity.account?.provider === 'gitlab' ? 'gitlab' : 'github'} className="size-4" />
                      <span className="flex min-w-0 flex-col">
                        <span className="typography-ui-label text-foreground">{identity.name}</span>
                        <span className="typography-meta text-muted-foreground">
                          {identity.transport === 'ssh'
                            ? t('settings.skills.catalog.shared.auth.sshHint')
                            : t('settings.skills.catalog.shared.auth.accountHint')}
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          {scanCount !== null ? (
            <div className="typography-meta text-muted-foreground">
              {t('settings.skills.catalog.add.scanResult', { count: scanCount })}
            </div>
          ) : null}

          {isDuplicate ? (
            <div className="typography-meta text-muted-foreground">
              {t('settings.skills.catalog.add.duplicateMessage')}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
            {t('settings.common.actions.cancel')}
          </Button>
          <Button
            size="sm"
            className="gap-2"
            variant="ghost"
            onClick={() => void handleScan()}
            disabled={isScanning || !source.trim()}
          >
            <Icon name="git-repository" className="h-4 w-4" />
            {isScanning ? t('settings.skills.catalog.shared.actions.scanning') : t('settings.skills.catalog.shared.actions.scan')}
          </Button>
          <Button
            size="sm"
            onClick={() => void handleAdd()}
            disabled={isDuplicate || existingCatalogs === null || !label.trim() || !source.trim() || (
              (!catalogId || !existingCatalogs.some((catalog) => catalog.id === catalogId
                && catalog.source === source.trim()
                && (catalog.subpath ?? '') === subpath.trim()
                && (catalog.gitIdentityId ?? null) === gitIdentityId)) && !scanOk
            )}
          >
            {catalogId ? t('settings.skills.catalog.edit.actions.save') : t('settings.skills.catalog.add.actions.addCatalog')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
