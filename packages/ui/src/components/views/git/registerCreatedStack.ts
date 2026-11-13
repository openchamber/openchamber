import type { SourceControlAPI, SourceControlReadContext } from '@/lib/api/types';

type CreatedStack = {
  readonly context: SourceControlReadContext;
  readonly project: { readonly owner: string; readonly name: string };
  readonly number: number;
  readonly head: string;
  readonly base: string;
  readonly createKey: string;
  readonly stacked: boolean | undefined;
  readonly isCurrent: () => boolean;
};

export class CreatedStackUnavailableError extends Error {
  constructor() { super('Created stack target changed'); }
}

/** A successful create remains valid if registration fails; only its freshly read head authorizes registration. */
export async function registerCreatedStack(sourceControl: Pick<SourceControlAPI, 'changeRequestStatus' | 'githubPullStackRegister'>, created: CreatedStack) {
  if (created.stacked !== undefined || !created.isCurrent()) return null;
  const status = await sourceControl.changeRequestStatus(created.context, created.head, { force: true });
  if (!created.isCurrent()) return null;
  const pull = status.changeRequest;
  if (!pull?.headSha || pull.number !== created.number || pull.head !== created.head || pull.base !== created.base
    || status.project?.owner !== created.project.owner || status.project.name !== created.project.name) {
    throw new CreatedStackUnavailableError();
  }
  return sourceControl.githubPullStackRegister({ ...created.context,
    idempotencyKey: `${created.createKey}:stack-register`,
    target: { project: created.project, number: pull.number, head: pull.head, base: pull.base, headSha: pull.headSha },
  }, { owner: created.project.owner, repo: created.project.name, number: pull.number });
}
