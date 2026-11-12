/**
 * The places of isolated spaces in Settings (journey step 9, and decision 12): each
 * place with how many spaces run and stand stopped there, the disk its image, tools and spaces take,
 * the spaces whose container is gone, and "Clean up…", which removes what OpenChamber can make again.
 * The server decides what goes, see `places/docker-disk.js`; this screen only shows and asks.
 *
 * A place that cannot be reached says so and what to do, never a count of zero: the spaces this
 * window last saw are listed as out of reach, and nothing is when it saw none. Nothing polls, except
 * the disk while the host downloads the image, which "Download image" starts ahead of the first
 * space (journey step 0); "Try again" reads the place again. Rendered only while the switch is on
 * (decision 19).
 */

import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Spinner } from '@/components/ui/spinner';
import { DockerSetupNotice } from '@/components/session/spaces/DockerSetupNotice';
import { SpaceRow } from '@/components/session/spaces/SpaceRow';
import { failureOfError, spaceFailureText } from '@/components/session/spaces/spaceFailureText';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { formatDiskSize } from '@/lib/spaces/space-disk';
import { Input } from '@/components/ui/input';
import { reportSettingsSaveState } from '@/lib/persistence';
import {
  SSH_PLACE_ID,
  cleanUpSpaceDisk,
  listSpacePlaces,
  pullSpaceImage,
  readSpaceDisk,
  setSpaceMachine,
  type SpaceCleanUp,
  type SpaceDisk,
  type SpaceEntry,
  type SpacePlace,
} from '@/lib/spaces/spaces-api';
import { refreshSpacesJourney, useSpacesJourneyRead } from '@/lib/spaces/spaces-store';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { SettingsControlGroup, SettingsFieldRow } from '../shared/SettingsSection';
import { IMAGE_SETTLE_REFRESH_MS, nextDiskReadDelay } from './spacePlacesDisk';

type Read<T> = { kind: 'reading' } | { kind: 'read'; value: T } | { kind: 'failed'; error: Error };

/**
 * Reads once when mounted and again on `retry`; a failure is kept apart, never read as empty.
 * `replace` and `fail` let a later read of the caller's own stand in for the last answer.
 */
const useRead = <T,>(load: (signal: AbortSignal) => Promise<T>): [Read<T>, () => void, (value: T) => void, (error: Error) => void] => {
  const [state, setState] = React.useState<Read<T>>({ kind: 'reading' });
  const [turn, setTurn] = React.useState(0);
  React.useEffect(() => {
    const controller = new AbortController();
    setState({ kind: 'reading' });
    load(controller.signal).then(
      (value) => { if (!controller.signal.aborted) setState({ kind: 'read', value }); },
      (error: Error) => { if (!controller.signal.aborted) setState({ kind: 'failed', error }); },
    );
    return () => controller.abort();
  }, [load, turn]);
  const retry = React.useCallback(() => setTurn((current) => current + 1), []);
  const replace = React.useCallback((value: T) => setState({ kind: 'read', value }), []);
  const fail = React.useCallback((error: Error) => setState({ kind: 'failed', error }), []);
  return [state, retry, replace, fail];
};

type StatusTone = 'ready' | 'todo' | 'busy';

/**
 * One line of a place's state: a check for what is ready, an open circle for what is not done yet
 * and is not a fault, a spinner for what is under way.
 */
const StatusLine: React.FC<{ tone: StatusTone; children: React.ReactNode }> = ({ tone, children }) => (
  <p className="flex items-start gap-1.5 typography-meta text-foreground" role="status">
    {tone === 'busy' ? (
      <Spinner className="mt-[0.2em] h-3.5 w-3.5 shrink-0 text-muted-foreground" />
    ) : (
      <Icon name={tone === 'ready' ? 'checkbox-circle' : 'circle'} className={cn('mt-[0.2em] h-3.5 w-3.5 shrink-0', tone === 'ready' ? 'text-[var(--status-success)]' : 'text-muted-foreground')} />
    )}
    <span>{children}</span>
  </p>
);

