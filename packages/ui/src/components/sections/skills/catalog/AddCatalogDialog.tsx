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
import { ButtonLarge } from '@/components/ui/button-large';
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

const generateCatalogId = () => `custom:${Date.now()}-${Math.random().toString(16).slice(2)}`;

const guessLabelFromSource = (value: string) => {
  const trimmed = value.trim();
  const ssh = trimmed.match(/^git@github\.com:([^/\s]+)\/([^\s#]+)$/i);
  if (ssh) {
    return `${ssh[1]}/${ssh[2].replace(/\.git$/i, '')}`;
  }
  const https = trimmed.match(/^https?:\/\/github\.com\/([^/\s]+)\/([^\s#]+)$/i);
  if (https) {
    return `${https[1]}/${https[2].replace(/\.git$/i, '')}`;
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
  const { scanRepo, loadCatalog, isScanning } = useSkillsCatalogStore();
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

  React.useEffect(() => {
    if (!open) return;

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
      toast.error('Repository source is required');
      return;
    }

    if (!label.trim()) {
      setLabel(guessLabelFromSource(trimmedSource));
    }

    setScanOk(false);
    setScanCount(null);

    const result = await scanRepo({
      source: trimmedSource,
      subpath: subpath.trim() || undefined,
      gitIdentityId: gitIdentityId || undefined,
    });

    if (!result.ok) {
      if (result.error?.kind === 'authRequired') {
        if (isVSCodeRuntime()) {
          toast.error('Private repositories are not supported in VS Code yet');
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
        toast.error('Authentication required. Select a Git identity and scan again.');
        return;
      }

      toast.error(result.error?.message || 'Failed to scan repository');
      return;
    }

    const count = result.items?.length || 0;
    setScanCount(count);
    if (count === 0) {
      toast.error('No skills found in this repository');
      setScanOk(false);
      return;
    }

    setIdentityOptions([]);
    setScanOk(true);
    toast.success(`Found ${count} skill(s)`);
  };

  const handleAdd = async () => {
    const trimmedLabel = label.trim();
    const trimmedSource = source.trim();
    const trimmedSubpath = subpath.trim();

    if (!trimmedLabel) {
      toast.error('Catalog name is required');
      return;
    }

    if (!trimmedSource) {
      toast.error('Repository source is required');
      return;
    }

    if (!scanOk) {
      toast.error('Scan the repository before adding this catalog');
      return;
    }

    if (isDuplicate) {
      toast.error('This catalog already exists');
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
      toast.success('Catalog added');
      await loadCatalog({ refresh: true });
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save catalog');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl" keyboardAvoid>
        <DialogHeader>
          <DialogTitle>Add skills catalog</DialogTitle>
          <DialogDescription>
            Add a Git repository as a new catalog source. OpenChamber will scan it for folders containing <code className="font-mono">SKILL.md</code>.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <label className="typography-ui-label text-foreground">Catalog name</label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Team Skills" />
          </div>

          <div className="space-y-2">
            <label className="typography-ui-label text-foreground">Repository</label>
            <Input
              value={source}
              onChange={(e) => {
                setSource(e.target.value);
                setScanOk(false);
                setScanCount(null);
              }}
              placeholder="owner/repo or git@github.com:owner/repo.git"
            />
            <p className="typography-micro text-muted-foreground">
              Public repos work everywhere. Private repos require SSH identity (Desktop/Web only).
            </p>
          </div>

          <div className="space-y-2">
            <label className="typography-ui-label text-foreground">Optional subpath</label>
            <Input
              value={subpath}
              onChange={(e) => {
                setSubpath(e.target.value);
                setScanOk(false);
                setScanCount(null);
              }}
              placeholder="e.g. skills"
            />
          </div>

          {identityOptions.length > 0 && !isVSCodeRuntime() ? (
            <div className="space-y-2">
              <div>
                <span className="typography-ui-label text-[var(--status-warning)]">Authentication required</span>
                <span className="typography-meta text-muted-foreground ml-2">Select a Git identity (SSH key)</span>
              </div>
              <Select value={gitIdentityId || ''} onValueChange={(v) => setGitIdentityId(v)}>
                <SelectTrigger className="w-fit">
                  <span>{identityOptions.find((i) => i.id === gitIdentityId)?.name || 'Choose identity'}</span>
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
                Configure identities in Settings - Git Identities.
              </p>
            </div>
          ) : null}

          {scanCount !== null ? (
            <div className="typography-meta text-muted-foreground">
              Scan result: {scanCount} skill(s) found
            </div>
          ) : null}

          {isDuplicate ? (
            <div className="typography-meta text-muted-foreground">
              This catalog is already added.
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <ButtonLarge variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </ButtonLarge>
          <ButtonLarge
            variant="ghost"
            onClick={() => void handleScan()}
            disabled={isScanning || !source.trim()}
            className="gap-2"
          >
            <RiGitRepositoryLine className="h-4 w-4" />
            {isScanning ? 'Scanning...' : 'Scan'}
          </ButtonLarge>
          <ButtonLarge
            onClick={() => void handleAdd()}
            disabled={!scanOk || isDuplicate || !label.trim() || !source.trim()}
          >
            Add catalog
          </ButtonLarge>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
