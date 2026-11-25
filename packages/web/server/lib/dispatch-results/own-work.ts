import type { SessionActivityProbe } from '../opencode/session-activity.js';

export interface OwnWorkSources {
  extensionWaits: { load: () => Promise<void>; snapshot: () => { waits: { sessionID: string; source: string }[] } };
  prWatch: { listWaits: (sessionID: string) => Promise<{ title: string }[]> };
  workflows: { list: (scope: { sessionId: string }) => Promise<{ name: string; state: string }[]> };
  waitsOnAnswer: (sessionID: string) => boolean;
}

export interface OwnWork {
  running: string[];
  waitsOnAnswer: boolean;
}

interface OwnWorkOptions {
  jobs: Pick<SessionActivityProbe, 'fetchRunningBackgroundJobs'>;
  sources: (() => OwnWorkSources) | undefined;
  dispatched: (sessionId: string, active: ReadonlySet<string>) => string[];
}

const COMMAND_SHOWN = 120;

export const createOwnWork = ({ jobs, sources, dispatched }: OwnWorkOptions) => {
  const readSources = async (sessionId: string, related: readonly string[]): Promise<OwnWork> => {
    if (!sources) return { running: [], waitsOnAnswer: false };
    const { extensionWaits, prWatch, workflows, waitsOnAnswer } = sources();
    const [pulls, runs] = await Promise.all([prWatch.listWaits(sessionId), workflows.list({ sessionId }), extensionWaits.load()]);
    return {
      running: [
        ...extensionWaits.snapshot().waits.filter((wait) => wait.sessionID === sessionId).map(({ source }) => `wait: ${source}`),
        ...pulls.map(({ title }) => `wait: ${title}`),
        ...runs.filter(({ state }) => state === 'running').map(({ name }) => `workflow: ${name}`),
      ],
      waitsOnAnswer: related.some(waitsOnAnswer) || runs.some(({ state }) => state === 'awaiting-approval'),
    };
  };

  const read = async (sessionId: string, active: ReadonlySet<string>): Promise<OwnWork | null> => {
    const background = await jobs.fetchRunningBackgroundJobs(sessionId);
    if (!background) return null;
    const children = dispatched(sessionId, active);
    const related = [sessionId, ...children, ...background.flatMap((job) => [job.sessionID, job.childSessionID ?? job.sessionID])];
    const others = await readSources(sessionId, related).catch(() => null);
    if (!others) return null;
    const jobLines = background.map(({ kind, command }) => (command ? `${kind}: ${command.replace(/\s+/g, ' ').slice(0, COMMAND_SHOWN)}` : kind));
    return { running: [...jobLines, ...others.running, ...children.map((id) => `session: ${id}`)], waitsOnAnswer: others.waitsOnAnswer };
  };

  return { read };
};