/** The one confirmation of a clean-up, with what it frees and, when the image goes, what that costs later. */
const CleanUpConfirm: React.FC<{ disk: SpaceDisk | null; onCancel: () => void; onConfirm: () => void }> = ({ disk, onCancel, onConfirm }) => {
  const { t } = useI18n();
  const isMobile = useUIStore((state) => state.isMobile);
  const open = disk !== null;
  const title = t('settings.openchamber.spaces.places.cleanUp.confirmTitle');
  const lines = disk
    ? [
      t('settings.openchamber.spaces.places.cleanUp.frees', { size: formatDiskSize(disk.freeBytes) }),
      ...(disk.freesImage ? [t('settings.openchamber.spaces.places.cleanUp.imageAgain')] : []),
    ]
    : [];
  const buttons = (
    <div className="flex w-full justify-end gap-2">
      <Button variant="outline" size="sm" onClick={onCancel}>{t('settings.openchamber.spaces.places.cleanUp.cancel')}</Button>
      <Button size="sm" onClick={onConfirm}>{t('settings.openchamber.spaces.places.cleanUp.confirm')}</Button>
    </div>
  );
  if (isMobile) {
    return (
      <MobileOverlayPanel open={open} title={title} onClose={onCancel} footer={buttons}>
        <div className="flex flex-col gap-1 px-3 pb-4 pt-1">
          {lines.map((line) => <p key={line} className="typography-meta text-muted-foreground">{line}</p>)}
        </div>
      </MobileOverlayPanel>
    );
  }
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="flex flex-col gap-1">
            {lines.map((line) => <span key={line}>{line}</span>)}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>{buttons}</DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

type CleanUpState = { kind: 'idle' } | { kind: 'confirming' } | { kind: 'cleaning' } | { kind: 'done'; outcome: SpaceCleanUp } | { kind: 'failed'; error: Error };

/** What a finished clean-up says: what it freed, and what Docker kept. */
const CleanUpOutcome: React.FC<{ outcome: SpaceCleanUp }> = ({ outcome }) => {
  const { t } = useI18n();
  const inUse = outcome.kept.some((item) => item.reason === 'in_use');
  const failed = outcome.kept.some((item) => item.reason === 'failed');
  return (
    <div className="space-y-0.5" role="status">
      <p className="typography-meta text-muted-foreground">{t('settings.openchamber.spaces.places.cleanUp.freed', { size: formatDiskSize(outcome.freedBytes) })}</p>
      {inUse ? <p className="typography-meta text-muted-foreground">{t('settings.openchamber.spaces.places.cleanUp.keptInUse')}</p> : null}
      {failed ? <p className="typography-meta text-[var(--status-warning)]">{t('settings.openchamber.spaces.places.cleanUp.keptFailed')}</p> : null}
    </div>
  );
};

/** The "Download image" button: asking the host to start, or a start the host refused. */
type DownloadState = { kind: 'idle' } | { kind: 'starting' } | { kind: 'failed'; error: Error };

/** The disk of a place that answers, its image download while the image is absent, and its clean-up. */
const PlaceDisk: React.FC<{ placeId: string }> = ({ placeId }) => {
  const { t } = useI18n();
  const load = React.useCallback((signal: AbortSignal) => readSpaceDisk(placeId, signal), [placeId]);
  const [disk, , replaceDisk, failDisk] = useRead(load);
  const [cleanUp, setCleanUp] = React.useState<CleanUpState>({ kind: 'idle' });

  const run = async () => {
    setCleanUp({ kind: 'cleaning' });
    try {
      const outcome = await cleanUpSpaceDisk(placeId);
      replaceDisk(outcome.disk);
      setCleanUp({ kind: 'done', outcome });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      setCleanUp({ kind: 'failed', error });
    }
  };

  // "Download image" while the image is absent (journey step 0). The download runs on the host;
  // the disk is read again, one read at a time with a pause between, until it says the download
  // ended: the one poll of this page, and only while the user watches a download they started or
  // found under way. A read that fails ends the poll and shows as the disk's own failure, so a
  // host that went away does not leave the spinner turning.
  const [download, setDownload] = React.useState<DownloadState>({ kind: 'idle' });
  // The reads after a download ended, while the image has no size yet; a download starts them over.
  const settleReads = React.useRef(0);
  React.useEffect(() => {
    if (disk.kind !== 'read') return;
    const delay = nextDiskReadDelay(disk.value, settleReads.current);
    if (delay === null) return;
    const controller = new AbortController();
    // Each answer replaces the disk and schedules the read after it, until the rule says stop.
    const timer = setTimeout(() => {
      readSpaceDisk(placeId, controller.signal).then(
        (value) => {
          if (controller.signal.aborted) return;
          // The reads of the settle phase are the one-second ones; the three-second read that
          // first sees the download ended is not one of them.
          if (value.imagePulling) settleReads.current = 0;
          else if (value.imageBytes === 0 && delay === IMAGE_SETTLE_REFRESH_MS) settleReads.current += 1;
          replaceDisk(value);
        },
        (error: Error) => { if (!controller.signal.aborted) failDisk(error); },
      );
    }, delay);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [disk, failDisk, placeId, replaceDisk]);
  const downloadImage = async () => {
    setDownload({ kind: 'starting' });
    // What the last clean-up freed is about the disk before this download; one still running keeps its state.
    setCleanUp((current) => (current.kind === 'done' || current.kind === 'failed' ? { kind: 'idle' } : current));
    settleReads.current = 0;
    try {
      replaceDisk(await pullSpaceImage(placeId));
      setDownload({ kind: 'idle' });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      setDownload({ kind: 'failed', error });
    }
  };

  if (disk.kind === 'reading') return <StatusLine tone="busy">{t('settings.openchamber.spaces.places.disk.reading')}</StatusLine>;
  if (disk.kind === 'failed') {
    return <p className="typography-meta text-[var(--status-error)]">{t('settings.openchamber.spaces.places.disk.readFailed', { reason: spaceFailureText(t, failureOfError(disk.error)) })}</p>;
  }
  // A download this window could not start, or the host's word on the last one while the image is absent.
  const imageFailure = download.kind === 'failed' ? failureOfError(download.error) : disk.value.imageFailure;
  const downloading = disk.value.imagePulling || download.kind === 'starting';
  const totalBytes = (disk.value.imageBytes ?? 0) + disk.value.toolsBytes + disk.value.spacesBytes;
  // Offered only when it would free something, and never while the image downloads: the host refuses then.
  const canFree = disk.value.freeBytes > 0 && !disk.value.imagePulling;
  return (
    <div className="space-y-2">
      {/* The image: not there yet is no fault, the first space downloads it; now is only sooner. */}
      {downloading ? (
        <StatusLine tone="busy">{t('settings.openchamber.spaces.places.image.downloadingNote')}</StatusLine>
      ) : disk.value.imageBytes === null ? (
        <div className="space-y-2">
          <StatusLine tone="todo">{t('settings.openchamber.spaces.places.image.missing')}</StatusLine>
          <Button size="sm" variant="outline" onClick={() => void downloadImage()}>
            <Icon name="download" className="size-3.5" />
            {t('settings.openchamber.spaces.places.image.downloadNow')}
          </Button>
        </div>
      ) : (
        <StatusLine tone="ready">{t('settings.openchamber.spaces.places.image.ready')}</StatusLine>
      )}
      {totalBytes > 0 || cleanUp.kind === 'cleaning' ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <p className="typography-meta text-muted-foreground">{t('settings.openchamber.spaces.places.disk.total', { size: formatDiskSize(totalBytes) })}</p>
          {cleanUp.kind === 'cleaning' ? (
            <span className="inline-flex items-center gap-1.5 typography-meta text-muted-foreground" role="status">
              <Spinner className="size-3.5" />
              {t('settings.openchamber.spaces.places.cleanUp.running')}
            </span>
          ) : canFree ? (
            <Button size="xs" variant="outline" onClick={() => setCleanUp({ kind: 'confirming' })}>
              {t('settings.openchamber.spaces.places.cleanUp.freeUp', { size: formatDiskSize(disk.value.freeBytes) })}
            </Button>
          ) : null}
        </div>
      ) : null}
      {imageFailure ? (
        <p className="typography-meta text-[var(--status-error)]" role="alert">{spaceFailureText(t, imageFailure)}</p>
      ) : null}
      {cleanUp.kind === 'done' ? <CleanUpOutcome outcome={cleanUp.outcome} /> : null}
      {cleanUp.kind === 'failed' ? (
        <p className="typography-meta text-[var(--status-error)]" role="alert">
          {t('settings.openchamber.spaces.places.cleanUp.failed', { reason: spaceFailureText(t, failureOfError(cleanUp.error)) })}
        </p>
      ) : null}
      <CleanUpConfirm
        disk={cleanUp.kind === 'confirming' ? disk.value : null}
        onCancel={() => setCleanUp({ kind: 'idle' })}
        onConfirm={() => void run()}
      />
    </div>
  );
};

// The places the host has, by the name the user knows them by; a place from a later version keeps its id.
const PLACE_NAMES: ReadonlyMap<string, I18nKey> = new Map<string, I18nKey>([['docker', 'settings.openchamber.spaces.places.docker']]);

/** Whether a place runs Docker, whose version the block names. */
const DOCKER_PLACES: ReadonlySet<string> = new Set(['docker', SSH_PLACE_ID]);

/**
 * The block of a place: what runs there, its disk, the spaces left behind; or, for one out of
 * reach, what to do and the spaces this window last saw, never a count of zero. `title` is the
 * block's own, and `field` sits above the rest: the machine's field, for the other machine.
 */
const PlaceBlock: React.FC<{ place: SpacePlace; title: string; field?: React.ReactNode; spaces: SpaceEntry[] | null; spacesError: Error | null; onRetry: () => void }> = ({ place, title, field = null, spaces, spacesError, onRetry }) => {
  const { t } = useI18n();
  const isMobile = useUIStore((state) => state.isMobile);
  const setupShown = Boolean(place.setup?.remedy || place.setup?.job);

  if (!place.available) {
    return (
      <SettingsControlGroup title={title}>
        <div className="space-y-2">
          {field}
          {setupShown ? (
            // This computer: the one action that gets Docker going, or the step to take, with its own "Check again".
            <DockerSetupNotice place={place} onRecheck={onRetry} withCheck />
          ) : (
            // What the user can do about it: one line with the info mark, as Settings' own notes read.
            <p className="flex items-start gap-1.5 typography-meta text-foreground" role="status">
              <Icon name="information" className="mt-[0.2em] h-3.5 w-3.5 shrink-0 text-[var(--status-info)]" />
              <span>{spaceFailureText(t, place, place.machine === null ? undefined : { machine: place.machine })}</span>
            </p>
          )}
          {spaces && spaces.length > 0 ? (
            <div className="space-y-1">
              <p className="typography-meta text-muted-foreground">
                {spaces.length === 1
                  ? t('settings.openchamber.spaces.places.lastSeenSingle')
                  : t('settings.openchamber.spaces.places.lastSeenPlural', { count: spaces.length })}
              </p>
              {spaces.map((entry) => (
                <div key={entry.id} className="flex items-center gap-2 opacity-60">
                  <Icon name="instance" className="h-4 w-4 shrink-0 text-muted-foreground" />
                  {/* A name from the label: text to show. */}
                  <span className="typography-ui-label truncate text-foreground">{entry.name}</span>
                </div>
              ))}
            </div>
          ) : null}
          {setupShown ? null : <Button size="sm" variant="outline" onClick={onRetry}>{t('settings.openchamber.spaces.places.retry')}</Button>}
        </div>
      </SettingsControlGroup>
    );
  }

  const running = spaces?.filter((entry) => entry.state === 'running').length ?? 0;
  const stopped = spaces?.filter((entry) => entry.state === 'exited').length ?? 0;
  const gone = spaces?.filter((entry) => entry.state === 'missing') ?? [];
  // Which engine runs Docker here, when this computer's Docker said so.
  const engine = place.setup?.memory?.engine;
  const dockerText = engine === 'colima'
    ? t('settings.openchamber.spaces.places.dockerRunningColima', { version: place.version })
    : engine === 'docker_desktop'
      ? t('settings.openchamber.spaces.places.dockerRunningDesktop', { version: place.version })
      : t('settings.openchamber.spaces.places.dockerRunning', { version: place.version });
  return (
    <SettingsControlGroup title={title}>
      <div className="space-y-2">
        {field}
        {DOCKER_PLACES.has(place.id) && place.version ? <StatusLine tone="ready">{dockerText}</StatusLine> : null}
        {/* Too little memory for a space, on this computer. */}
        <DockerSetupNotice place={place} onRecheck={onRetry} />
        <PlaceDisk placeId={place.id} />
        {/* The spaces here, once there are any: a count of zero says nothing. */}
        {spaces && running + stopped > 0 ? (
          <p className="typography-meta text-muted-foreground">{t('settings.openchamber.spaces.places.spaceCount', { running, stopped })}</p>
        ) : spacesError ? (
          <p className="typography-meta text-[var(--status-error)]">{t('spaces.page.loadFailed', { reason: spaceFailureText(t, failureOfError(spacesError)) })}</p>
        ) : null}
        {gone.length > 0 ? (
          <div className="space-y-1 pt-1">
            <p className="typography-ui-label text-foreground">{t('settings.openchamber.spaces.places.leftBehind')}</p>
            {gone.map((entry) => <SpaceRow key={entry.id} entry={entry} actions={isMobile ? 'sheet' : 'menu'} showFolder />)}
          </div>
        ) : null}
      </div>
    </SettingsControlGroup>
  );
};

// The machine's field: what this window is doing with it, and the host's refusal when there was one.
type MachineState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'failed'; error: Error };

