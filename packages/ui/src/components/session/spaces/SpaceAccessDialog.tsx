/**
 * The grant dialog of an isolated space (DESIGN.md, user journey step 4): model keys per provider,
 * the domains the space may reach, and the attempts its gatekeeper refused, each opened from here.
 * Every grant goes through the host at once; nothing is saved at the end. A grant cannot be taken
 * back (decision 4), so opened domains show without a remove button.
 *
 * The journal lives in the gatekeeper's memory only: it holds nothing from before the last start,
 * and the dialog says so, so that an empty list never reads as "the agent tried nothing" when the
 * record is simply gone. It is read when the dialog opens and on "Refresh", never polled.
 *
 * Mounted once by the main layout, opened from the space's group and the session header; never in
 * VS Code (decision 16).
 */

import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { getCurrentIntlLocale } from '@/lib/i18n/intl';
import { blockedAttemptsOf, isDomainName, providerAccessOf, type BlockReason } from '@/lib/spaces/space-access';
import { grantSpaceAccess, openSpaceDomain, readSpaceJournal, type SpaceEntry, type SpaceFailure, type SpaceJournal } from '@/lib/spaces/spaces-api';
import { refreshSpacesJourney, useSpacesStore } from '@/lib/spaces/spaces-store';
import { useUIStore } from '@/stores/useUIStore';
import { ModelKeySource } from './ModelKeySource';
import { isKeySourceComplete, modelGrantOf, useSpaceModelProviders, type KeySourceChoice } from './spaceModelKeys';
import { failureOfError, spaceFailureText } from './spaceFailureText';

const REASON_TEXT = {
  not_on_list: 'spaces.access.reason.notOnList',
  private_address: 'spaces.access.reason.privateAddress',
  unresolved: 'spaces.access.reason.unresolved',
  address_not_name: 'spaces.access.reason.addressNotName',
  port: 'spaces.access.reason.port',
  always_refused: 'spaces.access.reason.alwaysRefused',
  too_many: 'spaces.access.reason.tooMany',
  other: 'spaces.access.reason.other',
} satisfies Record<BlockReason, I18nKey>;

type JournalState = { kind: 'loading' } | { kind: 'ready'; journal: SpaceJournal } | { kind: 'failed'; failure: SpaceFailure };

/** A time of the journal in the user's language: the hour when it is today, the date as well when it is not. */
const formatJournalTime = (value: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const today = new Date().toDateString() === date.toDateString();
  return new Intl.DateTimeFormat(getCurrentIntlLocale(), today ? { timeStyle: 'short' } : { dateStyle: 'medium', timeStyle: 'short' }).format(date);
};

const Section: React.FC<{ title: string; action?: React.ReactNode; children: React.ReactNode }> = ({ title, action, children }) => (
  <section className="space-y-2">
    <div className="flex items-center justify-between gap-2">
      <h3 className="typography-ui-label font-semibold text-foreground">{title}</h3>
      {action}
    </div>
    {children}
  </section>
);

const useJournal = (spaceId: string, running: boolean) => {
  const [state, setState] = React.useState<JournalState>({ kind: 'loading' });
  const [generation, setGeneration] = React.useState(0);
  React.useEffect(() => {
    if (!running) return;
    const controller = new AbortController();
    setState({ kind: 'loading' });
    readSpaceJournal(spaceId, controller.signal).then(
      (journal) => setState({ kind: 'ready', journal }),
      (error: Error) => { if (!controller.signal.aborted) setState({ kind: 'failed', failure: failureOfError(error) }); },
    );
    return () => controller.abort();
  }, [generation, running, spaceId]);
  return { state, refresh: () => setGeneration((value) => value + 1) };
};

