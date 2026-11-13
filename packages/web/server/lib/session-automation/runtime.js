// One server's autonomous writers reserve their sessions and PRs before work
// starts. Short send leases also cover awaits between preparation and admission.
export const sessionKey = (sessionID) => `session:${sessionID}`;
export const pullRequestKey = ({ provider, instance, owner, repo, number }) => (
  `pull:${provider.toLowerCase()}|${(instance || 'github.com').toLowerCase()}|${owner.toLowerCase()}/${repo.toLowerCase()}#${number}`
);
export const reviewOwner = (sessionID) => `review:${sessionID}`;
export const fixLoopOwner = (id) => `fixloop:${id}`;

const conflict = () => Object.assign(new Error('This session or pull request is owned by another automation or an in-flight send.'), { status: 409, statusCode: 409 });

export function createAutomationAdmission({ restore = async () => [], onRelease = () => {} } = {}) {
  const owners = new Map();
  const sends = new Map();
  let loading;
  let restored = false;

  const ready = () => {
    loading ??= (async () => {
      for (const { owner, keys } of await restore()) owners.set(owner, new Set(keys));
      restored = true;
    })();
    return loading;
  };
  const conflicts = (owner, keys) => [...owners].some(([other, held]) => other !== owner && keys.some((key) => held.has(key)));
  const owns = (owner) => restored && owners.has(owner) && !conflicts(owner, [...owners.get(owner)]);
  const claim = (owner, keys) => {
    if (!restored || conflicts(owner, keys) || keys.some((key) => sends.has(key))) throw conflict();
    owners.set(owner, new Set(keys));
  };
  const release = (owner) => {
    const keys = owners.get(owner);
    owners.delete(owner);
    if (keys) onRelease([...keys]);
  };
  const trySend = (owner, keys) => {
    if (!restored || (owner !== null && !owns(owner)) || conflicts(owner, keys) || keys.some((key) => sends.has(key))) return null;
    const token = Symbol();
    for (const key of keys) sends.set(key, token);
    return () => {
      for (const key of keys) if (sends.get(key) === token) sends.delete(key);
      onRelease(keys);
    };
  };
  return { ready, claim, release, owns, trySend };
}
