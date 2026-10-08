import React from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { formatPathForDisplay } from '@/lib/utils';
import { opencodeClient } from '@/lib/opencode/client';
import {
  excludeMissingOpenCodeProjectImportCandidates,
  getOpenCodeProjectImportDisplayName,
  getOpenCodeProjectImportCandidates,
  shouldAutoOpenOpenCodeProjectImportPrompt,
} from '@/lib/opencodeProjectImport';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useGlobalSyncStore } from '@/sync/global-sync-store';
import {
  getRuntimeKey,
  isTransientRuntimeKey,
  subscribeRuntimeEndpointChanged,
  subscribeRuntimeEndpointWillChange,
} from '@/lib/runtime-switch';

type Props = {
  mobile?: boolean;
};

const AUTO_OPEN_PROMPT_DELAY_MS = 2000;
const manuallyOpenedPromptRuntimeKeys = new Set<string>();

export const OpenCodeProjectsImport = ({ mobile = false }: Props) => {
  const { t } = useI18n();
  const { runtime, openCodeProjectImportPrompt } = useRuntimeAPIs();
  const openCodeProjects = useGlobalSyncStore((state) => state.projects);
  const hasLoadedProjects = useGlobalSyncStore((state) => state.hasLoadedProjects);
  const configuredProjects = useProjectsStore((state) => state.projects);
  const addProjects = useProjectsStore((state) => state.addProjects);
  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);
  const [open, setOpen] = React.useState(false);
  const [selectedPaths, setSelectedPaths] = React.useState<string[]>([]);
  const [isImporting, setIsImporting] = React.useState(false);
  const [activeRuntimeKey, setActiveRuntimeKey] = React.useState(getRuntimeKey);
  const [isRuntimeSwitching, setIsRuntimeSwitching] = React.useState(false);
  const promptClaimRef = React.useRef<{
    runtimeKey: string;
    promise: ReturnType<typeof openCodeProjectImportPrompt.claim>;
    hasOpenedPrompt: boolean;
  } | null>(null);
  const autoPromptTimerRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    setActiveRuntimeKey(getRuntimeKey());
    const unsubscribeWillChange = subscribeRuntimeEndpointWillChange(() => setIsRuntimeSwitching(true));
    const unsubscribeChanged = subscribeRuntimeEndpointChanged(({ runtimeKey }) => {
      setActiveRuntimeKey(runtimeKey);
      setIsRuntimeSwitching(false);
    });
    return () => {
      unsubscribeWillChange();
      unsubscribeChanged();
    };
  }, []);

  const candidates = React.useMemo(
    () => getOpenCodeProjectImportCandidates(openCodeProjects, configuredProjects, homeDirectory),
    [configuredProjects, homeDirectory, openCodeProjects],
  );
  const candidatePathsKey = candidates.map((candidate) => candidate.path).join('\0');
  const [missingPathsState, setMissingPathsState] = React.useState<{ key: string; paths: ReadonlySet<string> } | null>(null);
  React.useEffect(() => {
    if (runtime.isVSCode || !hasLoadedProjects || candidatePathsKey.length === 0) {
      setMissingPathsState(null);
      return;
    }

    let current = true;
    const key = candidatePathsKey;
    setMissingPathsState(null);
    const paths = key.split('\0');
    void Promise.all(paths.map(async (path) => ({
      path,
      availability: await opencodeClient.getDirectoryAvailability(path),
    }))).then((results) => {
      if (!current) return;
      setMissingPathsState({
        key,
        paths: new Set(results.filter((result) => result.availability === 'missing').map((result) => result.path)),
      });
    });

    return () => {
      current = false;
    };
  }, [candidatePathsKey, hasLoadedProjects, runtime.isVSCode]);
  const missingPaths = missingPathsState?.key === candidatePathsKey ? missingPathsState.paths : null;
  const importableCandidates = React.useMemo(
    () => (missingPaths ? excludeMissingOpenCodeProjectImportCandidates(candidates, missingPaths) : []),
    [candidates, missingPaths],
  );
  const isCheckingDirectories = hasLoadedProjects && candidates.length > 0 && missingPaths === null;
  const canAutoOpenPrompt = shouldAutoOpenOpenCodeProjectImportPrompt({
    runtime: runtime.isVSCode ? 'vscode' : 'supported',
    projects: hasLoadedProjects ? 'loaded' : 'loading',
    directories: isCheckingDirectories ? 'checking' : 'checked',
    importableCount: importableCandidates.length,
  });
  const autoPromptStateRef = React.useRef({ canAutoOpenPrompt, activeRuntimeKey, isRuntimeSwitching });
  autoPromptStateRef.current = { canAutoOpenPrompt, activeRuntimeKey, isRuntimeSwitching };

  React.useEffect(() => {
    if (
      !canAutoOpenPrompt
      || isRuntimeSwitching
      || isTransientRuntimeKey(activeRuntimeKey)
      || manuallyOpenedPromptRuntimeKeys.has(activeRuntimeKey)
    ) return;

    let current = true;
    const runtimeKey = activeRuntimeKey;
    const timer = window.setTimeout(() => {
      autoPromptTimerRef.current = null;
      const latestState = autoPromptStateRef.current;
      if (
        !current
        || !latestState.canAutoOpenPrompt
        || latestState.isRuntimeSwitching
        || latestState.activeRuntimeKey !== runtimeKey
        || getRuntimeKey() !== runtimeKey
        || isTransientRuntimeKey(runtimeKey)
        || manuallyOpenedPromptRuntimeKeys.has(runtimeKey)
      ) return;

      let pendingClaim = promptClaimRef.current;
      if (!pendingClaim || pendingClaim.runtimeKey !== runtimeKey) {
        pendingClaim = {
          runtimeKey,
          promise: openCodeProjectImportPrompt.claim(),
          hasOpenedPrompt: false,
        };
        promptClaimRef.current = pendingClaim;
      }

      void pendingClaim.promise.then((result) => {
        if (
          !current
          || getRuntimeKey() !== runtimeKey
          || result !== 'claimed'
          || pendingClaim.hasOpenedPrompt
          || manuallyOpenedPromptRuntimeKeys.has(runtimeKey)
        ) return;
        pendingClaim.hasOpenedPrompt = true;
        setSelectedPaths([]);
        setOpen(true);
      }).catch(() => {
        if (promptClaimRef.current === pendingClaim) promptClaimRef.current = null;
        console.error('Failed to claim the OpenCode project import prompt for this runtime.');
      });
    }, AUTO_OPEN_PROMPT_DELAY_MS);
    autoPromptTimerRef.current = timer;

    return () => {
      current = false;
      window.clearTimeout(timer);
      if (autoPromptTimerRef.current === timer) autoPromptTimerRef.current = null;
    };
  }, [activeRuntimeKey, canAutoOpenPrompt, isRuntimeSwitching, openCodeProjectImportPrompt]);
  const selectedPathSet = React.useMemo(
    () => new Set(selectedPaths.filter((path) => importableCandidates.some((candidate) => candidate.path === path))),
    [importableCandidates, selectedPaths],
  );
  const allSelected = importableCandidates.length > 0 && selectedPathSet.size === importableCandidates.length;

  const toggleSelected = React.useCallback((path: string, checked: boolean) => {
    setSelectedPaths((current) => {
      if (checked) return current.includes(path) ? current : [...current, path];
      return current.filter((entry) => entry !== path);
    });
  }, []);

  const handleImport = React.useCallback(async () => {
    const paths = importableCandidates
      .filter((candidate) => selectedPathSet.has(candidate.path))
      .map((candidate) => candidate.path);
    if (paths.length === 0) return;

    setIsImporting(true);
    try {
      await addProjects(paths);
      setOpen(false);
      setSelectedPaths([]);
    } catch {
      toast.error(t('sessions.sidebar.projectImport.addFailed'));
    } finally {
      setIsImporting(false);
    }
  }, [addProjects, importableCandidates, selectedPathSet, t]);

  if (runtime.isVSCode || !hasLoadedProjects || candidates.length === 0 || isCheckingDirectories || importableCandidates.length === 0) return null;

  const label = t('sessions.sidebar.projectImport.button');
  const trigger = (
    <Button
      type="button"
      variant={mobile ? 'chip' : 'ghost'}
      size={mobile ? 'sm' : 'xs'}
      className={mobile ? 'size-8 px-0 text-muted-foreground' : 'w-6 px-1.5 text-muted-foreground'}
      aria-label={label}
      title={mobile ? label : undefined}
      onClick={() => {
        manuallyOpenedPromptRuntimeKeys.add(activeRuntimeKey);
        if (autoPromptTimerRef.current !== null) {
          window.clearTimeout(autoPromptTimerRef.current);
          autoPromptTimerRef.current = null;
        }
        setSelectedPaths([]);
        setOpen(true);
      }}
      style={mobile ? { touchAction: 'manipulation' } : undefined}
    >
      <Icon name="download" className={mobile ? 'size-4' : 'size-3.5'} />
    </Button>
  );

  return (
    <>
      {mobile ? trigger : (
        <Tooltip>
          <TooltipTrigger asChild>{trigger}</TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={4}><p>{label}</p></TooltipContent>
        </Tooltip>
      )}
      <Dialog
        open={open}
        onOpenChange={(nextOpen, details) => {
          if (nextOpen || details.reason === 'close-press' || details.reason === 'escape-key') setOpen(nextOpen);
        }}
        disablePointerDismissal
      >
        <DialogContent className="max-w-xl">
          <DialogHeader className="text-left">
            <DialogTitle>{t('sessions.sidebar.projectImport.title')}</DialogTitle>
            <DialogDescription>{t('sessions.sidebar.projectImport.description')}</DialogDescription>
          </DialogHeader>
          <div className="flex min-h-0 flex-col gap-2">
            <div className="flex justify-end">
              <Button
                type="button"
                variant="link"
                size="xs"
                onClick={() => setSelectedPaths(allSelected ? [] : importableCandidates.map((candidate) => candidate.path))}
              >
                {allSelected
                  ? t('sessions.sidebar.projectImport.clearSelection')
                  : t('sessions.sidebar.projectImport.selectAll')}
              </Button>
            </div>
            <div className="max-h-[min(60vh,30rem)] divide-y divide-border overflow-y-auto rounded-lg border border-border">
              {importableCandidates.map((candidate) => {
                const name = getOpenCodeProjectImportDisplayName(candidate.path, homeDirectory);
                const displayPath = formatPathForDisplay(candidate.path, homeDirectory);
                const checked = selectedPathSet.has(candidate.path);
                return (
                  <div
                    key={candidate.path}
                    className="flex cursor-pointer items-start gap-3 px-3 py-2.5 transition-colors hover:bg-interactive-hover/50"
                    onClick={() => toggleSelected(candidate.path, !checked)}
                  >
                    <div
                      className="flex min-h-5 min-w-5 items-center justify-center"
                      onClick={(event) => {
                        if (event.target instanceof Element && event.target.closest('[role="checkbox"]')) {
                          event.stopPropagation();
                        }
                      }}
                    >
                      <Checkbox
                        checked={checked}
                        onChange={(nextChecked) => toggleSelected(candidate.path, nextChecked)}
                        ariaLabel={t('sessions.sidebar.projectImport.selectProject', { project: name })}
                        className="mt-0.5"
                      />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate typography-ui-label text-foreground">{name}</div>
                      <div className="truncate typography-micro text-muted-foreground" title={candidate.path}>{displayPath}</div>
                      {candidate.sandboxes.length > 0 ? (
                        <div className="mt-2">
                          <div className="typography-micro text-muted-foreground">
                            {t('sessions.sidebar.projectImport.additionalDirectories')}
                          </div>
                          <ul className="mt-0.5 space-y-0.5">
                            {candidate.sandboxes.map((sandbox) => (
                              <li key={sandbox} className="truncate typography-micro text-muted-foreground" title={sandbox}>
                                {formatPathForDisplay(sandbox, homeDirectory)}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={isImporting}>
              {t('sessions.sidebar.dialogs.cancel')}
            </Button>
            <Button type="button" onClick={() => void handleImport()} disabled={selectedPathSet.size === 0 || isImporting}>
              {isImporting ? <Icon name="loader-4" className="size-4 animate-spin" /> : null}
              {t('sessions.sidebar.projectImport.addSelected')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