const ModelRow: React.FC<{ entry: SpaceEntry; provider: ReturnType<typeof useSpaceModelProviders>[number]; initiallyOpen: boolean }> = ({ entry, provider, initiallyOpen }) => {
  const { t } = useI18n();
  const access = providerAccessOf(entry, provider.id);
  const grant = entry.grants.find((candidate) => candidate.kind === 'model' && candidate.provider === provider.id);
  const [open, setOpen] = React.useState(initiallyOpen);
  const [choice, setChoice] = React.useState<KeySourceChoice>(() => ({
    source: grant?.kind === 'model' && grant.source.kind === 'typed' ? 'typed' : 'env',
    envName: grant?.kind === 'model' && grant.source.kind === 'env' ? grant.source.name : provider.envName,
    value: '',
  }));
  const [giving, setGiving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const give = async () => {
    setGiving(true);
    setError(null);
    try {
      const grant = await grantSpaceAccess(entry.id, modelGrantOf(provider, choice));
      useSpacesStore.getState().noteGrantGiven(entry.id, grant);
      useSpacesStore.getState().noteProviderGranted(entry.id, provider.id);
      await refreshSpacesJourney().catch(() => undefined);
      setOpen(false);
      setChoice((current) => ({ ...current, value: '' }));
    } catch (failure) {
      if (!(failure instanceof Error)) throw failure;
      setError(spaceFailureText(t, failureOfError(failure)));
    } finally {
      setGiving(false);
    }
  };

  const state = access === 'granted'
    ? (grant?.kind === 'model' && grant.source.kind === 'env'
      ? <span className="text-muted-foreground">{t('spaces.access.model.grantedFromEnv', { name: grant.source.name })}</span>
      : <span className="text-muted-foreground">{t('spaces.access.model.granted')}</span>)
    : access === 'needs_again'
      ? <span className="text-status-warning">{t('spaces.access.model.needsAgain')}</span>
      : <span className="text-muted-foreground">{t('spaces.access.model.none')}</span>;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="typography-ui-label text-foreground">{provider.name}</div>
          <div className="typography-meta break-words">{state}</div>
        </div>
        {!open ? (
          <Button variant="outline" size="xs" className="shrink-0" onClick={() => setOpen(true)} disabled={entry.state !== 'running'}>
            {access === 'granted' ? t('spaces.access.model.change') : t('spaces.access.model.give')}
          </Button>
        ) : null}
      </div>
      {open ? (
        <div className="space-y-2 pl-3">
          <ModelKeySource providerName={provider.name} choice={choice} onChange={(change) => setChoice((current) => ({ ...current, ...change }))} />
          {error ? <p className="typography-meta text-status-error">{error}</p> : null}
          <div className="flex gap-2">
            <Button size="xs" onClick={() => void give()} disabled={giving || !isKeySourceComplete(choice)} className="gap-1.5">
              {giving ? <Icon name="loader-4" className="h-3 w-3 animate-spin" /> : null}
              {t('spaces.access.model.submit')}
            </Button>
            <Button variant="ghost" size="xs" onClick={() => { setOpen(false); setError(null); }} disabled={giving}>{t('spaces.create.cancel')}</Button>
          </div>
        </div>
      ) : null}
    </div>
  );
};

const useOpenDomain = (spaceId: string) => {
  const { t } = useI18n();
  const [opening, setOpening] = React.useState<string | null>(null);
  const [error, setError] = React.useState<{ domain: string; text: string } | null>(null);
  const open = async (domain: string): Promise<boolean> => {
    setOpening(domain);
    setError(null);
    try {
      await openSpaceDomain(spaceId, domain);
      await refreshSpacesJourney().catch(() => undefined);
      return true;
    } catch (failure) {
      if (!(failure instanceof Error)) throw failure;
      setError({ domain, text: spaceFailureText(t, failureOfError(failure)) });
      return false;
    } finally {
      setOpening(null);
    }
  };
  return { open, opening, error };
};