/**
 * The field of the other machine (journey step 0): an SSH destination, checked and kept by the
 * host when "Check" is pressed, which also brings the place up or, with the field empty, takes it
 * away. The host refuses to take it away or change it while spaces are on the machine, and the
 * refusal shows under the field. `machine` is what the host has now, null for no place.
 */
const MachineField: React.FC<{ machine: string | null; onChange: (place: SpacePlace | null) => void }> = ({ machine, onChange }) => {
  const { t } = useI18n();
  const [draft, setDraft] = React.useState(machine ?? '');
  const [state, setState] = React.useState<MachineState>({ kind: 'idle' });
  // The host's word replaces a draft that was never changed; one the user is typing stays.
  const [edited, setEdited] = React.useState(false);
  React.useEffect(() => {
    if (!edited) setDraft(machine ?? '');
  }, [edited, machine]);

  const save = async (value: string) => {
    setState({ kind: 'saving' });
    reportSettingsSaveState('saving');
    try {
      const place = await setSpaceMachine(value.trim());
      reportSettingsSaveState('saved');
      setState({ kind: 'idle' });
      setEdited(false);
      onChange(place);
    } catch (error) {
      reportSettingsSaveState('error');
      if (!(error instanceof Error)) throw error;
      setState({ kind: 'failed', error });
    }
  };
  const saving = state.kind === 'saving';
  const unchanged = draft.trim() === (machine ?? '');

  return (
    <div className="space-y-1">
      <SettingsFieldRow
        settingsItem="general.isolated-spaces-machine"
        label={t('settings.openchamber.spaces.places.machine.label')}
        info={t('settings.openchamber.spaces.places.machine.info')}
        alignEnd={false}
        // On a narrow pane the buttons go under the field rather than squeezing the name out of it.
        controlClassName="flex-wrap"
      >
        <Input
          value={draft}
          onChange={(event) => { setDraft(event.target.value); setEdited(true); if (state.kind === 'failed') setState({ kind: 'idle' }); }}
          onKeyDown={(event) => { if (event.key === 'Enter' && !saving && !unchanged) { event.preventDefault(); void save(draft); } }}
          placeholder={t('settings.openchamber.spaces.places.machine.placeholder')}
          aria-label={t('settings.openchamber.spaces.places.machine.label')}
          className="h-8 min-w-[14rem] flex-1 max-w-[24rem] font-mono"
          autoComplete="off"
          spellCheck={false}
          disabled={saving}
        />
        <Button size="sm" variant="outline" className="shrink-0" disabled={saving || unchanged} onClick={() => void save(draft)}>
          {saving ? (
            <>
              <Spinner className="size-3.5" />
              {t('settings.openchamber.spaces.places.machine.checking')}
            </>
          ) : t('settings.openchamber.spaces.places.machine.check')}
        </Button>
        {machine !== null ? (
          <Button size="sm" variant="ghost" className="shrink-0 !font-normal" disabled={saving} onClick={() => void save('')}>
            {t('settings.openchamber.spaces.places.machine.remove')}
          </Button>
        ) : null}
      </SettingsFieldRow>
      {state.kind === 'failed' ? (
        <p className="typography-meta text-[var(--status-error)]" role="alert">{spaceFailureText(t, failureOfError(state.error))}</p>
      ) : null}
    </div>
  );
};

