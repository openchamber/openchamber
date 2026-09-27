// The model providers a space made in this window was given, so the first message of its draft is
// checked on "Send", before it leaves the composer: a message on a provider the space was not given
// stays in the input with the reason instead of failing inside the space. Known from the moment
// the space is asked for, by the draft's waiting request and by the space's project directory.
// Memory of this window only; a space it did not make is not checked here.

type Access = { providers: ReadonlySet<string>; refuse: (providerId: string) => string };

const byDirectory = new Map<string, Access>();
const directoryByRequest = new Map<string, string>();

export const noteSpaceModelAccess = (target: { requestId: string; directory: string }, providers: readonly string[], refuse: (providerId: string) => string): void => {
  byDirectory.set(target.directory, { providers: new Set(providers), refuse });
  directoryByRequest.set(target.requestId, target.directory);
};

/**
 * The reason a draft's message on this provider must not be sent, or null when it may: the draft
 * names its target by the request it still waits on, or by its directory once the space is there.
 */
export const spaceModelRefusal = (draft: { requestId: string | null; directory: string | null }, providerId: string): string | null => {
  const directory = (draft.requestId ? directoryByRequest.get(draft.requestId) : undefined) ?? draft.directory;
  const access = directory ? byDirectory.get(directory) : undefined;
  if (!access || access.providers.has(providerId)) return null;
  return access.refuse(providerId);
};
