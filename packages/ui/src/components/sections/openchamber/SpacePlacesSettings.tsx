/**
 * The places of isolated spaces in Settings (DESIGN.md, user journey step 9, and decision 12): each
 * place with how many spaces run and stand stopped there, the disk its image, tools and spaces take,
 * the spaces whose container is gone, and "Clean up…", which removes what OpenChamber can make again.
 * The server decides what goes, see `places/docker-disk.js`; this screen only shows and asks.
 *
 * A place that cannot be reached says so and what to do, never a count of zero: the spaces this
 * window last saw are listed as out of reach, and nothing is when it saw none. Nothing polls; "Try
 * again" reads the place again. Rendered only while the switch is on (decision 19).
 */

import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { SpaceRow } from '@/components/session/spaces/SpaceRow';
import { failureOfError, spaceFailureText } from '@/components/session/spaces/spaceFailureText';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { getCurrentIntlLocale, useI18n, type I18nKey } from '@/lib/i18n';
import {
  cleanUpSpaceDisk,
  listSpacePlaces,
  readSpaceDisk,
  type SpaceCleanUp,
  type SpaceDisk,
  type SpaceEntry,
  type SpacePlace,
} from '@/lib/spaces/spaces-api';
import { refreshSpacesJourney, useSpacesJourneyRead } from '@/lib/spaces/spaces-store';
import { useUIStore } from '@/stores/useUIStore';
import { SettingsControlGroup } from '../shared/SettingsSection';

// Decimal units, as Docker and the Mac's own disk tools count; only the number is localised.
const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

const formatDiskSize = (bytes: number): string => {
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < SIZE_UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const number = new Intl.NumberFormat(getCurrentIntlLocale(), { maximumFractionDigits: unit === 0 ? 0 : 1 }).format(value);
  return `${number} ${SIZE_UNITS[unit]}`;
};

type Read<T> = { kind: 'reading' } | { kind: 'read'; value: T } | { kind: 'failed'; error: Error };

/** Reads once when mounted and again on `retry`; a failure is kept apart, never read as empty. */
const useRead = <T,>(load: (signal: AbortSignal) => Promise<T>): [Read<T>, () => void, (value: T) => void] => {
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
  return [state, retry, replace];
};

const DiskLine: React.FC<{ disk: SpaceDisk }> = ({ disk }) => {
  const { t } = useI18n();
  const parts = [
    ...(disk.imageBytes === null ? [] : [t('settings.openchamber.spaces.places.disk.image', { size: formatDiskSize(disk.imageBytes) })]),
    t('settings.openchamber.spaces.places.disk.tools', { size: formatDiskSize(disk.toolsBytes) }),
    t('settings.openchamber.spaces.places.disk.spaces', { size: formatDiskSize(disk.spacesBytes) }),
  ];
  return <p className="typography-meta text-muted-foreground">{t('settings.openchamber.spaces.places.disk.line', { parts: parts.join(' · ') })}</p>;
};

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