const NetworkSection: React.FC<{ entry: SpaceEntry; domains: ReturnType<typeof useOpenDomain> }> = ({ entry, domains }) => {
  const { t } = useI18n();
  const [input, setInput] = React.useState('');
  const [invalid, setInvalid] = React.useState(false);
  const submit = async () => {
    const domain = input.trim().toLowerCase();
    if (!isDomainName(domain)) {
      setInvalid(true);
      return;
    }
    if (await domains.open(domain)) setInput('');
  };

  if (entry.network === null) return <p className="typography-meta text-muted-foreground">{t('spaces.access.network.unknown')}</p>;
  if (entry.network.mode === 'open') return <p className="typography-meta text-muted-foreground">{t('spaces.access.network.openMode')}</p>;
  return (
    <div className="space-y-1.5">
      {entry.network.domains.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {entry.network.domains.map((domain) => (
            <span key={domain} className="inline-flex items-center rounded-md bg-[var(--surface-muted)] px-1.5 py-0.5 font-mono typography-meta text-foreground break-all">{domain}</span>
          ))}
        </div>
      ) : <p className="typography-meta text-muted-foreground">{t('spaces.access.network.none')}</p>}
      <div className="flex max-w-sm items-center gap-2">
        <Input
          value={input}
          onChange={(event) => { setInput(event.target.value); setInvalid(false); }}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void submit(); } }}
          placeholder={t('spaces.create.network.domainPlaceholder')}
          aria-label={t('spaces.create.network.domainPlaceholder')}
          className="h-9 flex-1"
          disabled={entry.state !== 'running'}
        />
        <Button variant="outline" size="sm" onClick={() => void submit()} disabled={entry.state !== 'running' || input.trim() === '' || domains.opening !== null}>
          {t('spaces.access.openDomain')}
        </Button>
      </div>
      {invalid ? <p className="typography-meta text-status-error">{t('spaces.create.network.domainInvalid')}</p> : null}
      {domains.error && domains.error.domain === input.trim().toLowerCase() ? <p className="typography-meta text-status-error">{domains.error.text}</p> : null}
    </div>
  );
};

