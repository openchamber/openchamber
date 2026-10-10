/**
 * The create dialog of an isolated space (DESIGN.md, user journey step 1): its name, where it
 * runs, what code it starts from, its network, and model access given up front. Opened from the
 * new-session draft picker, the one entry point; never mounted in VS Code (decision 16).
 *
 * Opening it is the user acting in the feature's own screen, so it checks the place now
 * (decision 19); nothing checks it earlier to decide whether to offer the entry.
 */

import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { Radio } from '@/components/ui/radio';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { getGitStatus } from '@/lib/gitApi';
import { generateBranchSlug } from '@/lib/git/branchNameGenerator';
import { useI18n } from '@/lib/i18n';
import { SPACE_LOGIN_ONLY_PROVIDERS, SPACE_MODEL_PROVIDERS } from '@/lib/spaces/model-access';
import { isDomainName } from '@/lib/spaces/space-access';
import { listSpacePlaces, type SpaceFailure, type SpacePlace, type SpaceStart } from '@/lib/spaces/spaces-api';
import { startSpaceCreation, type SpaceModelAccess } from '@/lib/spaces/space-creation';
import { resolveSpaceSetupPlan } from '@/lib/spaces/space-setup';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { failureOfError, spaceFailureText } from './spaceFailureText';
import { ModelKeySource } from './ModelKeySource';
import { isAccessChoiceComplete, modelGrantOf, usableHostLoginOf, useSpaceHostLogins, useSpaceModelProviders, type KeySourceChoice } from './spaceModelKeys';

type PlaceState = { kind: 'checking' } | { kind: 'ready'; place: Extract<SpacePlace, { available: true }> } | { kind: 'unavailable'; failure: SpaceFailure };
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

