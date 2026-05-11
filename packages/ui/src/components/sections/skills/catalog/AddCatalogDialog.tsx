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

import { RiGitRepositoryLine } from '@remixicon/react';

import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { isVSCodeRuntime } from '@/lib/desktop';
import { updateDesktopSettings } from '@/lib/persistence';
import type { DesktopSettings, SkillCatalogConfig } from '@/lib/desktop';
import { useSkillsCatalogStore } from '@/stores/useSkillsCatalogStore';
import { useGitIdentitiesStore } from '@/stores/useGitIdentitiesStore';
import { useI18n } from '@/lib/i18n';

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

type IdentityOption = { id: string; name: string };

const loadSettings = async (): Promise<DesktopSettings | null> => {
  try {
    const runtimeSettings = getRegisteredRuntimeAPIs()?.settings;
    if (runtimeSettings) {
      const result = await runtimeSettings.load();
      return (result?.settings || {}) as DesktopSettings;
    }

    const response = await fetch('/api/config/settings', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      return null;
    }

    return (await response.json().catch(() => null)) as DesktopSettings | null;
  } catch {
    return null;
  }
};

interface AddCatalogDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const AddCatalogDialog: React.FC<AddCatalogDialogProps> = ({ open, onOpenChange }) => {
  const { t } = useI18n();
  const scanRepo = useSkillsCatalogStore((s) => s.scanRepo);
  const loadCatalog = useSkillsCatalogStore((s) => s.loadCatalog);
  const isScanning = useSkillsCatalogStore((s) => s.isScanning);
  const defaultGitIdentityId = useGitIdentitiesStore((s) => s.defaultGitIdentityId);
  const loadDefaultGitIdentityId = useGitIdentitiesStore((s) => s.loadDefaultGitIdentityId);

  const [label, setLabel] = React.useState('');
  const [source, setSource] = React.useState('');
  const [subpath, setSubpath] = React.useState('');

  const [existingCatalogs, setExistingCatalogs] = React.useState<SkillCatalogConfig[]>([]);

  const [scanCount, setScanCount] = React.useState<number | null>(null);
  const [scanOk, setScanOk] = React.useState(false);

  const [identityOptions, setIdentityOptions] = React.useState<IdentityOption[]>([]);
  const [gitIdentityId, setGitIdentityId] = React.useState<string | null>(null);
  const scanRequestIdRef = React.useRef(0);

  const invalidateScan = React.useCallback((options?: { clearIdentity?: boolean }) => {
    scanRequestIdRef.current += 1;
    setScanOk(false);
    setScanCount(null);
    if (options?.clearIdentity) {
      setIdentityOptions([]);
      setGitIdentityId(null);
    }
  }, []);

  React.useEffect(() => {
    if (!open) return;

    scanRequestIdRef.current += 1;
    setLabel('');
    setSource('');
    setSubpath('');
    setScanCount(null);
    setScanOk(false);
    setIdentityOptions([]);
    setGitIdentityId(null);
    void loadDefaultGitIdentityId();

    void (async () => {
      const settings = await loadSettings();
      const catalogs = Array.isArray(settings?.skillCatalogs) ? settings?.skillCatalogs : [];
      setExistingCatalogs(catalogs || []);
    })();
  }, [open, loadDefaultGitIdentityId]);

  const isDuplicate = React.useMemo(() => {
    const normalizedSource = source.trim();
    const normalizedSubpath = subpath.trim();

    return existingCatalogs.some((c) => {
      const s = (c.source || '').trim();
      const sp = (c.subpath || '').trim();
      return s === normalizedSource && sp === normalizedSubpath;
    });
  }, [existingCatalogs, source, subpath]);

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

        const ids = (result.error.identities || []) as IdentityOption[];
        setIdentityOptions(ids);
        if (!gitIdentityId && ids.length > 0) {
          const preferred =
            defaultGitIdentityId &&
            defaultGitIdentityId !== 'global' &&
            ids.some((i) => i.id === defaultGitIdentityId)
              ? defaultGitIdentityId
              : ids[0].id;
          setGitIdentityId(preferred);
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

    setIdentityOptions([]);
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

    if (!scanOk) {
      toast.error(t('settings.skills.catalog.add.toast.scanBeforeAdd'));
      return;
    }

    if (isDuplicate) {
      toast.error(t('settings.skills.catalog.add.toast.catalogAlreadyExists'));
      return;
    }

    const next: SkillCatalogConfig = {
      id: generateCatalogId(),
      label: trimmedLabel,
      source: trimmedSource,
      ...(trimmedSubpath ? { subpath: trimmedSubpath } : {}),
      ...(gitIdentityId ? { gitIdentityId } : {}),
    };

    const updated = [...existingCatalogs, next];

    try {
      await updateDesktopSettings({ skillCatalogs: updated });
      setExistingCatalogs(updated);
      toast.success(t('settings.skills.catalog.add.toast.catalogAdded'));
      await loadCatalog({ refresh: true });
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('settings.skills.catalog.add.toast.saveFailed'));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('settings.skills.catalog.add.title')}</DialogTitle>
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
            <label className="typography-ui-label text-foreground">{t('settings.skills.catalog.add.field.repository')}</label>
            <Input
              value={source}
              onChange={(e) => {
                setSource(e.target.value);
                invalidateScan({ clearIdentity: true });
              }}
              placeholder={t('settings.skills.catalog.shared.field.repositoryPlaceholder')}
            />
            <p className="typography-micro text-muted-foreground">
              {t('settings.skills.catalog.add.field.repositoryHint')}
            </p>
          </div>

          <div className="space-y-2">
            <label className="typography-ui-label text-foreground">{t('settings.skills.catalog.add.field.optionalSubpath')}</label>
            <Input
              value={subpath}
              onChange={(e) => {
                setSubpath(e.target.value);
                invalidateScan({ clearIdentity: true });
              }}
              placeholder={t('settings.skills.catalog.shared.field.subpathPlaceholder')}
            />
          </div>

          {identityOptions.length > 0 && !isVSCodeRuntime() ? (
            <div className="space-y-2">
              <div>
                <span className="typography-ui-label text-[var(--status-warning)]">{t('settings.skills.catalog.shared.auth.title')}</span>
                <span className="typography-meta text-muted-foreground ml-2">{t('settings.skills.catalog.shared.auth.description')}</span>
              </div>
              <Select
                value={gitIdentityId || ''}
                onValueChange={(v) => {
                  setGitIdentityId(v);
                  invalidateScan();
                }}
              >
                <SelectTrigger className="w-fit">
                  <span>{identityOptions.find((i) => i.id === gitIdentityId)?.name || t('settings.skills.catalog.shared.auth.chooseIdentity')}</span>
                </SelectTrigger>
                <SelectContent align="start">
                  {identityOptions.map((id) => (
                    <SelectItem key={id.id} value={id.id}>
                      {id.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="typography-micro text-muted-foreground">
                {t('settings.skills.catalog.shared.auth.footerHint')}
              </p>
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
            <RiGitRepositoryLine className="h-4 w-4" />
            {isScanning ? t('settings.skills.catalog.shared.actions.scanning') : t('settings.skills.catalog.shared.actions.scan')}
          </Button>
          <Button
            size="sm"
            onClick={() => void handleAdd()}
            disabled={!scanOk || isDuplicate || !label.trim() || !source.trim()}
          >
            {t('settings.skills.catalog.add.actions.addCatalog')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