const BlockedSection: React.FC<{ entry: SpaceEntry; journal: ReturnType<typeof useJournal>; domains: ReturnType<typeof useOpenDomain> }> = ({ entry, journal, domains }) => {
  const { t } = useI18n();
  if (entry.state !== 'running') return <p className="typography-meta text-muted-foreground">{t('spaces.access.blocked.stopped')}</p>;
  if (journal.state.kind === 'loading') return <p className="typography-meta text-muted-foreground">{t('spaces.access.blocked.loading')}</p>;
  if (journal.state.kind === 'failed') return <p className="typography-meta text-status-error">{spaceFailureText(t, journal.state.failure)}</p>;

  const { records, dropped, since } = journal.state.journal;
  const attempts = blockedAttemptsOf(records);
  const allowlist = entry.network?.mode === 'allowlist' ? entry.network.domains : null;
  const start = formatJournalTime(since);
  return (
    <div className="space-y-2">
      <p className="typography-meta text-muted-foreground">
        {attempts.length === 0 && dropped === 0 ? t('spaces.access.blocked.empty', { time: start }) : t('spaces.access.blocked.since', { time: start })}
        {dropped === 1 ? ` ${t('spaces.access.blocked.droppedSingle')}` : dropped > 1 ? ` ${t('spaces.access.blocked.droppedPlural', { count: dropped })}` : null}
      </p>
      {attempts.length > 0 ? (
        <ul className="space-y-2">
          {attempts.map((attempt) => {
            const opened = allowlist?.includes(attempt.host) ?? false;
            const canOpen = attempt.reason === 'not_on_list' && allowlist !== null && isDomainName(attempt.host);
            const last = formatJournalTime(attempt.last);
            return (
              <li key={`${attempt.reason}:${attempt.host}:${attempt.port}`} className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="font-mono typography-meta text-foreground break-all">{attempt.reason === 'port' ? `${attempt.host}:${attempt.port}` : attempt.host}</div>
                  <div className="typography-micro text-muted-foreground">
                    {t(REASON_TEXT[attempt.reason], { port: attempt.port })}
                    {' · '}
                    {attempt.count === 1 ? t('spaces.access.blocked.countSingle', { time: last }) : t('spaces.access.blocked.countPlural', { count: attempt.count, time: last })}
                  </div>
                  {domains.error?.domain === attempt.host ? <div className="typography-micro text-status-error">{domains.error.text}</div> : null}
                </div>
                {canOpen ? (
                  opened
                    ? <span className="shrink-0 typography-micro text-muted-foreground">{t('spaces.access.blocked.opened')}</span>
                    : (
                      <Button variant="outline" size="xs" className="shrink-0 gap-1" disabled={domains.opening !== null} onClick={() => void domains.open(attempt.host)}>
                        {domains.opening === attempt.host ? <Icon name="loader-4" className="h-3 w-3 animate-spin" /> : null}
                        {t('spaces.access.openDomain')}
                      </Button>
                    )
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
};

const SpaceAccessBody: React.FC<{ entry: SpaceEntry; focusProviderId: string | null }> = ({ entry, focusProviderId }) => {
  const { t } = useI18n();
  const providers = useSpaceModelProviders(entry.projectDirectory);
  const running = entry.state === 'running';
  const journal = useJournal(entry.id, running);
  const domains = useOpenDomain(entry.id);
  return (
    <div className="space-y-5 pr-3">
      <p className="typography-meta text-muted-foreground">{t('spaces.access.intro')}</p>
      {!running ? <p className="typography-meta text-status-warning">{t('spaces.access.notRunning')}</p> : null}
      <Section title={t('spaces.access.models.label')}>
        {providers.length === 0 ? <p className="typography-meta text-muted-foreground">{t('spaces.create.access.noneAvailable')}</p> : (
          <div className="space-y-3">
            {providers.map((provider) => (
              <ModelRow key={provider.id} entry={entry} provider={provider} initiallyOpen={running && provider.id === focusProviderId} />
            ))}
          </div>
        )}
      </Section>
      <Section title={t('spaces.access.network.label')}>
        <NetworkSection entry={entry} domains={domains} />
      </Section>
      <Section
        title={t('spaces.access.blocked.label')}
        action={running ? (
          <Button variant="ghost" size="xs" className="gap-1" onClick={journal.refresh} disabled={journal.state.kind === 'loading'}>
            <Icon name="refresh" className="h-3 w-3" />
            {t('spaces.access.blocked.refresh')}
          </Button>
        ) : null}
      >
        <BlockedSection entry={entry} journal={journal} domains={domains} />
      </Section>
    </div>
  );
};

export const SpaceAccessDialog: React.FC = () => {
  const { t } = useI18n();
  const isMobile = useUIStore((state) => state.isMobile);
  const target = useSpacesStore((state) => state.accessDialog);
  const entry = useSpacesStore((state) => (target ? state.journey?.get(target.spaceId) : undefined));
  const close = () => useSpacesStore.getState().closeAccessDialog();
  const open = target !== null;
  const [readError, setReadError] = React.useState<string | null>(null);

  // A space the list has not answered for yet, in a window that has not read it: read it now.
  const missing = target !== null && entry === undefined;
  React.useEffect(() => {
    if (!missing) return;
    setReadError(null);
    const spaceId = target?.spaceId;
    refreshSpacesJourney().then(
      () => { if (spaceId && !useSpacesStore.getState().journey?.get(spaceId)) setReadError(t('spaces.access.gone')); },
      (error: Error) => setReadError(spaceFailureText(t, failureOfError(error))),
    );
  }, [missing, t, target?.spaceId]);

  const title = entry ? t('spaces.access.title', { name: entry.name }) : t('spaces.group.access.give');
  // Keyed by the space and the provider asked for, so opening it again for a missing key opens that
  // provider's row, and another space starts from nothing typed.
  const body = !target ? null : entry
    ? <SpaceAccessBody key={`${target.spaceId}:${target.providerId ?? ''}`} entry={entry} focusProviderId={target.providerId} />
    : <p className={readError ? 'typography-meta text-status-error' : 'typography-meta text-muted-foreground'}>{readError ?? t('spaces.access.loading')}</p>;
  const footer = (
    <div className="flex w-full justify-end">
      <Button variant="outline" size="sm" onClick={close}>{t('spaces.access.close')}</Button>
    </div>
  );

  if (isMobile) {
    return (
      <MobileOverlayPanel open={open} title={title} onClose={close} footer={footer}>
        <div className="px-3 pb-4 pt-1">{body}</div>
      </MobileOverlayPanel>
    );
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) close(); }}>
      <DialogContent className="flex max-h-[80vh] max-w-lg flex-col">
        <DialogHeader>
          <DialogTitle className="flex min-w-0 items-center gap-2">
            <Icon name="key" className="h-5 w-5 shrink-0" />
            <span className="min-w-0 truncate">{title}</span>
          </DialogTitle>
        </DialogHeader>
        <ScrollableOverlay outerClassName="mt-2 flex-1" disableHorizontal>{body}</ScrollableOverlay>
        <DialogFooter className="mt-1">{footer}</DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