export const SpacePlacesSettings: React.FC = () => {
  const { t } = useI18n();
  const isMobile = useUIStore((state) => state.isMobile);
  const [places, retryPlaces, replacePlaces] = useRead(listSpacePlaces);
  const { journey, error: journeyError } = useSpacesJourneyRead();
  const spaces = journey ? Array.from(journey.values()) : null;
  const retry = () => {
    retryPlaces();
    void refreshSpacesJourney().catch(() => undefined);
  };
  // The machine changed: the host answered the place as it is now, or none; the list reads again
  // afterwards, since the spaces are routed by the new host.
  const machineChanged = (place: SpacePlace | null) => {
    if (places.kind !== 'read') return;
    const others = places.value.filter((candidate) => candidate.id !== SSH_PLACE_ID);
    replacePlaces(place ? [...others, place] : others);
    void refreshSpacesJourney().catch(() => undefined);
  };

  if (places.kind === 'reading') return <p className="typography-meta text-muted-foreground">{t('settings.openchamber.spaces.places.reading')}</p>;
  if (places.kind === 'failed') {
    return (
      <div className="space-y-2">
        <p className="typography-meta text-[var(--status-error)]">{t('settings.openchamber.spaces.places.readFailed', { reason: spaceFailureText(t, failureOfError(places.error)) })}</p>
        <Button size="sm" variant="outline" onClick={retry}>{t('settings.openchamber.spaces.places.retry')}</Button>
      </div>
    );
  }
  const sshPlace = places.value.find((place) => place.id === SSH_PLACE_ID) ?? null;
  const field = <MachineField machine={sshPlace?.machine ?? null} onChange={machineChanged} />;
  const leftBehind = sshPlace ? [] : spaces?.filter((entry) => entry.placeId === SSH_PLACE_ID) ?? [];
  const titleOf = (place: SpacePlace) => {
    const nameKey = PLACE_NAMES.get(place.id);
    return place.machine ?? (nameKey ? t(nameKey) : place.id);
  };
  return (
    <div className="space-y-6">
      {places.value.map((place) => (
        <PlaceBlock
          key={place.id}
          place={place}
          title={titleOf(place)}
          field={place.id === SSH_PLACE_ID ? field : undefined}
          // Each block counts its own spaces; an unreachable one is listed by its block as last seen.
          spaces={spaces?.filter((entry) => entry.placeId === place.id) ?? null}
          spacesError={journeyError}
          onRetry={retry}
        />
      ))}
      {sshPlace ? null : (
        <SettingsControlGroup title={t('settings.openchamber.spaces.places.machine.title')}>
          <div className="space-y-2">
            {field}
            {/* Spaces recorded on a machine the file no longer names: unreachable, with the delete that forgets them. */}
            {leftBehind.length > 0 ? (
              <div className="space-y-1 pt-1">
                {leftBehind.map((entry) => <SpaceRow key={entry.id} entry={entry} actions={isMobile ? 'sheet' : 'menu'} showFolder />)}
              </div>
            ) : null}
          </div>
        </SettingsControlGroup>
      )}
    </div>
  );
};