/** The disk of a place that answers, and its clean-up. */
const PlaceDisk: React.FC<{ placeId: string }> = ({ placeId }) => {
  const { t } = useI18n();
  const load = React.useCallback((signal: AbortSignal) => readSpaceDisk(placeId, signal), [placeId]);
  const [disk, , replaceDisk] = useRead(load);
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

  if (disk.kind === 'reading') return <p className="typography-meta text-muted-foreground">{t('settings.openchamber.spaces.places.disk.reading')}</p>;
  if (disk.kind === 'failed') {
    return <p className="typography-meta text-[var(--status-error)]">{t('settings.openchamber.spaces.places.disk.readFailed', { reason: spaceFailureText(t, failureOfError(disk.error)) })}</p>;
  }
  const nothingToFree = disk.value.freeBytes === 0;
  return (
    <div className="space-y-2">
      <DiskLine disk={disk.value} />
      <Button
        size="sm"
        variant="outline"
        disabled={nothingToFree || cleanUp.kind === 'cleaning'}
        title={nothingToFree ? t('settings.openchamber.spaces.places.cleanUp.nothing') : undefined}
        onClick={() => setCleanUp({ kind: 'confirming' })}
      >
        {cleanUp.kind === 'cleaning' ? t('settings.openchamber.spaces.places.cleanUp.running') : t('settings.openchamber.spaces.places.cleanUp.button')}
      </Button>
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

const PlaceBlock: React.FC<{ place: SpacePlace; spaces: SpaceEntry[] | null; spacesError: Error | null; onRetry: () => void }> = ({ place, spaces, spacesError, onRetry }) => {
  const { t } = useI18n();
  const isMobile = useUIStore((state) => state.isMobile);
  const nameKey = PLACE_NAMES.get(place.id);
  const name = nameKey ? t(nameKey) : place.id;

  if (!place.available) {
    // Out of reach: what to do, and the spaces this window last saw, never a count of zero.
    return (
      <SettingsControlGroup title={name}>
        <div className="space-y-2">
          {/* What the user can do about it: one line with the info mark, as Settings' own notes read. */}
          <p className="flex items-start gap-1.5 typography-meta text-foreground" role="status">
            <Icon name="information" className="mt-[0.2em] h-3.5 w-3.5 shrink-0 text-[var(--status-info)]" />
            <span>{spaceFailureText(t, place)}</span>
          </p>
          {spaces && spaces.length > 0 ? (
            <div className="space-y-1">
              <p className="typography-meta text-muted-foreground">
                {spaces.length === 1
                  ? t('settings.openchamber.spaces.places.lastSeenSingle')
                  : t('settings.openchamber.spaces.places.lastSeenPlural', { count: spaces.length })}
              </p>
              {spaces.map((entry) => (
                <div key={entry.id} className="flex items-center gap-2 opacity-60">
                  <Icon name="box-3" className="h-4 w-4 shrink-0 text-muted-foreground" />
                  {/* A name from the label: text to show. */}
                  <span className="typography-ui-label truncate text-foreground">{entry.name}</span>
                </div>
              ))}
            </div>
          ) : null}
          <Button size="sm" variant="outline" onClick={onRetry}>{t('settings.openchamber.spaces.places.retry')}</Button>
        </div>
      </SettingsControlGroup>
    );
  }

  const running = spaces?.filter((entry) => entry.state === 'running').length ?? 0;
  const stopped = spaces?.filter((entry) => entry.state === 'exited').length ?? 0;
  const gone = spaces?.filter((entry) => entry.state === 'missing') ?? [];
  return (
    <SettingsControlGroup title={name}>
      <div className="space-y-2">
        {/* A product name and its version, the same in every language. */}
        {place.id === 'docker' && place.version ? <p className="typography-meta text-muted-foreground">{`Docker ${place.version}`}</p> : null}
        {spaces ? (
          <p className="typography-meta text-muted-foreground">{t('settings.openchamber.spaces.places.counts', { running, stopped })}</p>
        ) : spacesError ? (
          <p className="typography-meta text-[var(--status-error)]">{t('spaces.page.loadFailed', { reason: spaceFailureText(t, failureOfError(spacesError)) })}</p>
        ) : null}
        <PlaceDisk placeId={place.id} />
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

export const SpacePlacesSettings: React.FC = () => {
  const { t } = useI18n();
  const [places, retryPlaces] = useRead(listSpacePlaces);
  const { journey, error: journeyError } = useSpacesJourneyRead();
  const spaces = journey ? Array.from(journey.values()) : null;
  const retry = () => {
    retryPlaces();
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
  return (
    <div className="space-y-6">
      {places.value.map((place) => <PlaceBlock key={place.id} place={place} spaces={spaces} spacesError={journeyError} onRetry={retry} />)}
    </div>
  );
};
