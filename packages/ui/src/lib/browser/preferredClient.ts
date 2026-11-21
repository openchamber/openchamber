import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { canDriveBrowserPage } from './hostCapability';

const activeAnswerSchema = z.object({ preferredConnectionId: z.string().min(1) });

export type ActiveReport = { connectionId: string; previousConnectionId: string | null };

export const createBrowserInputReporter = (postActive: (report: ActiveReport) => Promise<Response>) => {
  let connectionId: string | null = null;
  let preferredConnectionId: string | null = null;
  let preferredChanges = 0;
  let reportingId: string | null = null;
  let inputPendingFor: string | null = null;
  let inputPendingChanges = 0;
  let handBackPendingFor: string | null = null;
  let routeMissing = false;

  const send = async (reportedId: string, previousConnectionId: string | null): Promise<void> => {
    const changesBefore = preferredChanges;
    try {
      const response = await postActive({ connectionId: reportedId, previousConnectionId });
      if (connectionId !== reportedId) return;
      if (response.status === 404 || response.status === 405) routeMissing = true;
      if (!response.ok) return;
      const answer = activeAnswerSchema.safeParse(await response.json());
      if (answer.success && preferredChanges === changesBefore && connectionId === reportedId) {
        preferredConnectionId = answer.data.preferredConnectionId;
      }
    } catch {
      return;
    }
  };

  const report = async (previousConnectionId: string | null = null): Promise<void> => {
    const reportedId = connectionId;
    if (!reportedId) return;
    if (reportingId === reportedId) {
      inputPendingFor = reportedId;
      inputPendingChanges = preferredChanges;
      return;
    }
    reportingId = reportedId;
    if (inputPendingFor === reportedId) inputPendingFor = null;
    if (previousConnectionId) handBackPendingFor = reportedId;
    await send(reportedId, previousConnectionId);
    if (handBackPendingFor === reportedId) handBackPendingFor = null;
    if (reportingId === reportedId) reportingId = null;
    if (inputPendingFor !== reportedId) return;
    inputPendingFor = null;
    if (inputPendingChanges !== preferredChanges) return;
    if (connectionId === reportedId && !routeMissing && preferredConnectionId !== reportedId) await report();
  };

  return {
    reportInput: async (): Promise<void> => {
      if (connectionId && !routeMissing && preferredConnectionId !== connectionId) await report();
    },
    noteStreamConnection: async (nextConnectionId: string | null): Promise<void> => {
      const previousId = connectionId !== null
        && (preferredConnectionId === connectionId || handBackPendingFor === connectionId) ? connectionId : null;
      connectionId = nextConnectionId;
      routeMissing = false;
      if (previousId) await report(previousId);
    },
    notePreferredConnection: (nextPreferredId: string): void => {
      preferredConnectionId = nextPreferredId;
      preferredChanges += 1;
    },
    isPreferredElsewhere: (requestPreferredId: string | null): boolean => (
      requestPreferredId !== null && requestPreferredId !== connectionId
    ),
    reset: (): void => {
      connectionId = null;
      preferredConnectionId = null;
      handBackPendingFor = null;
      routeMissing = false;
    },
  };
};

const reporter = createBrowserInputReporter((report) => runtimeFetch('/api/browser-control/active', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(report),
}));
let listening = false;

const onInput = (): void => {
  void reporter.reportInput();
};

export const noteBrowserStreamConnection = (nextConnectionId: string | null): void => {
  void reporter.noteStreamConnection(nextConnectionId);
};

export const noteBrowserPreferredConnection = reporter.notePreferredConnection;

export const isPreferredElsewhere = reporter.isPreferredElsewhere;

export const startReportingBrowserInput = (): void => {
  if (listening || !canDriveBrowserPage()) return;
  listening = true;
  window.addEventListener('pointerdown', onInput, { capture: true, passive: true });
  window.addEventListener('keydown', onInput, { capture: true, passive: true });
};

export const stopReportingBrowserInput = (): void => {
  if (!listening) return;
  listening = false;
  window.removeEventListener('pointerdown', onInput, { capture: true });
  window.removeEventListener('keydown', onInput, { capture: true });
  reporter.reset();
};