const usePlace = (open: boolean): PlaceState => {
  const [state, setState] = React.useState<PlaceState>({ kind: 'checking' });
  React.useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setState({ kind: 'checking' });
    listSpacePlaces(controller.signal).then((places) => {
      const place = places[0];
      if (!place) setState({ kind: 'unavailable', failure: { code: 'place_missing', message: '' } });
      else if (place.available) setState({ kind: 'ready', place });
      else setState({ kind: 'unavailable', failure: { code: place.code, message: place.message } });
    }, (error: Error) => {
      if (controller.signal.aborted) return;
      setState({ kind: 'unavailable', failure: failureOfError(error) });
    });
    return () => controller.abort();
  }, [open]);
  return state;
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
  const place = usePlace(open);
  const changes = useChanges(open, project.path);

  const [name, setName] = React.useState(generateBranchSlug);
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
  const providers = useSpaceModelProviders(undefined, loginOnly);

  React.useEffect(() => {
    if (!open) return;
    setName(generateBranchSlug());
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
  const canRestrict = place.kind !== 'ready' || place.place.hostIsolation;
  // A choice the place turned out not to support falls back to the one it does.
  const effectiveMode = mode === 'allowlist' && !canRestrict ? 'open' : mode ?? (canRestrict ? 'allowlist' : 'open');
  const chosenAccess = providers.filter((provider) => access[provider.id]?.selected);
  const accessIncomplete = chosenAccess.some((provider) => !isAccessChoiceComplete(provider, access[provider.id]));
  const canCreate = place.kind === 'ready' && name.trim() !== '' && changes.kind !== 'loading' && !accessIncomplete && !submitting;

  const addDomain = () => {
    const candidates = domainInput.split(/[\s,]+/).map((value) => value.trim().toLowerCase()).filter(Boolean);
    if (candidates.length === 0) return;
    const invalid = candidates.filter((value) => !isDomainName(value));
    setDomains((current) => Array.from(new Set([...current, ...candidates.filter((value) => isDomainName(value))])));
    setDomainInput(invalid.join(' '));
    setDomainError(invalid.length > 0);
  };

  const updateAccess = (providerId: string, change: Partial<AccessChoice>) => {
    setAccess((current) => ({ ...current, [providerId]: { ...current[providerId], ...change } }));
  };

  const handleCreate = async () => {
    if (!canCreate) return;
    setSubmitting(true);
    setSubmitError(null);
    const grants: SpaceModelAccess[] = chosenAccess.map((provider) => modelGrantOf(provider, access[provider.id]));
    try {
      // Before the space is asked for: the trust prompt for shared commands opens over this dialog.
      const setup = await resolveSpaceSetupPlan(project.path);
      await startSpaceCreation({
        projectId: project.id,
        setup,
        request: { projectDirectory: project.path, name: name.trim(), start: effectiveStart, network: { mode: effectiveMode, domains: effectiveMode === 'allowlist' ? domains : [] } },
        access: grants,
        refusalMessage: t('spaces.create.queueRefused'),
      });
      onOpenChange(false);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      setSubmitError(spaceFailureText(t, failureOfError(error)));
    } finally {
      setSubmitting(false);
    }
  };

  const section = (title: string, children: React.ReactNode) => (
    <section className="space-y-2">
      <h3 className="typography-ui-label font-semibold text-foreground">{title}</h3>
      {children}
    </section>
  );

  const option = (checked: boolean, onSelect: () => void, label: string, disabled = false) => (
    <label className={`flex items-start gap-2 ${disabled ? 'opacity-50' : 'cursor-pointer'}`}>
      <Radio checked={checked} onChange={onSelect} disabled={disabled} ariaLabel={label} className="mt-0.5" />
      <span className="typography-ui-label text-foreground">{label}</span>
    </label>
  );

  const body = (
    <div className="space-y-5 pr-3">
      {section(t('spaces.create.name.label'), (
        <Input value={name} onChange={(event) => setName(event.target.value)} className="h-9 max-w-sm" aria-label={t('spaces.create.name.label')} />
      ))}

      {section(t('spaces.create.place.label'), (
        <div className="flex items-start gap-2 typography-ui-label">
          <Icon name="computer" className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 space-y-0.5">
            <div className="text-foreground">{t('spaces.create.place.localDocker')}</div>
            {place.kind === 'checking' ? <div className="typography-meta text-muted-foreground">{t('spaces.create.place.checking')}</div> : null}
            {place.kind === 'unavailable' ? <div className="typography-meta text-status-error">{spaceFailureText(t, place.failure)}</div> : null}
          </div>
        </div>
      ))}

      {section(t('spaces.create.start.label'), changes.kind === 'ready' && !hasChanges ? (
        <p className="typography-ui-label text-muted-foreground">{t('spaces.create.start.cleanOnly')}</p>
      ) : (
        <div className="space-y-2">
          {option(effectiveStart === 'clean', () => setStart('clean'), t('spaces.create.start.clean'))}
          {option(effectiveStart === 'uncommitted', () => setStart('uncommitted'), t('spaces.create.start.uncommitted'), changes.kind !== 'ready')}
          {changes.kind === 'unknown' ? <p className="typography-meta text-muted-foreground">{t('spaces.create.start.changesUnknown')}</p> : null}
          {hasChanges && effectiveStart === 'uncommitted' ? (
            <div className="pl-6">
              <button type="button" className="typography-meta text-muted-foreground hover:text-foreground" onClick={() => setShowFiles((value) => !value)}>
                {changedFiles.length === 1 ? t('spaces.create.start.filesSingle') : t('spaces.create.start.filesPlural', { count: changedFiles.length })}
                <Icon name={showFiles ? 'arrow-down-s' : 'arrow-right-s'} className="ml-0.5 inline h-3.5 w-3.5" />
              </button>
              {showFiles ? (
                <ul className="mt-1 max-h-32 overflow-y-auto typography-meta text-muted-foreground">
                  {changedFiles.map((file) => <li key={file} className="truncate font-mono">{file}</li>)}
                </ul>
              ) : null}
            </div>
          ) : null}
          <p className="typography-meta text-muted-foreground">{t('spaces.create.start.ignoredNeverTravel')}</p>
        </div>
      ))}

      {section(t('spaces.create.network.label'), (
        <div className="space-y-2">
          {option(effectiveMode === 'allowlist', () => setMode('allowlist'), t('spaces.create.network.allowlist'), !canRestrict)}
          {!canRestrict ? <p className="pl-6 typography-meta text-muted-foreground">{t('spaces.create.network.cannotRestrict')}</p> : null}
          {effectiveMode === 'allowlist' ? (
            <div className="space-y-1.5 pl-6">
              {domains.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {domains.map((domain) => (
                    <span key={domain} className="inline-flex items-center gap-1 rounded-md bg-[var(--surface-muted)] px-1.5 py-0.5 typography-meta text-foreground">
                      <span className="font-mono">{domain}</span>
                      <button type="button" aria-label={t('spaces.create.network.removeDomain', { domain })} onClick={() => setDomains((current) => current.filter((value) => value !== domain))}>
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
                className="h-9 max-w-sm"
              />
              {domainError ? <p className="typography-meta text-status-error">{t('spaces.create.network.domainInvalid')}</p> : null}
              <p className="typography-meta text-muted-foreground">{t('spaces.create.network.modelNeedsNoDomain')}</p>
            </div>
          ) : null}
          {option(effectiveMode === 'open', () => setMode('open'), t('spaces.create.network.open'))}
          {effectiveMode === 'open' ? <p className="pl-6 typography-meta text-status-warning">{t('spaces.create.network.openWarning')}</p> : null}
          <p className="typography-meta text-muted-foreground">{t('spaces.create.network.alwaysBlocked')}</p>
        </div>
      ))}

      {section(t('spaces.create.access.label'), providers.length === 0 ? (
        <p className="typography-ui-label text-muted-foreground">{t('spaces.create.access.noneAvailable')}</p>
      ) : (
        <div className="space-y-3">
          {providers.map((provider) => {
            const choice = access[provider.id];
            if (!choice) return null;
            return (
              <div key={provider.id} className="space-y-1.5">
                <label className="flex cursor-pointer items-center gap-2">
                  <Checkbox checked={choice.selected} onChange={(selected) => updateAccess(provider.id, { selected })} ariaLabel={provider.name} />
                  <span className="typography-ui-label text-foreground">{provider.name}</span>
                  <span className="typography-micro text-muted-foreground">{t('spaces.create.access.gradeUsesWithoutSeeing')}</span>
                </label>
                {choice.selected ? (
                  <div className="pl-6">
                    <ModelKeySource provider={provider} login={usableHostLoginOf(logins, provider.id)} choice={choice} onChange={(change) => updateAccess(provider.id, { ...change, sourceChosen: true })} />
                  </div>
                ) : null}
              </div>
            );
          })}
          <p className="typography-meta text-muted-foreground">{t('spaces.create.access.hostKeysNotReused')}</p>
        </div>
      ))}
    </div>
  );

  const footer = (
    <div className="flex w-full flex-col gap-2">
      {chosenAccess.length === 0 && providers.length > 0 ? <p className="typography-meta text-status-warning">{t('spaces.create.access.noneChosenWarning')}</p> : null}
      {submitError ? <p className="typography-meta text-status-error">{submitError}</p> : null}
      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={submitting}>{t('spaces.create.cancel')}</Button>
        <Button size="sm" onClick={() => void handleCreate()} disabled={!canCreate} className="gap-1.5">
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
      <DialogContent className="flex max-h-[80vh] max-w-lg flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon name="box-3" className="h-5 w-5" />
            {t('spaces.create.title')}
          </DialogTitle>
        </DialogHeader>
        <ScrollableOverlay outerClassName="mt-2 flex-1" disableHorizontal>{body}</ScrollableOverlay>
        <DialogFooter className="mt-1">{footer}</DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
