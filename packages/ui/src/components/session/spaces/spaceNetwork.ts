// The network of a running space as its dialogs use it: the gatekeeper's journal, and allowing a
// domain from it. The access dialog and the setup output window both list refused domains with Allow.

import React from 'react';

import { useI18n } from '@/lib/i18n';
import { openSpaceDomain, readSpaceJournal, type SpaceFailure, type SpaceJournal } from '@/lib/spaces/spaces-api';
import { refreshSpacesJourney } from '@/lib/spaces/spaces-store';
import { failureOfError, spaceFailureText } from './spaceFailureText';

type JournalState = { kind: 'loading' } | { kind: 'ready'; journal: SpaceJournal } | { kind: 'failed'; failure: SpaceFailure };

/** The gatekeeper's journal, read while `enabled` and again on `refresh`; never polled. */
export const useSpaceJournal = (spaceId: string, enabled: boolean) => {
  const [state, setState] = React.useState<JournalState>({ kind: 'loading' });
  const [generation, setGeneration] = React.useState(0);
  React.useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setState({ kind: 'loading' });
    readSpaceJournal(spaceId, controller.signal).then(
      (journal) => setState({ kind: 'ready', journal }),
      (error: Error) => { if (!controller.signal.aborted) setState({ kind: 'failed', failure: failureOfError(error) }); },
    );
    return () => controller.abort();
  }, [enabled, generation, spaceId]);
  return { state, refresh: () => setGeneration((value) => value + 1) };
};

/** Allows a domain in a running space, one at a time, and keeps the failure by the domain it was for. */
export const useOpenSpaceDomain = (spaceId: string) => {
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
