
import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { SettingsInfoHint } from '@/components/sections/shared/SettingsInfoHint';
import { SettingsRadioGroup, SettingsRadioOption } from '@/components/sections/shared/SettingsSection';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { getGitStatus } from '@/lib/gitApi';
import { generateBranchSlug } from '@/lib/git/branchNameGenerator';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { SPACE_LOGIN_ONLY_PROVIDERS } from '@/lib/spaces/model-access';
import { opencodeClient } from '@/lib/opencode/client';
import { registryDomainsOf } from '@/lib/spaces/registry-domains';
import { isDomainName } from '@/lib/spaces/space-access';
import { listSpacePlaces, type SpaceFailure, type SpacePlace, type SpaceStart } from '@/lib/spaces/spaces-api';
import { startSpaceCreation, type SpaceModelAccess } from '@/lib/spaces/space-creation';
import { composerModelForSpaceAccess } from '@/lib/spaces/space-model-offer';
import { resolveSpaceSetupPlan } from '@/lib/spaces/space-setup';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { failureOfError, spaceFailureText } from './spaceFailureText';
import { DockerSetupNotice } from './DockerSetupNotice';
import { ModelKeySource } from './ModelKeySource';
import { defaultKeySource, isAccessChoiceComplete, modelGrantOf, usableHostLoginOf, useSpaceHostLogins, useSpaceModelProviders, type KeySourceChoice } from './spaceModelKeys';

type PlacesState = { kind: 'checking' } | { kind: 'ready'; places: SpacePlace[] } | { kind: 'failed'; failure: SpaceFailure };
type ChangesState = { kind: 'loading' } | { kind: 'ready'; files: string[] } | { kind: 'unknown' };
type AccessChoice = KeySourceChoice & { selected: boolean; sourceChosen: boolean };

type NewSpaceDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: { id: string; path: string };
};

const usePlaces = (open: boolean): [PlacesState, () => void] => {
  const [state, setState] = React.useState<PlacesState>({ kind: 'checking' });
  const [turn, setTurn] = React.useState(0);
  const recheck = React.useCallback(() => setTurn((current) => current + 1), []);
  React.useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setState({ kind: 'checking' });
    listSpacePlaces(controller.signal).then((places) => {
      if (places.length === 0) setState({ kind: 'failed', failure: { code: 'place_missing', message: '' } });
      else setState({ kind: 'ready', places });
    }, (error: Error) => {
      if (controller.signal.aborted) return;
      setState({ kind: 'failed', failure: failureOfError(error) });
    });
    return () => controller.abort();
  }, [open, turn]);
  return [state, recheck];
};

const useChanges = (open: boolean, directory: string): ChangesState => {
  const [state, setState] = React.useState<ChangesState>({ kind: 'loading' });
  React.useEffect(() => {
    if (!open) return;
    let current = true;
    setState({ kind: 'loading' });
    getGitStatus(directory, { fresh: true }).then(
      (status) => { if (current) setState({ kind: 'ready', files: status.files.map((file) => file.path) }); },
      () => { if (current) setState({ kind: 'unknown' }); },
    );
    return () => { current = false; };
  }, [directory, open]);
  return state;
};

