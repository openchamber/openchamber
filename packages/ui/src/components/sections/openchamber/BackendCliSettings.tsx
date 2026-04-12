import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { RiFolderLine, RiInformationLine } from '@remixicon/react';
import { isDesktopShell, isTauriShell } from '@/lib/desktop';
import { updateDesktopSettings } from '@/lib/persistence';
import { reloadOpenCodeConfiguration } from '@/stores/useAgentsStore';
import { useBackendsStore, type BackendDescriptor } from '@/stores/useBackendsStore';
import { BackendIcon } from '@/components/ui/BackendIcon';

const BinaryPathEditor: React.FC<{
  settingsKey: string;
  envVar: string;
  placeholder: string;
  dialogTitle: string;
}> = ({ settingsKey, envVar, placeholder, dialogTitle }) => {
  const [value, setValue] = React.useState('');
  const [isLoading, setIsLoading] = React.useState(true);
  const [isSaving, setIsSaving] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch('/api/config/settings', {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) return;
        const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
        if (cancelled || !data) return;
        const next = typeof data[settingsKey] === 'string' ? (data[settingsKey] as string).trim() : '';
        setValue(next);
      } catch {
        // ignore
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [settingsKey]);

  const handleBrowse = React.useCallback(async () => {
    if (typeof window === 'undefined' || !isDesktopShell() || !isTauriShell()) return;
    const tauri = (window as unknown as { __TAURI__?: { dialog?: { open?: (opts: Record<string, unknown>) => Promise<unknown> } } }).__TAURI__;
    if (!tauri?.dialog?.open) return;
    try {
      const selected = await tauri.dialog.open({ title: dialogTitle, multiple: false, directory: false });
      if (typeof selected === 'string' && selected.trim().length > 0) {
        setValue(selected.trim());
      }
    } catch {
      // ignore
    }
  }, [dialogTitle]);

  const handleSaveAndReload = React.useCallback(async () => {
    setIsSaving(true);
    try {
      await updateDesktopSettings({ [settingsKey]: value.trim() });
      await reloadOpenCodeConfiguration({ message: 'Restarting backend\u2026', mode: 'projects', scopes: ['all'] });
    } finally {
      setIsSaving(false);
    }
  }, [settingsKey, value]);

  return (
    <div className="space-y-0.5">
      <div className="flex flex-col gap-2 py-1.5 sm:flex-row sm:items-center sm:gap-3">
        <div className="flex min-w-0 flex-col shrink-0">
          <span className="typography-ui-label text-foreground">CLI Binary Path</span>
        </div>
        <div className="flex min-w-0 items-center gap-2 sm:w-[20rem]">
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={placeholder}
            disabled={isLoading || isSaving}
            className="h-7 min-w-0 flex-1 font-mono text-xs"
          />
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={handleBrowse}
            disabled={isLoading || isSaving || !isDesktopShell() || !isTauriShell()}
            className="h-7 w-7 p-0"
            aria-label="Browse for binary path"
            title="Browse"
          >
            <RiFolderLine className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <div className="py-1">
        <div className="typography-micro text-muted-foreground/70">
          Tip: you can also use <span className="font-mono">{envVar}</span> env var, but this setting persists in <span className="font-mono">~/.config/openchamber/settings.json</span>.
        </div>
      </div>
      <div className="flex justify-start py-1.5">
        <Button
          type="button"
          size="xs"
          onClick={handleSaveAndReload}
          disabled={isLoading || isSaving}
          className="shrink-0 !font-normal"
        >
          {isSaving ? 'Saving\u2026' : 'Save + Reload'}
        </Button>
      </div>
    </div>
  );
};

const BackendCliEntry: React.FC<{ backend: BackendDescriptor }> = ({ backend }) => {
  const isComingSoon = backend.comingSoon || !backend.available;

  return (
    <div className="py-2">
      <div className="flex items-center gap-2 mb-1.5">
        <BackendIcon backendId={backend.id} className="h-4 w-4 text-foreground/70" />
        <span className="typography-ui-label font-medium text-foreground">{backend.label}</span>
        {isComingSoon && (
          <span className="typography-micro px-1.5 py-0.5 rounded bg-muted/40 text-muted-foreground/60 leading-none">
            coming soon
          </span>
        )}
      </div>

      {isComingSoon ? (
        <div className="typography-micro text-muted-foreground/50 pl-6">
          CLI configuration will be available when {backend.label} support is added.
        </div>
      ) : backend.id === 'opencode' ? (
        <div className="pl-6">
          <BinaryPathEditor
            settingsKey="opencodeBinary"
            envVar="OPENCODE_BINARY"
            placeholder="/Users/you/.bun/bin/opencode"
            dialogTitle="Select OpenCode binary"
          />
        </div>
      ) : backend.id === 'codex' ? (
        <div className="pl-6">
          <BinaryPathEditor
            settingsKey="codexBinary"
            envVar="CODEX_BINARY"
            placeholder="/Users/you/.local/bin/codex"
            dialogTitle="Select Codex binary"
          />
        </div>
      ) : (
        <div className="typography-micro text-muted-foreground/70 pl-6">
          No additional CLI configuration is needed for {backend.label}.
        </div>
      )}
    </div>
  );
};

export const BackendCliSettings: React.FC = () => {
  const backends = useBackendsStore((state) => state.backends);
  const isLoaded = useBackendsStore((state) => state.isLoaded);

  if (!isLoaded || backends.length === 0) return null;

  return (
    <div className="mb-8">
      <div className="mb-1 px-1">
        <div className="flex items-center gap-2">
          <h3 className="typography-ui-header font-medium text-foreground">
            Backend CLI
          </h3>
          <Tooltip delayDuration={1000}>
            <TooltipTrigger asChild>
              <RiInformationLine className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
            </TooltipTrigger>
            <TooltipContent sideOffset={8} className="max-w-xs">
              Configure the CLI binary path for each backend.
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      <section className="px-2 pb-2 pt-0 divide-y divide-border/30">
        {backends.map((backend) => (
          <BackendCliEntry key={backend.id} backend={backend} />
        ))}
      </section>
    </div>
  );
};
