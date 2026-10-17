/**
 * The create dialog of an isolated space (journey step 1): its name, where it
 * runs, what code it starts from, its network, and model access given up front. Opened from the
 * new-session draft picker, the one entry point; never mounted in VS Code (decision 16).
 *
 * Opening it is the user acting in the feature's own screen, so it checks the places now
 * (decision 19); nothing checks them earlier to decide whether to offer the entry. With one place
 * the dialog names it; with another machine set up in Settings it offers the choice, and under
 * the machine says that the keys granted below are stored there (the maintainer's call of 2026-10-12).
 */

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
import { SPACE_LOGIN_ONLY_PROVIDERS, SPACE_MODEL_PROVIDERS } from '@/lib/spaces/model-access';
import { opencodeClient } from '@/lib/opencode/client';
import { registryDomainsOf } from '@/lib/spaces/registry-domains';
import { isDomainName } from '@/lib/spaces/space-access';
import { listSpacePlaces, type SpaceFailure, type SpacePlace, type SpaceStart } from '@/lib/spaces/spaces-api';
import { startSpaceCreation, type SpaceModelAccess } from '@/lib/spaces/space-creation';
import { composerModelForSpaceAccess } from '@/lib/spaces/space-model-access';
import { resolveSpaceSetupPlan } from '@/lib/spaces/space-setup';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { failureOfError, spaceFailureText } from './spaceFailureText';
import { DockerSetupNotice } from './DockerSetupNotice';
import { ModelKeySource } from './ModelKeySource';
import { isAccessChoiceComplete, modelGrantOf, usableHostLoginOf, useSpaceHostLogins, useSpaceModelProviders, type KeySourceChoice } from './spaceModelKeys';

// The places, each checked by the host as the list came: none at all is a failure of its own.
type PlacesState = { kind: 'checking' } | { kind: 'ready'; places: SpacePlace[] } | { kind: 'failed'; failure: SpaceFailure };
type ChangesState = { kind: 'loading' } | { kind: 'ready'; files: string[] } | { kind: 'unknown' };
// `sourceChosen` once the user touched where the key comes from, the name or the key included, so
// the host's logins arriving later never move the radio under their cursor; until then the host's
// login, when it has one to offer, is the choice, since it asks for nothing.
type AccessChoice = KeySourceChoice & { selected: boolean; sourceChosen: boolean };

type NewSpaceDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: { id: string; path: string };
};