export const NewSpaceDialog: React.FC<NewSpaceDialogProps> = ({ open, onOpenChange, project }) => {
  const { t } = useI18n();
  const isMobile = useUIStore((state) => state.isMobile);
  const [places, recheckPlaces] = usePlaces(open);
  const changes = useChanges(open, project.path);

  const [name, setName] = React.useState(generateBranchSlug);
  const [placeId, setPlaceId] = React.useState<string | null>(null);
  const [start, setStart] = React.useState<SpaceStart | null>(null);
  const [showFiles, setShowFiles] = React.useState(false);
  const [mode, setMode] = React.useState<'allowlist' | 'open' | null>(null);
  const [domains, setDomains] = React.useState<string[]>([]);
  const [domainInput, setDomainInput] = React.useState('');
  const [domainError, setDomainError] = React.useState(false);
  const [access, setAccess] = React.useState<Record<string, AccessChoice>>({});
  const [submitting, setSubmitting] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<string | null>(null);

  const hostLogins = useSpaceHostLogins(open);
  const loginOnly = SPACE_LOGIN_ONLY_PROVIDERS.filter((id) => usableHostLoginOf(hostLogins.logins, id) !== null);
  const providers = useSpaceModelProviders(open ? project.path : null, loginOnly);

  React.useEffect(() => {
    if (!open) return;
    setName(generateBranchSlug());
    setPlaceId(null);
    setStart(null);
    setShowFiles(false);
    setMode(null);
    setDomains([]);
    setDomainInput('');
    setDomainError(false);
    setSubmitError(null);
    setAccess({});
  }, [open]);

  const domainsTouched = React.useRef(false);
  React.useEffect(() => {
    if (!open) return;
    domainsTouched.current = false;
    let current = true;
    opencodeClient.listLocalDirectory(project.path).then((entries) => {
      if (!current || domainsTouched.current) return;
      setDomains(registryDomainsOf(entries.filter((entry) => entry.isFile).map((entry) => entry.name)));
    }, () => undefined);
    return () => { current = false; };
  }, [open, project.path]);

  const logins = hostLogins.logins;
  React.useEffect(() => {
    const currentProviderId = useConfigStore.getState().currentProviderId;
    setAccess((current) => {
      let changed = false;
      const next = { ...current };
      for (const provider of providers) {
        const existing = current[provider.id];
        const source = provider.custom ? 'env' : defaultKeySource(provider, usableHostLoginOf(logins, provider.id));
        if (!existing) {
          next[provider.id] = { selected: provider.id === currentProviderId && !provider.custom?.blocked, source, sourceChosen: Boolean(provider.custom), envName: provider.key?.envName ?? '', value: '' };
          changed = true;
        } else if (!existing.sourceChosen && existing.source !== source) {
          next[provider.id] = { ...existing, source };
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [logins, providers]);

  const changedFiles = changes.kind === 'ready' ? changes.files : [];
  const hasChanges = changedFiles.length > 0;
  const effectiveStart: SpaceStart = start ?? (hasChanges ? 'uncommitted' : 'clean');
  const listed = places.kind === 'ready' ? places.places : [];
  const place = listed.find((candidate) => candidate.id === placeId) ?? listed.find((candidate) => candidate.available) ?? listed[0] ?? null;
  const canRestrict = place === null || !place.available || place.hostIsolation;
  const effectiveMode = mode === 'allowlist' && !canRestrict ? 'open' : mode ?? (canRestrict ? 'allowlist' : 'open');
  const chosenAccess = providers.filter((provider) => access[provider.id]?.selected);
  const accessIncomplete = chosenAccess.some((provider) => !isAccessChoiceComplete(provider, access[provider.id]));
  const canCreate = place?.available === true && name.trim() !== '' && changes.kind !== 'loading' && !accessIncomplete && !submitting;

  const addDomain = () => {
    const candidates = domainInput.split(/[\s,]+/).map((value) => value.trim().toLowerCase()).filter(Boolean);
    if (candidates.length === 0) return;
    const invalid = candidates.filter((value) => !isDomainName(value));
    domainsTouched.current = true;
    setDomains((current) => Array.from(new Set([...current, ...candidates.filter((value) => isDomainName(value))])));
    setDomainInput(invalid.join(' '));
    setDomainError(invalid.length > 0);
  };

  const updateAccess = (providerId: string, change: Partial<AccessChoice>) => {
    setAccess((current) => ({ ...current, [providerId]: { ...current[providerId], ...change } }));
  };

  const handleCreate = async () => {
    if (!canCreate || place === null) return;
    setSubmitting(true);
    setSubmitError(null);
    const grants: SpaceModelAccess[] = chosenAccess.map((provider) => modelGrantOf(provider, access[provider.id]));
    try {
      const setup = await resolveSpaceSetupPlan(project.path);
      await startSpaceCreation({
        projectId: project.id,
        setup,
        request: { projectDirectory: project.path, placeId: place.id, name: name.trim(), start: effectiveStart, network: { mode: effectiveMode, domains: effectiveMode === 'allowlist' ? domains : [] } },
        access: grants,
        refusalMessage: t('spaces.create.queueRefused'),
      });
      const model = composerModelForSpaceAccess(grants.map((grant) => grant.provider));
      if (model) {
        useConfigStore.getState().setProvider(model.providerId);
        useConfigStore.getState().setModel(model.modelId);
      }
      onOpenChange(false);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      setSubmitError(spaceFailureText(t, failureOfError(error)));
    } finally {
      setSubmitting(false);
    }
  };


  const block = (title: string, children: React.ReactNode, info?: string) => (
    <section className="flex min-w-0 flex-col gap-2">
      <h3 className="flex items-center gap-1.5 typography-meta font-semibold text-foreground">
        {title}
        {info ? <SettingsInfoHint>{info}</SettingsInfoHint> : null}
      </h3>
      {children}
    </section>
  );

  const placeName = (candidate: SpacePlace) => candidate.machine ?? t('spaces.create.place.localDocker');
  const placeDetails = (candidate: SpacePlace) => {
    const setupShown = candidate.setup && (candidate.setup.remedy || candidate.setup.job || (candidate.available && candidate.setup.memory?.low));
    return (
      <>
        {setupShown ? <DockerSetupNotice place={candidate} onRecheck={recheckPlaces} withCheck={!candidate.available} /> : null}
        {!setupShown && !candidate.available ? (
          <p className="typography-meta text-status-error">{spaceFailureText(t, candidate, candidate.machine === null ? undefined : { machine: candidate.machine })}</p>
        ) : null}
        {candidate.machine !== null ? <p className="typography-meta text-status-warning">{t('spaces.create.place.keysOnMachine', { machine: candidate.machine })}</p> : null}
      </>
    );
  };

  const placeBlock = (() => {
    if (places.kind === 'checking') {
      return (
        <p className="flex items-center gap-1.5 typography-meta text-muted-foreground" role="status">
          <Spinner className="h-3.5 w-3.5" />
          {t('spaces.create.place.checking')}
        </p>
      );
    }
    if (places.kind === 'failed') {
      return <p className="typography-meta text-status-error">{spaceFailureText(t, places.failure)}</p>;
    }
    if (listed.length === 1 && place !== null) {
      return (
        <div className="space-y-2">
          <div className="flex items-start gap-2 typography-ui-label text-foreground">
            <Icon name="computer" className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <span>
              {placeName(place)}
              {place.available && place.version ? <span className="ms-2 whitespace-nowrap typography-meta text-muted-foreground">{`Docker ${place.version}`}</span> : null}
            </span>
          </div>
          {placeDetails(place)}
        </div>
      );
    }
    return (
      <div className="space-y-2">
        <SettingsRadioGroup aria-label={t('spaces.create.place.label')}>
          {listed.map((candidate) => (
            <SettingsRadioOption ariaLabel={placeName(candidate)} key={candidate.id} selected={place?.id === candidate.id} onSelect={() => setPlaceId(candidate.id)} label={placeName(candidate)} />
          ))}
        </SettingsRadioGroup>
        {place ? placeDetails(place) : null}
      </div>
    );
  })();

  const filesText = changedFiles.length === 1 ? t('spaces.create.start.filesSingle') : t('spaces.create.start.filesPlural', { count: changedFiles.length });
  const codeBlock = changes.kind === 'ready' && !hasChanges ? (
    <p className="typography-meta text-muted-foreground">{t('spaces.create.start.cleanOnly')}</p>
  ) : (
    <div className="space-y-1.5">
      <SettingsRadioGroup aria-label={t('spaces.create.start.label')}>
        <SettingsRadioOption ariaLabel={t('spaces.create.start.clean')} selected={effectiveStart === 'clean'} onSelect={() => setStart('clean')} label={t('spaces.create.start.clean')} />
        <SettingsRadioOption
          ariaLabel={t('spaces.create.start.uncommitted')}
          selected={effectiveStart === 'uncommitted'}
          onSelect={() => setStart('uncommitted')}
          disabled={changes.kind !== 'ready'}
          label={t('spaces.create.start.uncommitted')}
          description={changes.kind === 'loading' ? t('spaces.create.start.changesChecking') : changes.kind === 'unknown' ? t('spaces.create.start.changesUnknown') : hasChanges ? filesText : undefined}
        />
      </SettingsRadioGroup>
      {hasChanges && effectiveStart === 'uncommitted' ? (
        <div className="ps-6">
          <button type="button" className="inline-flex items-center typography-meta text-muted-foreground hover:text-foreground hover:underline" onClick={() => setShowFiles((value) => !value)}>
            {showFiles ? t('spaces.create.start.hideFiles') : t('spaces.create.start.showFiles')}
            <Icon name={showFiles ? 'arrow-down-s' : 'arrow-right-s'} className="ms-0.5 h-3.5 w-3.5" />
          </button>
          {showFiles ? (
            <ScrollableOverlay as="ul" dir="ltr" outerClassName="mt-1 max-h-32" className="typography-meta text-muted-foreground" disableHorizontal>
              {changedFiles.map((file) => <li key={file} className="truncate font-mono">{file}</li>)}
            </ScrollableOverlay>
          ) : null}
        </div>
      ) : null}
    </div>
  );

  const networkBlock = (
    <div className="space-y-1.5">
      <SettingsRadioGroup aria-label={t('spaces.create.network.label')}>
        <SettingsRadioOption
          ariaLabel={t('spaces.create.network.allowlist')}
          selected={effectiveMode === 'allowlist'}
          onSelect={() => setMode('allowlist')}
          disabled={!canRestrict}
          label={t('spaces.create.network.allowlist')}
          description={canRestrict ? undefined : t('spaces.create.network.cannotRestrict')}
        />
        <div className="space-y-1.5 ps-6">
          {domains.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {domains.map((domain) => (
                <span key={domain} className="inline-flex items-center gap-1 rounded-md bg-[var(--surface-muted)] px-1.5 py-0.5 typography-meta text-foreground">
                  <span dir="ltr" className="font-mono">{domain}</span>
                  <button type="button" disabled={effectiveMode !== 'allowlist'} aria-label={t('spaces.create.network.removeDomain', { domain })} onClick={() => { domainsTouched.current = true; setDomains((current) => current.filter((value) => value !== domain)); }}>
                    <Icon name="close" className="h-3 w-3 text-muted-foreground hover:text-foreground" />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          <Input
            value={domainInput}
            onChange={(event) => { setDomainInput(event.target.value); setDomainError(false); }}
            onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ',') { event.preventDefault(); addDomain(); } }}
            onBlur={addDomain}
            placeholder={t('spaces.create.network.domainPlaceholder')}
            aria-label={t('spaces.create.network.domainPlaceholder')}
            spellCheck={false}
            disabled={effectiveMode !== 'allowlist'}
          />
          {domainError ? <p className="typography-meta text-status-error">{t('spaces.create.network.domainInvalid')}</p> : null}
        </div>
        <SettingsRadioOption
          ariaLabel={t('spaces.create.network.open')}
          selected={effectiveMode === 'open'}
          onSelect={() => setMode('open')}
          label={t('spaces.create.network.open')}
          description={<span className={cn(effectiveMode === 'open' && 'text-status-warning')}>{t('spaces.create.network.openWarning')}</span>}
        />
      </SettingsRadioGroup>
    </div>
  );

  const modelsBlock = providers.length === 0 ? (
    <p className="typography-meta text-muted-foreground">{t('spaces.create.access.noneAvailable')}</p>
  ) : (
    <div className="space-y-2.5">
      {providers.map((provider) => {
        const choice = access[provider.id];
        if (!choice) return null;
        return (
          <div key={provider.id} className="space-y-1.5">
            <label className={cn('flex items-center gap-2', provider.custom?.blocked ? 'cursor-not-allowed' : 'cursor-pointer')}>
              <Checkbox checked={choice.selected} onChange={(selected) => updateAccess(provider.id, { selected })} ariaLabel={provider.name} disabled={Boolean(provider.custom?.blocked)} />
              <span className="typography-ui-label text-foreground">{provider.name}</span>
            </label>
            {choice.selected || provider.custom?.blocked ? (
              <div className="ps-6">
                <ModelKeySource provider={provider} login={usableHostLoginOf(logins, provider.id)} choice={choice} onChange={(change) => updateAccess(provider.id, { ...change, sourceChosen: true })} machine={place?.machine ?? null} />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );

  const nameField = (
    <Input value={name} onChange={(event) => setName(event.target.value)} aria-label={t('spaces.create.name.label')} spellCheck={false} />
  );
  const leftBlocks = (
    <>
      {block(t('spaces.create.name.label'), nameField)}
      {block(t('spaces.create.place.label'), placeBlock)}
      {block(t('spaces.create.start.label'), codeBlock, t('spaces.create.start.ignoredNeverTravel'))}
    </>
  );
  const rightBlocks = (
    <>
      {block(t('spaces.create.network.label'), networkBlock, t('spaces.create.network.info'))}
      {block(t('spaces.create.access.label'), modelsBlock, providers.length > 0 ? t('spaces.create.access.info') : undefined)}
    </>
  );
  const body = isMobile ? (
    <div className="flex min-w-0 flex-col gap-5">
      <p className="typography-meta text-muted-foreground">{t('spaces.create.description')}</p>
      {leftBlocks}
      {rightBlocks}
    </div>
  ) : (
    <div className="grid gap-5 md:grid-cols-2 md:gap-x-10">
      <div className="flex min-w-0 flex-col gap-5">{leftBlocks}</div>
      <div className="flex min-w-0 flex-col gap-5">{rightBlocks}</div>
    </div>
  );

  const status = submitError
    ? { text: submitError, className: 'text-status-error', icon: true }
    : chosenAccess.length === 0 && providers.length > 0
      ? { text: t('spaces.create.access.noneChosenWarning'), className: 'text-muted-foreground', icon: false }
      : null;
  const footer = (
    <div className={cn('flex w-full gap-2', isMobile ? 'flex-col' : 'flex-row items-center')}>
      <p className={cn('flex min-h-4 min-w-0 items-center gap-1.5 typography-micro', status?.className, isMobile ? 'order-first w-full' : 'flex-1')} title={status?.text}>
        {status?.icon ? <Icon name="error-warning" className="h-3.5 w-3.5 shrink-0" /> : null}
        <span className={cn(!isMobile && 'truncate')}>{status?.text}</span>
      </p>
      <div className={cn('flex shrink-0 gap-2', isMobile && 'w-full')}>
        <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={submitting} className={cn(isMobile && 'flex-1')}>{t('spaces.create.cancel')}</Button>
        <Button size="sm" onClick={() => void handleCreate()} disabled={!canCreate} className={cn('gap-1.5', isMobile && 'flex-1')}>
          {submitting ? <Icon name="loader-4" className="h-3.5 w-3.5 animate-spin" /> : null}
          {t('spaces.create.submit')}
        </Button>
      </div>
    </div>
  );

  if (isMobile) {
    return (
      <MobileOverlayPanel open={open} title={t('spaces.create.title')} onClose={() => onOpenChange(false)} footer={footer}>
        <div className="px-3 pb-4 pt-1">{body}</div>
      </MobileOverlayPanel>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(30rem,85vh)] max-w-3xl flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon name="instance" className="h-5 w-5" />
            {t('spaces.create.title')}
          </DialogTitle>
          <DialogDescription>{t('spaces.create.description')}</DialogDescription>
        </DialogHeader>
        <ScrollableOverlay outerClassName="mt-2 min-h-0 flex-1" disableHorizontal>
          <div className="pe-3">{body}</div>
        </ScrollableOverlay>
        <DialogFooter className="mt-1">{footer}</DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