/** The places, checked when the dialog opens and again on `recheck`. */
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
  // A login-only provider has a row only while the host has a login the space can be given.
  const loginOnly = SPACE_LOGIN_ONLY_PROVIDERS.filter((id) => usableHostLoginOf(hostLogins.logins, id) !== null);
  const providers = useSpaceModelProviders(undefined, loginOnly, open ? project.path : null);

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
    setAccess(Object.fromEntries([
      ...SPACE_MODEL_PROVIDERS.map((provider): [string, AccessChoice] => [provider.id, {
        selected: provider.id === useConfigStore.getState().currentProviderId,
        source: 'env',
        sourceChosen: false,
        envName: provider.envName,
        value: '',
      }]),
      ...SPACE_LOGIN_ONLY_PROVIDERS.map((id): [string, AccessChoice] => [id, {
        selected: id === useConfigStore.getState().currentProviderId,
        source: 'login',
        sourceChosen: false,
        envName: '',
        value: '',
      }]),
    ]));
  }, [open]);

  // The registries the project installs from, as the allowlist's first domains: its setup commands
  // install dependencies, and an empty list would refuse every download. Set once per opening, and
  // only while the user has not changed the list.
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

  // A provider of the user's own arrives from the host after the dialog opened: its row starts
  // unticked, or ticked when the composer's model is its own.
  React.useEffect(() => {
    setAccess((current) => {
      const missing = providers.filter((provider) => provider.custom && !current[provider.id]);
      if (missing.length === 0) return current;
      const currentProviderId = useConfigStore.getState().currentProviderId;
      return { ...current, ...Object.fromEntries(missing.map((provider): [string, AccessChoice] => [provider.id, { selected: provider.id === currentProviderId && provider.custom?.blocked === null, source: 'env', sourceChosen: true, envName: '', value: '' }])) };
    });
  }, [providers]);

  const logins = hostLogins.logins;
  React.useEffect(() => {
    setAccess((current) => Object.fromEntries(Object.entries(current).map(([providerId, choice]) => {
      if (choice.sourceChosen || SPACE_LOGIN_ONLY_PROVIDERS.includes(providerId)) return [providerId, choice];
      const offered = usableHostLoginOf(logins, providerId) !== null;
      return [providerId, { ...choice, source: offered ? 'login' : choice.source === 'login' ? 'env' : choice.source }];
    })));
  }, [logins]);

  const changedFiles = changes.kind === 'ready' ? changes.files : [];
  const hasChanges = changedFiles.length > 0;
  // With changes the uncommitted start is the default; with an unreadable list, the clean one, so
  // nothing travels that the user was not shown.
  const effectiveStart: SpaceStart = start ?? (hasChanges ? 'uncommitted' : 'clean');
  // Until the user picks, the first place that answers; the first place at all when none does, so
  // its failure is the one shown.
  const listed = places.kind === 'ready' ? places.places : [];
  const place = listed.find((candidate) => candidate.id === placeId) ?? listed.find((candidate) => candidate.available) ?? listed[0] ?? null;
  const canRestrict = place === null || !place.available || place.hostIsolation;
  // A choice the place turned out not to support falls back to the one it does.
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
      // Before the space is asked for: the trust prompt for shared commands opens over this dialog.
      const setup = await resolveSpaceSetupPlan(project.path);
      await startSpaceCreation({
        projectId: project.id,
        setup,
        request: { projectDirectory: project.path, placeId: place.id, name: name.trim(), start: effectiveStart, network: { mode: effectiveMode, domains: effectiveMode === 'allowlist' ? domains : [] } },
        access: grants,
        refusalMessage: t('spaces.create.queueRefused'),
      });
      // The first message goes on a model the space was given, not on one it would refuse.
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


  // A titled block, as the new worktree dialog has them; `info` is the explanation behind its mark.
  const block = (title: string, children: React.ReactNode, info?: string) => (
    <section className="flex min-w-0 flex-col gap-2">
      <h3 className="flex items-center gap-1.5 typography-meta font-semibold text-foreground">
        {title}
        {info ? <SettingsInfoHint>{info}</SettingsInfoHint> : null}
      </h3>
      {children}
    </section>
  );

  // A place by the name the user knows it: this computer, or the machine as they wrote it.
  const placeName = (candidate: SpacePlace) => candidate.machine ?? t('spaces.create.place.localDocker');
  // Under the chosen place: on this computer, the action that gets Docker going or the step to
  // take, and a memory too small for a space; elsewhere what the host said; on another machine,
  // what granting a key below means there.
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
              {/* A product name and its version, the same in every language. */}
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
          description={changes.kind === 'unknown' ? t('spaces.create.start.changesUnknown') : hasChanges ? filesText : undefined}
        />
      </SettingsRadioGroup>
      {hasChanges && effectiveStart === 'uncommitted' ? (
        <div className="ps-6">
          <button type="button" className="inline-flex items-center typography-meta text-muted-foreground hover:text-foreground hover:underline" onClick={() => setShowFiles((value) => !value)}>
            {showFiles ? t('spaces.create.start.hideFiles') : t('spaces.create.start.showFiles')}
            <Icon name={showFiles ? 'arrow-down-s' : 'arrow-right-s'} className="ms-0.5 h-3.5 w-3.5" />
          </button>
          {showFiles ? (
            // Paths from the user's own repository: text to show, left to right in every language.
            <ul dir="ltr" className="mt-1 max-h-32 overflow-y-auto typography-meta text-muted-foreground">
              {changedFiles.map((file) => <li key={file} className="truncate font-mono">{file}</li>)}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );

  // The domains sit under the option they belong to, inside the one group.
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
        {/* Always there, disabled for the open internet, so choosing it moves nothing. */}
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
          // What it risks is said in the warning colour once it is the choice.
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
  // What goes in on the left, what it can reach on the right; one column on a phone.
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
    // Two columns once the window leaves room for them; a narrow window reads top to bottom.
    <div className="grid gap-5 md:grid-cols-2 md:gap-x-10">
      <div className="flex min-w-0 flex-col gap-5">{leftBlocks}</div>
      <div className="flex min-w-0 flex-col gap-5">{rightBlocks}</div>
    </div>
  );

  // One line beside the buttons: why the create failed, or, quietly, that a model is still to choose.
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
      {/* A fixed height: what opens or closes inside scrolls, the dialog never jumps. */}
      <DialogContent className="flex h-[min(30rem,85vh)] max-w-3xl flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon name="box-3" className="h-5 w-5" />
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
